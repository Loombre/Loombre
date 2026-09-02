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

import { accessSync, constants, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

/** systemd's ProtectHome=true (all three Linux installer units) mounts an
 *  inaccessible, empty directory over these — the service cannot see
 *  anything beneath them, and no permission change on the real folders
 *  can help. */
const LINUX_PROTECT_HOME_ROOTS = ["/home", "/root", "/run/user"];

function isUnderLinuxProtectedHome(p: string): boolean {
  return LINUX_PROTECT_HOME_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
}

/** Desktop Linux auto-mounts removable drives under /media/<user>, a
 *  directory private to that user (mode 700 plus an ACL for them alone) —
 *  the service cannot even pass through it. `/media/<user>` for a path
 *  inside one, else null. */
function linuxPerUserMediaRoot(p: string): string | null {
  const match = /^\/media\/([^/]+)(?:\/|$)/.exec(p);
  return match?.[1] === undefined ? null : `/media/${match[1]}`;
}

/** The MSI's three services run as LocalSystem, which userInfo() reports as
 *  "SYSTEM". A drive letter mapped in the operator's sign-in session does
 *  not exist for that account, and a share is reached as the computer
 *  account — both fail in ways that read as "missing" or "forbidden"
 *  without being either. */
function isWindowsLocalSystem(serviceUser: string): boolean {
  return serviceUser.toUpperCase() === "SYSTEM";
}

/** Trailing separators dropped (never the root itself): a command must
 *  name the folder, not "the folder, with a slash". */
function stripTrailingSlash(p: string): string {
  return p.replace(/(?<=.)\/+$/, "");
}

/**
 * The 403 detail for a permission-denied browse, tailored to the service
 * account the server is ACTUALLY running as — detected, not assumed, so a
 * dev server running as a normal user never claims to be an installer —
 * and to the path, because the reason differs: a macOS home folder, a
 * Linux folder systemd hides outright (ProtectHome), a desktop's private
 * /media/<user> mount root, a Windows share the LocalSystem account cannot
 * reach. The macOS field report behind this: the picker said just
 * "Forbidden" while the real situation ("the _loombre daemon cannot read
 * your home folder, and here is what to do instead") was fully known
 * server-side.
 */
export function permissionDeniedDetail(
  requestedPath: string,
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
    if (inContainer) {
      return (
        "Loombre's service account (loombre, uid 1000) cannot read this folder — check the " +
        "bind mount's ownership and permissions on the host."
      );
    }
    const normalized = path.posix.normalize(requestedPath);
    if (isUnderLinuxProtectedHome(normalized)) {
      return (
        "Loombre's service account (loombre) cannot see this folder: systemd hides /home, /root " +
        "and /run/user from the service entirely (ProtectHome), so no permission change on the " +
        "folder itself can help. Keep media under /srv, /mnt, or /media, or bind-mount your media " +
        "folder to a path outside /home — see the install guide's media-permissions section."
      );
    }
    const mediaRoot = linuxPerUserMediaRoot(normalized);
    if (mediaRoot !== null) {
      return (
        `Loombre's service account (loombre) cannot read this folder: drives auto-mounted under ${mediaRoot} ` +
        "are private to that user. Grant the service account access with setfacl, or for FAT/exFAT/NTFS " +
        "drives mount the drive with options that let loombre read it — see the install guide's " +
        "media-permissions section."
      );
    }
    return (
      "Loombre's service account (loombre) cannot read this folder. Grant it read access with setfacl " +
      "(additive and revocable — no need to chown your media) — see the install guide's " +
      "media-permissions section."
    );
  }
  if (platform === "win32" && isWindowsLocalSystem(serviceUser)) {
    return (
      "Loombre's services run as the Windows LocalSystem account: it cannot use drive letters mapped " +
      "in your sign-in session, and it reaches network shares as this computer's account, not as you. " +
      "For a share, use its UNC path (\\\\server\\share\\folder) and give this computer's account — or " +
      "Everyone — read access on the share and the folder, or run the Loombre services as a user " +
      "that can reach it — see the install guide's network-shares section."
    );
  }
  return "The server does not have permission to read that directory.";
}

/**
 * The 404 detail for a browse whose path the server could not find. Under
 * the Windows installer that is not always "missing": a drive letter
 * mapped in the operator's sign-in session does not exist for the
 * LocalSystem services at all, and a share may simply refuse the computer
 * account — both surface as ENOENT. `driveRootExists` is the probe for the
 * former (injectable: the test host has no drive letters).
 */
export function notFoundDetail(
  requestedPath: string,
  platform: NodeJS.Platform = process.platform,
  serviceUser: string = currentServiceUser(),
  driveRootExists: (root: string) => boolean = existsSync,
): string {
  const generic = "No such directory on the server.";
  if (platform !== "win32" || !isWindowsLocalSystem(serviceUser)) return generic;

  const drive = /^([A-Za-z]):[\\/]/.exec(requestedPath);
  if (drive?.[1] !== undefined) {
    const letter = drive[1].toUpperCase();
    if (driveRootExists(`${letter}:\\`)) return generic;
    return (
      `Drive ${letter}: is not visible to Loombre's services — they run as LocalSystem, which cannot ` +
      "see drive letters mapped in your sign-in session. Use the share's UNC path instead " +
      "(\\\\server\\share\\folder) — see the install guide's network-shares section."
    );
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(requestedPath);
  if (unc?.[1] !== undefined && unc[2] !== undefined) {
    return (
      `\\\\${unc[1]}\\${unc[2]} could not be opened by Loombre's services. They run as LocalSystem and ` +
      "connect to shares as this computer's account, not as you — give that account (or Everyone) " +
      "read access on the share, or run the services as a user that can reach it — see the " +
      "install guide's network-shares section."
    );
  }
  return generic;
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

/** Filesystems on which setfacl fails with "Operation not supported":
 *  FAT/exFAT/NTFS (permissions come from mount options), FUSE mounts
 *  (ntfs-3g appears as fuseblk; sshfs and friends as fuse.*), optical
 *  media, and network filesystems (CIFS uses server-side ACLs; NFSv4 has
 *  its own ACL model). */
const NO_POSIX_ACL_FSTYPES = new Set([
  "vfat",
  "msdos",
  "exfat",
  "ntfs",
  "ntfs3",
  "fuseblk",
  "iso9660",
  "udf",
  "cifs",
  "smb3",
  "nfs",
  "nfs4",
  "9p",
  "hfsplus",
  "squashfs",
]);

function lacksPosixAcls(fstype: string): boolean {
  return NO_POSIX_ACL_FSTYPES.has(fstype) || fstype.startsWith("fuse");
}

/** /proc/self/mounts field unescaping: mount points with spaces are
 *  written as octal escapes (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * The filesystem type of the deepest mount containing `p`, from the text
 * of /proc/self/mounts (`<device> <mount point> <type> <options> ...`, one
 * per line) — or null when nothing matches. Pure so the lookup is testable
 * off Linux; the default `mountFsType` below reads the real file.
 */
export function fsTypeFromMounts(mountsText: string, p: string): string | null {
  let best: { point: string; type: string } | null = null;
  for (const line of mountsText.split("\n")) {
    const fields = line.split(" ");
    const rawPoint = fields[1];
    const type = fields[2];
    if (rawPoint === undefined || type === undefined) continue;
    const point = unescapeMountField(rawPoint);
    const contains = point === "/" || p === point || p.startsWith(`${point}/`);
    if (contains && (best === null || point.length > best.point.length)) {
      best = { point, type };
    }
  }
  return best?.type ?? null;
}

function linuxMountFsType(p: string): string | null {
  try {
    return fsTypeFromMounts(readFileSync("/proc/self/mounts", "utf8"), p);
  } catch {
    return null;
  }
}

/** Can this process walk THROUGH the directory — look names up inside it
 *  (X_OK) without necessarily listing them? Answered as the account the
 *  server actually runs as, which is the point: once the picker's step-1
 *  grant on a home folder is in place, the traversal half of the step-2
 *  recipe already holds and must not be issued again. Injectable for the
 *  same reason listRoots' callers inject `exists` — the real answer differs
 *  between a dev host (its own home) and the installed daemon. */
function canTraverseDirectory(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PermissionRemediation {
  summary: string;
  commands: string[];
  verify: string;
  /** What the commands expose, what they leave private, and — for a
   *  multi-step flow — what comes next (the contract's optional `note`). */
  note: string;
  /** The same grant as a `loombre://grant` URL for the macOS menubar app,
   *  which runs as the signed-in user and can apply it behind a native
   *  consent dialog (the contract's optional `nativeGrantUrl`). Absent
   *  where no native helper exists (Linux). */
  nativeGrantUrl?: string;
}

/**
 * The macOS menubar app's URL scheme: `loombre://grant?v=1&scope=…&path=…
 * [&traverse=…]`. The app does NOT trust this URL for policy — any web page
 * can open a custom-scheme URL — it re-validates against the same rules
 * (never a whole-home read, never a TCC folder, traversal only on the
 * signed-in user's own home) and shows the exact grant in a consent
 * dialog before applying anything. The URL is the recipe, not authority.
 */
function macOsNativeGrantUrl(scope: "names-only" | "read", targetPath: string, traverse: string | null): string {
  const query = `v=1&scope=${scope}&path=${encodeURIComponent(targetPath)}`;
  return `loombre://grant?${query}${traverse === null ? "" : `&traverse=${encodeURIComponent(traverse)}`}`;
}

/** The read grant for a media folder: read + list now, inherited by
 *  everything added to it later (the two inherit flags). Identical to the
 *  ACE docs/install/macos.md's "Media in your home folder" section has the
 *  operator run by hand. */
const MEDIA_READ_ACE = "read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit";

/**
 * The actionable counterpart to permissionDeniedDetail: a scripted grant
 * recipe, templated with the REAL requested path, for the installers this
 * can safely be automated for — macOS (`_loombre`, ACLs via chmod +a) and
 * Linux (`loombre`, POSIX ACLs via setfacl). Both are additive and
 * revocable: nothing is chowned, nothing is widened for anyone but the
 * service account. Null means "no safe scripted fix — render `detail`".
 *
 * The recipes are semantically identical to the blessed ones in the
 * install guides' media-permissions sections — command order and flags
 * match what those docs tell an operator to run by hand, with the docs'
 * example paths spelled out here as the absolute path actually being
 * browsed (finding 17: the doc's shorthand and this function's absolute
 * paths name the same folders, not byte-identical text).
 */
export function permissionRemediation(
  requestedPath: string,
  platform: NodeJS.Platform = process.platform,
  serviceUser: string = currentServiceUser(),
  canTraverse: (p: string) => boolean = canTraverseDirectory,
  inContainer: boolean = existsSync("/.dockerenv"),
  mountFsType: (p: string) => string | null = linuxMountFsType,
): PermissionRemediation | null {
  // Self-defending regardless of caller (finding 8): the controller passes
  // the RAW trimmed query param, while listDirectories() normalizes before
  // ever touching the filesystem. Without this, a `..` segment could make
  // the EMITTED grant target a path other than the one actually browsed —
  // /Users/ozzy/../Shared/Media would browse /Users/Shared/Media but grant
  // access on /Users/ozzy. Explicit posix (not the injectable pathFor():
  // both recipes are POSIX-only, so the separator is always "/" regardless
  // of the HOST running the test).
  const normalized = stripTrailingSlash(path.posix.normalize(requestedPath));

  if (platform === "darwin" && serviceUser === "_loombre") {
    return macOsRemediation(normalized, canTraverse);
  }
  if (platform === "linux" && serviceUser === "loombre" && !inContainer) {
    return linuxRemediation(normalized, canTraverse, mountFsType);
  }
  // Containers (the fix is a bind mount's ownership on the HOST), Windows
  // (LocalSystem reads every local volume; shares are a share-permission
  // question — see notFoundDetail/permissionDeniedDetail), and bare dev
  // servers: guidance, not a button.
  return null;
}

/**
 * macOS: media in a personal home folder is a TWO-STEP flow, because the
 * picker's most likely path is roots -> /Users -> click your username ->
 * 403, and listing the home is exactly what is denied — the picker cannot
 * reach a subfolder to offer a recipe for until the home itself can be
 * listed:
 *
 *   1. bare home (`/Users/<name>`): ONE non-inheriting `list,search` ACE on
 *      the home folder itself. Reveals only the NAMES of the entries
 *      directly inside it; everything the OS keeps at 700 (~/Library,
 *      ~/.ssh, Documents, Desktop, Downloads, Movies, Music, Pictures)
 *      stays closed, and nothing is inherited. A whole-home read grant is
 *      never scripted — that would hand the service account ~/.ssh and
 *      ~/Library with one click. Offering NOTHING for a bare home is not
 *      an option either: it leaves the flow unreachable in practice
 *      (FPG-1).
 *   2. the media folder inside it: the read+inherit grant on just that
 *      folder, with the home-traversal command omitted whenever the server
 *      can already walk the home (which, after step 1, it always can — a
 *      re-issued grant would tell the operator to run a command they have
 *      already run).
 */
function macOsRemediation(normalized: string, canTraverse: (p: string) => boolean): PermissionRemediation | null {
  if (isBarePersonalHome(normalized)) {
    return {
      summary: "Loombre's service account (_loombre) can't list this home folder.",
      commands: [`chmod +a "user:_loombre allow list,search" ${shellQuote(normalized)}`],
      verify: `sudo -u _loombre ls ${shellQuote(normalized)}`,
      note:
        "This reveals only the names of the folders directly inside your home — nothing inside them. " +
        "Once it can list your home, open your media folder there to get its own read grant as the next step.",
      nativeGrantUrl: macOsNativeGrantUrl("names-only", normalized, null),
    };
  }

  // Desktop/Documents/Downloads are additionally locked down by TCC, which
  // ACLs cannot lift — only a one-time Full Disk Access grant in System
  // Settings can (see docs/install/macos.md's media-permissions section).
  // Emitting a recipe here would send an operator through copy -> run ->
  // Check again -> still 403, with the UI having asserted this was the
  // fix — scripting a fix that provably fails erodes trust in the whole
  // panel. Fall back to detail.
  if (isTccProtectedHomeFolder(normalized)) {
    return null;
  }

  const commands: string[] = [];
  const homeAncestor = macOsPersonalHomeAncestor(normalized);
  const needsTraversal = homeAncestor !== null && !canTraverse(homeAncestor);
  if (needsTraversal) {
    // Traversal only — lets _loombre walk THROUGH the home folder without
    // revealing anything inside it (docs/install/macos.md's "Media in your
    // home folder" section).
    commands.push(`chmod +a "user:_loombre allow search" ${shellQuote(homeAncestor)}`);
  }
  // Read + list on just the requested folder, inherited by everything added
  // to it later (docs/install/macos.md's "Media in your home folder"
  // section).
  commands.push(`chmod +a "user:_loombre allow ${MEDIA_READ_ACE}" ${shellQuote(normalized)}`);

  const note =
    homeAncestor === null
      ? "Read access on this folder and everything added to it later."
      : needsTraversal
        ? `Read access on this folder and everything added to it later, plus permission to walk through ${homeAncestor} ` +
          "without revealing what it contains — nothing else in your home folder."
        : "Read access on this folder and everything added to it later — nothing else in your home folder.";

  return {
    summary: "Loombre's service account (_loombre) can't read this folder.",
    commands,
    verify: `sudo -u _loombre ls ${shellQuote(normalized)}`,
    note,
    nativeGrantUrl: macOsNativeGrantUrl("read", normalized, needsTraversal ? homeAncestor : null),
  };
}

/**
 * Ancestors of `p` (below "/", above `p` itself) from the first one the
 * service cannot pass through down to p's parent. The probe stops at the
 * first block: every deeper ancestor is unreachable regardless of its own
 * permissions, so it is granted traversal too rather than guessed at.
 */
function blockedAncestors(p: string, canTraverse: (p: string) => boolean): string[] {
  const segments = p.split("/").filter((seg) => seg.length > 0);
  const ancestors: string[] = [];
  for (let depth = 1; depth < segments.length; depth++) {
    ancestors.push(`/${segments.slice(0, depth).join("/")}`);
  }
  for (let i = 0; i < ancestors.length; i++) {
    if (!canTraverse(ancestors[i]!)) return ancestors.slice(i);
  }
  return [];
}

/**
 * Linux: the same shape with POSIX ACLs — traverse-only (`x`) on each
 * ancestor the service cannot pass through (typically the desktop's
 * private /media/<user> mount root; reveals nothing else in it), then a
 * recursive read grant on the folder plus a matching DEFAULT entry so
 * files added later inherit it. Verified on a real tree with files. Not
 * scripted: anything under ProtectHome's roots (an inaccessible systemd
 * mount no ACL can lift — same class as macOS TCC), and filesystems
 * without POSIX ACLs (setfacl would only fail; the docs cover mount
 * options). An unknown filesystem type still gets the recipe: the note
 * says what a failure means.
 */
function linuxRemediation(
  normalized: string,
  canTraverse: (p: string) => boolean,
  mountFsType: (p: string) => string | null,
): PermissionRemediation | null {
  if (isUnderLinuxProtectedHome(normalized)) return null;
  const fstype = mountFsType(normalized);
  if (fstype !== null && lacksPosixAcls(fstype)) return null;

  const blocked = blockedAncestors(normalized, canTraverse);
  const commands: string[] = [];
  if (blocked.length > 0) {
    commands.push(`sudo setfacl -m u:loombre:x ${blocked.map(shellQuote).join(" ")}`);
  }
  commands.push(`sudo setfacl -R -m u:loombre:rX,d:u:loombre:rX ${shellQuote(normalized)}`);

  const passThrough =
    blocked.length > 0
      ? `, plus permission to pass through ${blocked.join(" and ")} without revealing what else is there`
      : "";
  return {
    summary: "Loombre's service account (loombre) can't read this folder.",
    commands,
    verify: `sudo -u loombre ls ${shellQuote(normalized)}`,
    note:
      `Read access on this folder and everything added to it later${passThrough}. ` +
      'If setfacl reports "Operation not supported", this drive\'s filesystem has no ACLs — see the ' +
      "install guide for mount options.",
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
