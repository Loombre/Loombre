// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/watcher.spec.ts
//
// Trigger (c) proof — apps/worker/src/stash/watcher.ts's startStashWatcher.
// Real chokidar mechanics (debounce, network-mount polling heuristic,
// per-path event granularity) are apps/worker/src/scan/watcher.ts's own
// responsibility (this module is a thin delegation to it — see that
// module's own test-free precedent; native fs-event backends can report
// at directory rather than per-file granularity on some platforms, which
// is inherent to chokidar/the OS, not this wrapper's logic) — this test
// proves only the delegation itself: a write to a library's configured
// Stash sqlite path fires that library's onChange, debounced.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStashWatcher, type StashWatcherConnection } from "../../src/stash/watcher.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor: timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("startStashWatcher", () => {
  it("a write to a library's Stash sqlite path fires that library's onChange (debounced)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "loombre-stash-watcher-"));
    const libAPath = path.join(dir, "lib-a.sqlite");
    const libBPath = path.join(dir, "lib-b.sqlite");
    writeFileSync(libAPath, "initial-a");
    writeFileSync(libBPath, "initial-b");

    const connections: StashWatcherConnection[] = [
      { libraryId: "lib-a", sqlitePath: libAPath },
      { libraryId: "lib-b", sqlitePath: libBPath },
    ];
    const changed: string[] = [];
    const handle = startStashWatcher(connections, {
      onChange: (libraryId) => changed.push(libraryId),
      debounceMs: 50,
      // Windows only: force chokidar's stat-polling backend instead of the
      // native fs.watch/libuv fs-event backend, which ABORTS the process on
      // the CI runner ("Assertion failed: !_wcsnicmp(filename, dir, dirlen),
      // src\win\fs-event.c, line 72") — a known libuv/chokidar bug watching
      // under an 8.3-short-name temp path (os.tmpdir() = C:\Users\RUNNER~1\…).
      // The abort killed the vitest worker fork ("Worker exited unexpectedly")
      // even though every test passed. Polling detects the same write
      // (verified) and exercises the identical delegation logic — the backend
      // is chokidar's/the OS's concern, not this wrapper's (see file header).
      ...(process.platform === "win32" ? { env: { ...process.env, LOOMBRE_SCAN_POLL: "1" } } : {}),
    });

    try {
      // chokidar needs a beat to finish its initial scan before it will
      // reliably report subsequent changes.
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(libAPath, "changed-a");

      await waitFor(() => changed.includes("lib-a"), 5000);
      expect(changed).toContain("lib-a");
    } finally {
      await handle.stop();
    }
  }, 10_000);
});
