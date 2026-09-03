// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/watcher.spec.ts
//
// The library watcher must never freeze the worker, at boot or after. On
// macOS, `fs.watch` (chokidar's native backend) opens the watched directory
// SYNCHRONOUSLY inside libuv's `uv_fs_event_start`, and opening a
// privacy-protected folder (Desktop/Documents/Downloads, or a missing
// library path whose nearest existing parent is one of those) blocks the
// calling thread on the TCC consent prompt — indefinitely when nobody is
// there to answer it. Live 2026-09-03: a stale dev library at
// ~/Desktop/Movies froze the worker's event loop at boot, every pg-boss
// poller went silent after its first fetch, and no probe/transcode job ever
// ran (stack sample: main thread in FSEventWrap::Start -> uv_fs_event_start
// -> open()). Later the same day a native watch on a path the probe HAD
// passed blocked the same way — access() cannot predict an FSEvents open.
//
// Three guards, all pinned here:
//   SPF-11 — every library path is probed ASYNCHRONOUSLY (off the event
//   loop) with a bounded timeout before chokidar is asked to watch it; a
//   path that is missing, denied, or does not answer in time is skipped
//   with a log line.
//   SPF-14 (thread) — chokidar runs in a worker_thread; the main thread
//   waits on that thread only behind bounded timeouts (plan acknowledgement,
//   stop) and never on its initial scan, so a wedged thread costs its own
//   watch events and nothing else.
//   SPF-14 (polling) — on darwin a path under a privacy-protected root
//   polls (stat + async readdir) instead of opening FSEvents at all.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_UNRESPONSIVE_MS,
  hasUnresponsiveWatcherThread,
  liveWatcherThreadCount,
  looksLikeNetworkMount,
  looksLikeTccProtectedPath,
  planWatch,
  resolveUsePolling,
  startWatcher,
  type WatcherHandle,
} from "../../src/scan/watcher.js";

const handles: WatcherHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
});

const WEDGED_THREAD_URL = new URL("./support/wedged-watcher-thread.mjs", import.meta.url);
const CRASHING_THREAD_URL = new URL("./support/crashing-watcher-thread.mjs", import.meta.url);
const SCRIPTED_THREAD_URL = new URL("./support/scripted-watcher-thread.mjs", import.meta.url);

/** Every thread a test spawned must be gone before the next test reads the
 *  process-wide liveness registry. */
async function threadsGone(): Promise<void> {
  await vi.waitFor(() => expect(liveWatcherThreadCount()).toBe(0), { timeout: 5_000 });
}

describe("startWatcher boot guard (SPF-11)", () => {
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
      // chokidar treats anything it finds during its initial scan as
      // pre-existing (ignoreInitial) — write only once the scan is done.
      await handle.ready;
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

describe("macOS privacy-protected roots → polling (SPF-14)", () => {
  it.each([
    ["/Users/ozzy/Desktop/Movies", true],
    ["/Users/ozzy/Desktop", true],
    ["/users/OZZY/DOCUMENTS/Shows", true],
    ["/Users/ozzy/Downloads/incoming", true],
    ["/Users/ozzy/Library/Mobile Documents/com~apple~CloudDocs/Media", true],
    ["/Users/ozzy/Pictures/Photos Library.photoslibrary/originals", true],
    ["/Users/Shared/Desktop", false],
    ["/Users/ozzy", false],
    ["/Users/ozzy/Movies", false],
    ["/Users/ozzy/Library/Application Support/Loombre", false],
    ["/Volumes/Media/Movies", false],
    ["/srv/media", false],
  ])("looksLikeTccProtectedPath(%s) on darwin → %s", (path, expected) => {
    expect(looksLikeTccProtectedPath(path, "darwin")).toBe(expected);
  });

  it("is darwin-only — the same paths never poll on linux or win32", () => {
    expect(looksLikeTccProtectedPath("/Users/ozzy/Desktop/Movies", "linux")).toBe(false);
    expect(looksLikeTccProtectedPath("/Users/ozzy/Desktop/Movies", "win32")).toBe(false);
    expect(resolveUsePolling("/Users/ozzy/Desktop/Movies", {}, "linux")).toBe(false);
  });

  it("resolveUsePolling: a protected root polls by default on darwin; LOOMBRE_SCAN_POLL=0 forces native; =1 polls anything", () => {
    expect(resolveUsePolling("/Users/ozzy/Desktop/Movies", {}, "darwin")).toBe(true);
    expect(resolveUsePolling("/Users/ozzy/Movies", {}, "darwin")).toBe(false);
    expect(resolveUsePolling("/Users/ozzy/Desktop/Movies", { LOOMBRE_SCAN_POLL: "0" }, "darwin")).toBe(false);
    expect(resolveUsePolling("/Users/ozzy/Movies", { LOOMBRE_SCAN_POLL: "1" }, "darwin")).toBe(true);
    // The pre-existing network-mount rule is untouched.
    expect(looksLikeNetworkMount("/Volumes/NAS/Movies", "darwin")).toBe(true);
    expect(resolveUsePolling("/Volumes/NAS/Movies", {}, "darwin")).toBe(true);
  });

  it("planWatch hands a library under ~/Desktop to the thread with usePolling on (missing folder, reachable parent included)", async () => {
    const plan = await planWatch(
      [
        { id: "lib-desktop", paths: ["/Users/ozzy/Desktop/Movies"] },
        { id: "lib-local", paths: ["/srv/media"] },
        { id: "lib-mixed", paths: ["/srv/more", "/Users/ozzy/Documents/Shows"] },
      ],
      {
        platform: "darwin",
        env: {},
        // The folder itself is gone; its parent (~/Desktop) answers — exactly
        // the live 2026-09-03 shape.
        probePath: (path) =>
          path === "/Users/ozzy/Desktop/Movies" ? Promise.reject(new Error("ENOENT: no such file or directory")) : Promise.resolve(),
        log: () => undefined,
        info: () => undefined,
      }
    );
    expect(plan).toEqual([
      { libraryId: "lib-desktop", paths: ["/Users/ozzy/Desktop/Movies"], usePolling: true },
      { libraryId: "lib-local", paths: ["/srv/media"], usePolling: false },
      { libraryId: "lib-mixed", paths: ["/srv/more", "/Users/ozzy/Documents/Shows"], usePolling: true },
    ]);
  });

  it("planWatch reports each watched library's backend on the info channel, never on the warning channel", async () => {
    const log = vi.fn();
    const info = vi.fn();
    await planWatch(
      [
        { id: "lib-desktop", paths: ["/Users/ozzy/Desktop/Movies"] },
        { id: "lib-local", paths: ["/srv/media", "/srv/more"] },
      ],
      { platform: "darwin", env: {}, probePath: () => Promise.resolve(), log, info }
    );
    expect(log).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("worker: watching library lib-desktop — 1 path, stat polling");
    expect(info).toHaveBeenCalledWith("worker: watching library lib-local — 2 paths, native events");
  });

  it("planWatch decides polling on the RESOLVED path — `..` segments and symlinks into a protected root count", async () => {
    const plan = await planWatch(
      [
        { id: "lib-dotdot", paths: ["/Users/ozzy/Movies/../Desktop/Movies"] },
        { id: "lib-symlink", paths: ["/Users/ozzy/Movies"] },
        { id: "lib-plain", paths: ["/Users/ozzy/Media"] },
      ],
      {
        platform: "darwin",
        env: {},
        probePath: () => Promise.resolve(),
        // /Users/ozzy/Movies is a symlink into Desktop; everything else is itself.
        realpathPath: (path) => Promise.resolve(path === "/Users/ozzy/Movies" ? "/Users/ozzy/Desktop/Movies" : path),
        info: () => undefined,
      }
    );
    expect(plan.map((e) => [e.libraryId, e.usePolling])).toEqual([
      ["lib-dotdot", true],
      ["lib-symlink", true],
      ["lib-plain", false],
    ]);
    // chokidar still receives the configured strings, not the resolved ones.
    expect(plan.map((e) => e.paths[0])).toEqual(["/Users/ozzy/Movies/../Desktop/Movies", "/Users/ozzy/Movies", "/Users/ozzy/Media"]);
  });

  it("planWatch: a missing path canonicalizes through its parent; a realpath that never answers falls back to the plain resolution", async () => {
    const never = new Promise<string>(() => undefined);
    const plan = await planWatch(
      [
        { id: "lib-missing-under-link", paths: ["/Users/ozzy/Movies/New"] },
        { id: "lib-silent-realpath", paths: ["/Users/ozzy/Desktop/../Documents/Shows"] },
      ],
      {
        platform: "darwin",
        env: {},
        probeTimeoutMs: 50,
        probePath: (path) => (path === "/Users/ozzy/Movies/New" ? Promise.reject(new Error("ENOENT: no such file or directory")) : Promise.resolve()),
        realpathPath: (path) => (path === "/Users/ozzy/Movies" ? Promise.resolve("/Users/ozzy/Desktop/Movies") : never),
        info: () => undefined,
      }
    );
    expect(plan.map((e) => [e.libraryId, e.usePolling])).toEqual([
      ["lib-missing-under-link", true],
      ["lib-silent-realpath", true],
    ]);
  });

  it("planWatch on linux leaves the same paths on native watching", async () => {
    const plan = await planWatch([{ id: "lib", paths: ["/Users/ozzy/Desktop/Movies"] }], {
      platform: "linux",
      env: {},
      probePath: () => Promise.resolve(),
      realpathPath: (path) => Promise.resolve(path),
      info: () => undefined,
    });
    expect(plan).toEqual([{ libraryId: "lib", paths: ["/Users/ozzy/Desktop/Movies"], usePolling: false }]);
  });
});

describe("watcher thread isolation (SPF-14)", () => {
  it("a thread wedged before acknowledging (a blocked native watch open) cannot wedge startWatcher, the event loop, or stop()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-wedged-"));
    // The main thread must keep ticking while the watcher thread is stuck.
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const log = vi.fn();
      const startedAt = Date.now();
      const handle = await startWatcher([{ id: "lib-wedged", paths: [dir] }], {
        onChange: () => undefined,
        log,
        threadAckTimeoutMs: 200,
        stopTimeoutMs: 200,
        resolveThreadSpawn: () => ({ url: WEDGED_THREAD_URL, execArgv: [] }),
      });
      handles.push(handle);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // The plan is the truth about what was handed over, wedged or not.
      expect(handle.watchedLibraryIds).toEqual(["lib-wedged"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("has not acknowledged its watch plan"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("jobs are unaffected"));
      expect(handle.abandoned).toBe(false);

      // Liveness, as the process 'exit' hook reads it: a freshly spawned thread
      // is within its grace; the same silence past the grace is unresponsive.
      expect(liveWatcherThreadCount()).toBe(1);
      expect(hasUnresponsiveWatcherThread()).toBe(false);
      expect(hasUnresponsiveWatcherThread(Date.now() + THREAD_UNRESPONSIVE_MS + 1)).toBe(true);

      const stopStartedAt = Date.now();
      const firstStop = handle.stop();
      // Idempotent: a second caller shares the same stop, no second timer.
      expect(handle.stop()).toBe(firstStop);
      await firstStop;
      expect(Date.now() - stopStartedAt).toBeLessThan(3_000);
      expect(handle.abandoned).toBe(true);
      // Abandoned → unresponsive right now, whatever the clock says.
      expect(hasUnresponsiveWatcherThread()).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("did not stop within"));
      expect(log.mock.calls.filter((c) => String(c[0]).includes("did not stop within"))).toHaveLength(1);
      expect(ticks).toBeGreaterThan(10);
      // terminate() does interrupt Atomics.wait (unlike a real blocked
      // syscall), so the registry empties — nothing leaks into later tests.
      await threadsGone();
      expect(hasUnresponsiveWatcherThread()).toBe(false);
    } finally {
      clearInterval(heartbeat);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a thread that dies before acknowledging is logged; startWatcher resolves, ready settles, stop() is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-crash-"));
    try {
      const log = vi.fn();
      const handle = await startWatcher([{ id: "lib-crash", paths: [dir] }], {
        onChange: () => undefined,
        log,
        threadAckTimeoutMs: 5_000,
        resolveThreadSpawn: () => ({ url: CRASHING_THREAD_URL, execArgv: [] }),
      });
      handles.push(handle);
      await expect(handle.ready).resolves.toBe("gone");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("injected module-load crash"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("watcher thread exited"));
      await handle.stop();
      expect(handle.abandoned).toBe(false);
      await threadsGone();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nothing watchable → no thread at all: ready is already settled and stop() is immediate", async () => {
    const handle = await startWatcher([{ id: "lib-empty", paths: [] }], { onChange: () => undefined });
    handles.push(handle);
    expect(handle.watchedLibraryIds).toEqual([]);
    await expect(handle.ready).resolves.toBe("ready");
    await handle.stop();
    expect(handle.abandoned).toBe(false);
  });

  it("a healthy thread acknowledges, reports ready, delivers debounced changes, and stops cleanly (no abandonment)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-healthy-"));
    try {
      const onChange = vi.fn();
      const log = vi.fn();
      const handle = await startWatcher([{ id: "lib-healthy", paths: [dir] }], {
        onChange,
        log,
        debounceMs: 100,
        env: { LOOMBRE_SCAN_POLL: "1" },
      });
      handles.push(handle);
      await expect(handle.ready).resolves.toBe("ready");
      // A healthy, heartbeating thread is joinable — never "unresponsive".
      expect(hasUnresponsiveWatcherThread()).toBe(false);
      writeFileSync(join(dir, "a.mkv"), "x");
      writeFileSync(join(dir, "b.mkv"), "y");
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("lib-healthy"), { timeout: 5_000 });
      await handle.stop();
      expect(handle.abandoned).toBe(false);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("did not stop"));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("has not acknowledged"));
      await threadsGone();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing or rejecting onChange is contained and logged; later events still arrive (scripted thread)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-watcher-scripted-"));
    try {
      const log = vi.fn();
      const seen: number[] = [];
      let calls = 0;
      const handle = await startWatcher([{ id: "lib-x", paths: [dir] }], {
        onChange: () => {
          calls += 1;
          seen.push(calls);
          if (calls === 1) throw new Error("sync boom");
          if (calls === 2) return Promise.reject(new Error("async boom"));
          return undefined;
        },
        log,
        resolveThreadSpawn: () => ({ url: SCRIPTED_THREAD_URL, execArgv: [] }),
      });
      handles.push(handle);
      await vi.waitFor(() => expect(seen).toEqual([1, 2, 3]), { timeout: 5_000 });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("watch onChange for library lib-x threw: sync boom"));
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("watch onChange for library lib-x failed: async boom")), { timeout: 5_000 });
      await handle.stop();
      expect(handle.abandoned).toBe(false);
      await threadsGone();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handle.ready aggregates across libraries: one library never ready keeps it pending; stop() then settles it as gone", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "loombre-watcher-agg-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "loombre-watcher-agg-b-"));
    try {
      const handle = await startWatcher(
        [
          { id: "lib-a", paths: [dirA] },
          { id: "lib-b", paths: [dirB] },
        ],
        {
          onChange: () => undefined,
          log: () => undefined,
          resolveThreadSpawn: () => ({ url: SCRIPTED_THREAD_URL, execArgv: [] }),
        }
      );
      handles.push(handle);
      // The script reports lib-a ready and never lib-b.
      const early = await Promise.race([handle.ready, new Promise<"pending">((r) => setTimeout(() => r("pending"), 300))]);
      expect(early).toBe("pending");
      await handle.stop();
      await expect(handle.ready).resolves.toBe("gone");
      await threadsGone();
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
