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

import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export interface DirectoryEntryDto {
  name: string;
  path: string;
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
): DirectoryListingDto {
  const candidates: string[] =
    platform === "win32"
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : platform === "darwin"
        ? // /Volumes is where external drives and network shares mount, which
          // is exactly where a media library usually lives on a Mac.
          ["/", "/Volumes", "/Users"]
        : ["/", "/mnt", "/media", "/home", "/srv"];

  const entries = candidates.filter(exists).map((p) => ({ name: p, path: p }));
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
    entries.push({ name: dirent.name, path: full });
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
