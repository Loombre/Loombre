// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/watcher.ts
//
// Trigger (c): Stash DB mtime watch (STATE.md S8/deliverable 7). Imitates
// apps/worker/src/scan/watcher.ts exactly — same chokidar-per-target +
// debounce shape, same network-mount polling heuristic (reused directly,
// not reimplemented: resolveUsePolling/startWatcher are generic over
// "a set of {id, paths}", not scan-specific, so this module just calls
// scan/watcher.ts's own startWatcher with one Stash connection's sqlite
// path (plus its `-wal`/`-shm` WAL sidecars, since Stash — like this
// repo's own Postgres — runs SQLite in WAL mode, where a scene edit
// commonly touches the `-wal` file's mtime well before/instead of the
// main file's, per S2's own adapter header) standing in for a library's
// media paths.
//
// Debounce is intentionally longer than the scan watcher's 2s default: an
// active Stash editing session can generate a long burst of writes, and
// this trigger only needs to notice "Stash's database changed since we
// last looked", not react to every individual write — a 1-minute settle
// window keeps a busy Stash session from enqueueing an incremental sync
// after every single scene edit.

import { startWatcher, type WatcherHandle } from '../scan/watcher.js';

const STASH_WATCH_DEBOUNCE_MS = 60_000;

export interface StashWatcherConnection {
  libraryId: string;
  sqlitePath: string;
}

export interface StartStashWatcherOptions {
  /** Called (debounced) after a burst of writes to a library's Stash
   *  database settles — typically enqueues an incremental stash-sync. */
  onChange: (libraryId: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  debounceMs?: number;
}

export function startStashWatcher(connections: readonly StashWatcherConnection[], options: StartStashWatcherOptions): Promise<WatcherHandle> {
  return startWatcher(
    connections.map((c) => ({ id: c.libraryId, paths: [c.sqlitePath, `${c.sqlitePath}-wal`, `${c.sqlitePath}-shm`] })),
    {
      onChange: options.onChange,
      ...(options.env ? { env: options.env } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      debounceMs: options.debounceMs ?? STASH_WATCH_DEBOUNCE_MS,
    }
  );
}
