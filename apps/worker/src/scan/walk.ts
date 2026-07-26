// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Streamed, deterministic directory walker (docs/PLAN.md §8.1: "streamed
 * directory walk, no full-tree buffering; deterministic order for
 * resumability"). This determinism is load-bearing, not cosmetic: the
 * checkpoint/resume feature (P1.12) works by walking in the SAME order on
 * every pass and skipping everything up to `last_processed_path` — if two
 * runs over an unchanged tree could produce a different file order, resume
 * would silently skip or duplicate files.
 *
 * "No full-tree buffering" means this never collects the whole file list
 * into an array before yielding — it's an async generator that opens one
 * directory at a time (`fs.promises.opendir`) and recurses depth-first,
 * yielding each FILE entry as it's found. Only ONE directory's entries are
 * held in memory at any depth level.
 *
 * "Deterministic order" is achieved by:
 *   1. Walking `roots` (a library's `paths`) in the given array order.
 *   2. Within each directory, sorting entries alphabetically (by raw
 *      filename, not locale-aware) before visiting them — `readdir`/
 *      `opendir` do not guarantee any particular order across platforms
 *      or filesystems, so this repo imposes one.
 */
import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface WalkedFile {
  /** Absolute, OS-native path. */
  absPath: string;
  /** Path relative to the library root it was found under, POSIX-separated
   *  (forward slashes even on Windows) — this is what the filename/folder
   *  parsers (apps/worker/src/scan/parse/*) expect as input. */
  relPath: string;
  /** Which of the library's `paths` entries this file was found under
   *  (index into the `roots` array passed to walkLibraryPaths). */
  rootIndex: number;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

async function* walkDir(rootAbsPath: string, dirAbsPath: string, rootIndex: number): AsyncGenerator<WalkedFile> {
  let dir;
  try {
    dir = await opendir(dirAbsPath);
  } catch {
    // Directory vanished/unreadable mid-walk (permission error, race with a
    // delete) — skip it rather than aborting the whole scan.
    return;
  }

  const entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    for await (const entry of dir) {
      entries.push({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() });
    }
  } catch {
    // Read error partway through this directory — yield what we already
    // buffered for THIS directory (bounded to one directory's entry count,
    // not the whole tree) and move on.
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const entryAbsPath = join(dirAbsPath, entry.name);
    if (entry.isDirectory) {
      yield* walkDir(rootAbsPath, entryAbsPath, rootIndex);
    } else if (entry.isFile) {
      yield {
        absPath: entryAbsPath,
        relPath: toPosix(relative(rootAbsPath, entryAbsPath)),
        rootIndex,
      };
    }
    // Symlinks/sockets/etc. (neither isDirectory nor isFile under opendir's
    // dirent, when not following symlinks) are skipped — media libraries
    // are real files; symlink-following is out of scope for v1.
  }
}

/**
 * Walks every root in `roots`, in order, yielding files depth-first in
 * deterministic (alphabetically-sorted-per-directory) order. Streaming:
 * never materializes the full file list.
 */
export async function* walkLibraryPaths(roots: readonly string[]): AsyncGenerator<WalkedFile> {
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex]!;
    yield* walkDir(root, root, rootIndex);
  }
}
