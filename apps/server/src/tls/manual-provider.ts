// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/manual-provider.ts
//
// LOOMBRE_TLS_MODE=manual: the operator supplies cert+key file paths
// (certbot standalone/webroot output, a purchased cert, anything) and
// Loombre hot-reloads on file change (P4.4) rather than requiring a
// restart every renewal cycle.
//
// Watches the CONTAINING DIRECTORIES of both files, not the files
// themselves: many real cert-rotation tools (certbot's live/ symlink
// swap, k8s secret volume mounts, an editor's atomic write-via-rename)
// replace a file by renaming a new inode over the old path rather than
// writing in place — watching the file's own inode with fs.watch can miss
// that (the watch descriptor tracks the OLD inode, which the rename just
// orphaned). Watching the directory and filtering by filename sidesteps
// this. Debounced because a single logical "cert rotated" event often
// fires as 2-3 rapid fs events (unlink+create, or separate cert/key
// writes landing moments apart) — we want ONE reload of the (now
// consistent) pair, not a hot-swap mid-write with a torn read.

import { watch, realpathSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { CertificateMaterial } from "./secure-context.js";

/**
 * Canonicalize a directory path before handing it to fs.watch.
 *
 * WINDOWS CRASH GUARD, found by the first windows-latest CI runs of this
 * suite (STATE.md P4.21): if the watched path contains a DOS 8.3 short-name
 * component (`C:\Users\RUNNER~1\...` — exactly what os.tmpdir() returns on
 * GitHub runners, and what an operator's %TEMP%-derived or legacy-tool-
 * emitted cert path can contain too), libuv's fs-event backend ABORTS THE
 * WHOLE PROCESS on the first event it delivers:
 *
 *     Assertion failed: !_wcsnicmp(filename, dir, dirlen),
 *       file src\win\fs-event.c, line 72
 *
 * — a C-level assert comparing the event's long-form path against the
 * short-form directory string it was given, not a catchable JS error. For
 * a production server in LOOMBRE_TLS_MODE=manual this is a hard crash, so
 * it must be prevented here rather than documented. realpathSync.native()
 * resolves short names to their long form on Windows (and resolves
 * symlinks everywhere — also better for watching: certbot's live/ dir IS
 * symlinks). Falls back to the caller's spelling when resolution fails
 * (path doesn't exist yet); fs.watch then reports its own error through
 * the watcher's error handler as before, instead of this helper throwing
 * a new kind of setup failure.
 */
function canonicalWatchDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export interface ManualTlsPaths {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

export function readManualCertificate(paths: ManualTlsPaths): CertificateMaterial {
  const cert = readFileSync(paths.certPath, "utf8");
  const key = readFileSync(paths.keyPath, "utf8");
  const ca = paths.caPath !== undefined ? readFileSync(paths.caPath, "utf8") : undefined;
  return { cert, key, ...(ca !== undefined ? { ca } : {}) };
}

export interface WatchManualCertificateOptions {
  debounceMs?: number;
  /** Injectable for tests; defaults to node:fs's real `watch`. */
  watchFn?: typeof watch;
  onError?: (err: unknown) => void;
}

function sameMaterial(a: CertificateMaterial, b: CertificateMaterial): boolean {
  return a.cert === b.cert && a.key === b.key && a.ca === b.ca;
}

/** Starts watching both files' directories; calls `onChange` with the
 *  freshly re-read certificate material (debounced) whenever either file
 *  ACTUALLY changes. Returns a stop function that closes both watchers.
 *
 * Two real-world fs.watch quirks both land on the same "compare against
 * last-known material, skip a no-op notification" fix:
 *   - A read failure mid-rotation (e.g. the key was replaced but the cert
 *     write hasn't landed yet) is caught and reported via `onError`
 *     WITHOUT calling `onChange` — the server keeps serving its current
 *     (still valid) context and the next debounced fs event gets another
 *     chance once the pair is consistent.
 *   - fs.watch on a freshly-created watcher can deliver a SPURIOUS event
 *     for the directory's pre-existing state almost immediately after
 *     attaching (observed in this file's own test suite, on macOS —
 *     FSEvents coalesces a little history right at watch-start). Without
 *     a real-change filter, that spurious event fires `onChange` with the
 *     exact material the caller already has, and any test/consumer
 *     racing on "the first onChange call" catches noise instead of a real
 *     rotation. Tracking `lastKnown` and comparing before calling
 *     `onChange` fixes both. */
export function watchManualCertificate(
  paths: ManualTlsPaths,
  onChange: (material: CertificateMaterial) => void,
  opts: WatchManualCertificateOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 500;
  const watchFn = opts.watchFn ?? watch;
  const onError = opts.onError ?? ((err) => console.error("[tls/manual] failed to reload TLS material:", err));

  const watchedNames = new Set([basename(paths.certPath), basename(paths.keyPath)]);
  if (paths.caPath !== undefined) watchedNames.add(basename(paths.caPath));
  // Canonicalized (see canonicalWatchDir): two spellings of the same
  // directory also correctly collapse into ONE watcher here.
  const watchedDirs = new Set([canonicalWatchDir(dirname(paths.certPath)), canonicalWatchDir(dirname(paths.keyPath))]);
  if (paths.caPath !== undefined) watchedDirs.add(canonicalWatchDir(dirname(paths.caPath)));

  let lastKnown: CertificateMaterial | undefined;
  try {
    lastKnown = readManualCertificate(paths);
  } catch {
    // Paths may not exist yet at watch-setup time in some caller flows;
    // the first successful read will simply be treated as a real change.
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReload = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const material = readManualCertificate(paths);
        if (lastKnown !== undefined && sameMaterial(lastKnown, material)) return;
        lastKnown = material;
        onChange(material);
      } catch (err) {
        onError(err);
      }
    }, debounceMs);
    timer.unref?.();
  };

  const watchers: FSWatcher[] = [];
  for (const dir of watchedDirs) {
    const watcher = watchFn(dir, (_eventType, filename) => {
      if (filename !== null && !watchedNames.has(filename.toString())) return;
      scheduleReload();
    });
    watcher.on("error", onError);
    watchers.push(watcher);
  }

  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
