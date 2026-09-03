// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/watcher.spec.ts
//
// The library watcher must never freeze worker boot. On macOS, `fs.watch`
// (chokidar's native backend) opens the watched directory SYNCHRONOUSLY
// inside libuv's `uv_fs_event_start`, and opening a privacy-protected folder
// (Desktop/Documents/Downloads, or a missing library path whose nearest
// existing parent is one of those) blocks the main thread on the TCC
// consent prompt — indefinitely when nobody is there to answer it. Live
// 2026-09-03: a stale dev library at ~/Desktop/Movies froze the worker's
// event loop at boot, every pg-boss poller went silent after its first
// fetch, and no probe/transcode job ever ran (stack sample: main thread in
// FSEventWrap::Start -> uv_fs_event_start -> open()).
//
// The guard: every library path is probed ASYNCHRONOUSLY (off the event
// loop) with a bounded timeout before chokidar is asked to watch it; a
// path that is missing, denied, or does not answer in time is skipped with
// a log line, and the rest of the worker boots normally. Chokidar's own
// runtime errors are also observed so an unlistened 'error' event can never
// surface as a process-fatal unhandled rejection.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWatcher, type WatcherHandle } from "../../src/scan/watcher.js";

const handles: WatcherHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
});

describe("startWatcher boot guard", () => {
  it("skips a library whose path probe never answers (a blocked privacy-protected folder) within the timeout, and still resolves", async () => {
    const never = new Promise<void>(() => undefined);
    const log = vi.fn();
    const startedAt = Date.now();
    const handle = await startWatcher([{ id: "lib-blocked", paths: ["/Users/someone/Desktop/Movies"] }], {
      onChange: () => undefined,
      probePath: () => never,
      probeTimeoutMs: 50,
      log,
    });
    handles.push(handle);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(handle.watchedLibraryIds).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lib-blocked"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("/Users/someone/Desktop/Movies"));
  });

  it("skips a library whose path AND its parent are missing (nothing answers)", async () => {
    const log = vi.fn();
    const missing = join(tmpdir(), "loombre-watcher-missing-" + process.pid, "nope");
    const handle = await startWatcher([{ id: "lib-missing", paths: [missing] }], {
      onChange: () => undefined,
      probeTimeoutMs: 1_000,
      log,
    });
    handles.push(handle);
    expect(handle.watchedLibraryIds).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lib-missing"));
  });

  it("watches an accessible library and still debounces its changes into onChange", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-ok-"));
    try {
      const onChange = vi.fn();
      const handle = await startWatcher([{ id: "lib-ok", paths: [dir] }], {
        onChange,
        debounceMs: 100,
        // Stat polling keeps the test deterministic across platforms (the
        // stash watcher spec explains the win32 ReadDirectoryChangesW trap).
        env: { LOOMBRE_SCAN_POLL: "1" },
      });
      handles.push(handle);
      expect(handle.watchedLibraryIds).toEqual(["lib-ok"]);
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(join(dir, "new.mkv"), "x");
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("lib-ok"), { timeout: 5_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing path whose parent answers is still watched (chokidar watches the parent for its creation — the Stash -wal case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-wal-"));
    try {
      const log = vi.fn();
      const handle = await startWatcher([{ id: "lib-wal", paths: [join(dir, "stash.sqlite-wal")] }], {
        onChange: () => undefined,
        probeTimeoutMs: 500,
        log,
        env: { LOOMBRE_SCAN_POLL: "1" },
      });
      handles.push(handle);
      expect(handle.watchedLibraryIds).toEqual(["lib-wal"]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a library mixing one blocked path and one good path keeps watching the good path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-mixed-"));
    try {
      const log = vi.fn();
      const never = new Promise<void>(() => undefined);
      const handle = await startWatcher([{ id: "lib-mixed", paths: ["/blocked/protected/folder", dir] }], {
        onChange: () => undefined,
        probePath: (path) => (path.startsWith("/blocked") ? never : Promise.resolve()),
        probeTimeoutMs: 100,
        log,
        env: { LOOMBRE_SCAN_POLL: "1" },
      });
      handles.push(handle);
      expect(handle.watchedLibraryIds).toEqual(["lib-mixed"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("/blocked/protected/folder"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
