// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-directories.ts
//
// Directory enumeration behind GET /admin/filesystem/directories — the
// "Browse" affordance in the Add-library dialog.
//
// WHY THE SERVER HAS TO DO THIS AT ALL. A library path names a directory on
// the SERVER's filesystem. The browser cannot see that filesystem, and the
// web client is not necessarily even on the same machine — the Docker
// distribution runs it in a separate container. An OS file dialog is
// therefore structurally incapable of picking these paths, however much it
// looks like the obvious answer. The server enumerates; the client walks.
//
// WHAT IT DELIBERATELY DOES NOT DO: no file listing, no file contents, no
// sizes. Only directory names and the paths built from them. Everything it
// exposes is already implied by the paths an admin is in the middle of
// configuring. The controller enforces admin-only on top of that, because
// enumerating a server's directory tree is reconnaissance in the wrong
// hands.
//
// Pure + platform-injectable so the Windows behaviour (drive-letter roots,
// backslash separators) is testable from a POSIX dev host and CI, which is
// where every platform-specific installer bug this project has hit would
// otherwise have hidden.

import { accessSync, constants, readdirSync, statSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

export interface DirectoryEntryDto {
  name: string;
  path: string;
  /** False = the server itself cannot descend into it (a follow-up listing
   *  would 403) — the normal state of personal home folders under the
   *  macOS/Linux installers' least-privilege service accounts. Marked, not
   *  omitted: hiding the folder would misrepresent the filesystem. */
  readable: boolean;
}

export interface DirectoryListingDto {
  path: string | null;
  parent: string | null;
  entries: DirectoryEntryDto[];
}

export type BrowseFailure =
  | { kind: "not-absolute" }
  | { kind: "not-found" }
  | { kind: "not-a-directory" }
  | { kind: "permission-denied" };

export class DirectoryBrowseError extends Error {
  constructor(readonly failure: BrowseFailure) {
    super(`directory browse failed: ${failure.kind}`);
    this.name = "DirectoryBrowseError";
  }
}

/** Platform-appropriate path helpers, injectable for cross-platform tests. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Can this process list the directory's contents? R_OK reads the names,
 *  X_OK descends — a listing needs both. accessSync follows symlinks,
 *  which matches how the follow-up listing would actually behave. */
function canReadDirectory(p: string): boolean {
  try {
    accessSync(p, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The account this server actually runs as — "" if the OS cannot say
 *  (userInfo throws on passwd-less containers), which safely falls
 *  through to the generic message. */
function currentServiceUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * The 403 detail for a permission-denied browse, tailored to the service
 * account the server is ACTUALLY running as — detected, not assumed, so a
 * dev server running as a normal user never claims to be an installer.
 * The macOS field report behind this: the picker said just "Forbidden"
 * while the real situation ("the _loombre daemon cannot read your home
 * folder, and here is what to do instead") was fully known server-side.
 */
export function permissionDeniedDetail(
  platform: NodeJS.Platform = process.platform,
  serviceUser: string = currentServiceUser(),
  inContainer: boolean = existsSync("/.dockerenv"),
): string {
  if (platform === "darwin" && serviceUser === "_loombre") {
    return (
      "Loombre's service account (_loombre) cannot read this folder — macOS keeps personal " +
      "home folders private. Keep media on an external drive (under /Volumes) or in " +
      "/Users/Shared, or grant the service account access to just your media folder — see " +
      "the install guide's media-permissions section."
    );
  }
  if (platform === "linux" && serviceUser === "loombre") {
    return inContainer
      ? "Loombre's service account (loombre, uid 1000) cannot read this folder — check the " +
          "bind mount's ownership and permissions on the host."
      : "Loombre's service account (loombre) cannot read this folder, and home folders are " +
          "additionally hidden from the service by systemd (ProtectHome). Keep media under " +
          "/srv, /mnt, or /media, or grant the service account access — see the install guide.";
  }
  return "The server does not have permission to read that directory.";
}

/**
 * Shell-quotes a path for safe interpolation into a copy-pasteable command
 * string. A path made up only of characters that never need quoting is left
 * bare (matches how the install guide's own examples read, e.g. `~/Media`);
 * anything else — spaces, an apostrophe, or other shell metacharacters — is
 * wrapped in single quotes, with embedded single quotes escaped by closing
 * the quote, emitting a literal escaped quote, and reopening it (the
 * standard POSIX-shell trick: a single quote cannot be escaped from inside
 * a single-quoted string).
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** macOS folder names TCC (Transparency, Consent, and Control) additionally
 *  locks down beyond standard Unix permissions/ACLs — Full Disk Access,
 *  granted once in System Settings, is the only way past them. Checked
 *  case-insensitively (finding 9: the default macOS volume is
 *  case-insensitive). */
const TCC_PROTECTED_HOME_SUBFOLDERS = new Set(["desktop", "documents", "downloads"]);

/**
 * `requestedPath`, split into non-empty `/`-separated segments, IF it names
 * something at or under a personal macOS home folder (`/Users/<name>`, name
 * not "Shared" — /Users/Shared is world-readable by design) — or null
 * otherwise. Case-insensitive on both "Users" and "Shared" (finding 9:
 * /users/ozzy and /Users/SHARED/x are real, reachable paths on the default
 * macOS volume, not typos). Segments are sliced from `requestedPath`
 * verbatim, so callers that emit commands from them preserve the operator's
 * original casing rather than a hardcoded "Users".
 */
function personalHomeSegments(requestedPath: string): string[] | null {
  const segments = requestedPath.split("/").filter((s) => s.length > 0);
  if (segments[0] === undefined || segments[0].toLowerCase() !== "users") return null;
  const name = segments[1];
  if (name === undefined || name.toLowerCase() === "shared") return null;
  return segments;
}

/**
 * `/<Users>/<name>` (original casing) when `requestedPath` is somewhere
 * INSIDE a personal macOS home folder (three or more meaningful segments) —
 * the ancestor the traversal-only ACL (permissionRemediation command 1)
 * needs to target — or null when it isn't: requestedPath is /Users itself,
 * directly under it, under /Users/Shared, or IS a bare personal home itself
 * (that case is refused entirely by permissionRemediation — see finding 1's
 * comment there, not handled here).
 */
function macOsPersonalHomeAncestor(requestedPath: string): string | null {
  const segments = personalHomeSegments(requestedPath);
  if (segments === null || segments.length < 3) return null;
  return `/${segments[0]}/${segments[1]}`;
}

/**
 * True when `requestedPath` IS a bare personal home folder (`/Users/<name>`,
 * exactly two meaningful segments — no subfolder named yet).
 */
function isBarePersonalHome(requestedPath: string): boolean {
  const segments = personalHomeSegments(requestedPath);
  return segments !== null && segments.length === 2;
}

/**
 * True when `requestedPath` is, or is inside, one of the TCC-protected home
 * subfolders (Desktop/Documents/Downloads under a personal home).
 */
function isTccProtectedHomeFolder(requestedPath: string): boolean {
  const segments = personalHomeSegments(requestedPath);
  if (segments === null || segments.length < 3) return false;
  const subfolder = segments[2];
  return subfolder !== undefined && TCC_PROTECTED_HOME_SUBFOLDERS.has(subfolder.toLowerCase());
}

/**
 * The actionable counterpart to permissionDeniedDetail: a scripted grant
 * recipe, templated with the REAL requested path, for the one installer
 * this can safely be automated for today (macOS + the `_loombre` service
 * account). Semantically identical to the blessed recipe in
 * docs/install/macos.md's "Media in your home folder" section — command
 * order and ACL flags match what that doc tells an operator to run by
 * hand, with the doc's `~` and `~/Media` spelled out here as the absolute
 * path actually being browsed (finding 17: the doc's shorthand and this
 * function's absolute paths name the same folders, not byte-identical text).
 *
 * Linux and bare dev servers return null on purpose: the Linux installer's
 * fix is chown/setfacl against a HOST-owned directory (ProtectHome,
 * bind-mount ownership) — scripting a chown recipe blindly risks handing
 * out (or clobbering) ownership of a directory the operator does not
 * expect touched. The docs handle that case with guidance, not a button.
 */
export function permissionRemediation(
  requestedPath: string,
  platform: NodeJS.Platform = process.platform,
  serviceUser: string = currentServiceUser(),
): { summary: string; commands: string[]; verify: string } | null {
  if (platform !== "darwin" || serviceUser !== "_loombre") {
    return null;
  }

  // Self-defending regardless of caller (finding 8): the controller passes
  // the RAW trimmed query param, while listDirectories() normalizes before
  // ever touching the filesystem. Without this, a `..` segment could make
  // the EMITTED grant target a path other than the one actually browsed —
  // /Users/ozzy/../Shared/Media would browse /Users/Shared/Media but grant
  // access on /Users/ozzy. Explicit posix (not the injectable pathFor():
  // this function only ever runs when platform === "darwin", so the
  // separator is always "/" regardless of the HOST running the test).
  const normalized = path.posix.normalize(requestedPath);

  // BLOCKER (code review): a bare personal home has no ancestor left to
  // traverse into, so the ONLY remaining command would be the read+inherit
  // grant on the home folder ITSELF — a one-click-copy command handing the
  // service account recursive read over the operator's ENTIRE home
  // (~/Library, ~/.ssh included). This is the picker's most likely path:
  // roots -> /Users -> click your username -> 403 -> this panel. Never
  // script a whole-home grant — fall back to the detail paragraph, whose
  // guidance (subfolder / external drive / /Users/Shared) is the right
  // answer for exactly this case.
  if (isBarePersonalHome(normalized)) {
    return null;
  }

  // MAJOR (code review): Desktop/Documents/Downloads are additionally
  // locked down by TCC, which ACLs cannot lift — only a one-time Full Disk
  // Access grant in System Settings can (see docs/install/macos.md's
  // media-permissions section). Emitting a recipe here sends an operator
  // through copy -> run -> Check again -> still 403, with the UI having
  // asserted this was the fix — scripting a fix that provably fails erodes
  // trust in the whole panel. Fall back to detail.
  if (isTccProtectedHomeFolder(normalized)) {
    return null;
  }

  const commands: string[] = [];
  const homeAncestor = macOsPersonalHomeAncestor(normalized);
  if (homeAncestor !== null) {
    // Traversal only — lets _loombre walk THROUGH the home folder without
    // revealing anything inside it (docs/install/macos.md's "Media in your
    // home folder" section).
    commands.push(`chmod +a "user:_loombre allow search" ${shellQuote(homeAncestor)}`);
  }
  // Read + list on just the requested folder, inherited by everything added
  // to it later (docs/install/macos.md's "Media in your home folder"
  // section).
  commands.push(
    `chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" ${shellQuote(normalized)}`,
  );

  return {
    summary: "Loombre's service account (_loombre) can't read this folder.",
    commands,
    verify: `sudo -u _loombre ls ${shellQuote(normalized)}`,
  };
}

/**
 * Candidate roots to offer when no path is supplied.
 *
 * Only paths that actually EXIST are returned — an empty /media on a
 * desktop Linux box is noise, and offering a root that dead-ends is worse
 * than not offering it. Windows enumerates drive letters because there is
 * no single filesystem root to descend from.
 */
export function listRoots(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  canRead: (p: string) => boolean = canReadDirectory,
): DirectoryListingDto {
  const candidates: string[] =
    platform === "win32"
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : platform === "darwin"
        ? // /Volumes is where external drives and network shares mount, which
          // is exactly where a media library usually lives on a Mac.
          ["/", "/Volumes", "/Users"]
        : ["/", "/mnt", "/media", "/home", "/srv"];

  const entries = candidates.filter(exists).map((p) => ({ name: p, path: p, readable: canRead(p) }));
  return { path: null, parent: null, entries };
}

/**
 * Immediate subdirectories of `requestedPath`.
 *
 * Throws DirectoryBrowseError; the controller maps that onto RFC 9457
 * responses. Nothing here formats HTTP.
 */
export function listDirectories(
  requestedPath: string,
  platform: NodeJS.Platform = process.platform,
): DirectoryListingDto {
  const p = pathFor(platform);

  // A NUL byte terminates a C string, so a path containing one can mean a
  // different file to the syscall than to the check that approved it.
  // Node throws on these anyway; rejecting first keeps the failure a clean
  // 422 rather than an ERR_INVALID_ARG_VALUE surfacing as a 500.
  if (requestedPath.includes("\0")) {
    throw new DirectoryBrowseError({ kind: "not-absolute" });
  }

  // Absolute only. A relative path would resolve against the SERVER's
  // working directory — a base the operator cannot see and which differs
  // between the installers (a service's cwd is not a shell's).
  if (!p.isAbsolute(requestedPath)) {
    throw new DirectoryBrowseError({ kind: "not-absolute" });
  }

  // normalize collapses `.` and `..` BEFORE any syscall, so what gets read
  // is what gets reported back as `path` — a listing whose contents and
  // whose label disagree would be its own small lie.
  const normalized = p.normalize(requestedPath);

  let stat;
  try {
    stat = statSync(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new DirectoryBrowseError({ kind: "permission-denied" });
    }
    throw new DirectoryBrowseError({ kind: "not-found" });
  }
  if (!stat.isDirectory()) {
    throw new DirectoryBrowseError({ kind: "not-a-directory" });
  }

  let dirents;
  try {
    dirents = readdirSync(normalized, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new DirectoryBrowseError(
      code === "EACCES" || code === "EPERM" ? { kind: "permission-denied" } : { kind: "not-found" },
    );
  }

  const entries: DirectoryEntryDto[] = [];
  for (const dirent of dirents) {
    const full = p.join(normalized, dirent.name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      // Symlinked directories are followed on purpose: /Volumes entries and
      // plenty of real media layouts are symlinks, and refusing them would
      // make ordinary setups unbrowsable. Safe here precisely because this
      // endpoint returns names only — following a link reveals nothing a
      // direct listing of the target would not, and the caller is already
      // an admin who could type the target path anyway.
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        // Broken link, or a target we cannot stat. Skip it.
        continue;
      }
    }
    if (!isDir) continue;
    entries.push({ name: dirent.name, path: full, readable: canReadDirectory(full) });
  }

  // Case-insensitive so the order matches what the platform's own file
  // manager shows; localeCompare rather than < so accented names sort
  // sensibly instead of by code point.
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parentPath = p.dirname(normalized);
  return {
    path: normalized,
    // dirname("/") === "/" and dirname("C:\\") === "C:\\" — at a root the
    // parent is itself, which would render as an "up" control that goes
    // nowhere. Report null so the client can hide it.
    parent: parentPath === normalized ? null : parentPath,
    entries,
  };
}
