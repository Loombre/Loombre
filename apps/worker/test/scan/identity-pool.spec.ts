// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/identity-pool.spec.ts
//
// AUD-A2d-002 — before the fix, a worker-thread crash left its pool slot
// dead forever: every hash routed to it (round-robin, so 1-in-poolSize of
// every future call) silently never settled — the caller's Promise just
// hung, permanently. Failure was silent AND permanent, worse than a loud
// one. This proves the fix from BOTH angles the finding calls out:
//   (a) the hash that was in flight ON the crashing thread SETTLES
//       (rejects — the thread is genuinely gone, nothing to resolve with)
//       instead of hanging.
//   (b) a hash issued AFTER the crash, round-robined onto that SAME now-
//       healed slot, still completes.
// Uses the pool's `resolveWorkerSpawn` test seam (see support/
// crash-worker.mjs) to crash a REAL worker_threads thread on command,
// rather than relying on hash.ts's own error path (which can't reach
// this: hash-worker.ts turns every per-file error into a normal
// {id, error} reply, never a thread crash).
//
// No test overrides vitest's project default timeout — apps/worker/
// vitest.config.ts already scales it for slow CI runners, and this fixture
// does no real I/O, so the default is comfortably bounded: a regression
// (the slot staying dead) hangs the awaited promise and the test fails via
// that timeout rather than hanging CI indefinitely.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHashPool } from "../../src/scan/identity/pool.js";

const CRASH_WORKER_URL = new URL("./support/crash-worker.mjs", import.meta.url);
const CRASH_ON_LOAD_WORKER_URL = new URL("./support/crash-on-load-worker.mjs", import.meta.url);

function crashInjectingSpawn() {
  return { url: CRASH_WORKER_URL, execArgv: [] };
}

describe("createHashPool — worker-thread crash recovery", () => {
  it("settles the in-flight hash on a crashed slot (rejects, does not hang) and still completes a hash issued after the crash", async () => {
    // poolSize=1 makes round-robin dispatch deterministic: both calls in
    // this test are guaranteed to land on the one slot under test, before
    // and after it is healed.
    const pool = createHashPool(1, { resolveWorkerSpawn: crashInjectingSpawn });
    try {
      await expect(pool.hashFile("__CRASH__", 0)).rejects.toThrow();

      await expect(pool.hashFile("/media/after-crash.mkv", 123)).resolves.toBe(
        "echo:/media/after-crash.mkv",
      );
    } finally {
      await pool.terminate();
    }
  });
});

// Opus review of Wave 1 (FW1-C, AUD-A2d-002 fix) — REGRESSION: healSlot()
// respawned a crashed slot with no cap, no backoff, and no logging. The
// reviewer drove this exact pool through its own resolveWorkerSpawn seam
// against a worker that throws at module load and measured ~74 Worker
// spawns in 2 seconds, never stopping — a process-lifetime thread-spawn
// storm (the pool is created once at worker startup, apps/worker/src/
// index.ts:110), and in the OOM case named by healSlot's own comment,
// spinning right back into the memory pressure that caused the crash.
//
// crash-on-load-worker.mjs crashes entirely on its own the instant it is
// spawned — no hashFile() call is needed to trigger it — so simply
// creating the pool is enough to start (and, post-fix, stop) the storm.
describe("createHashPool — respawn-storm cap (regression: FW1-C review)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds consecutive respawns, marks the slot permanently dead, logs every heal, and still lets a healthy dispatch reject cleanly", async () => {
    let spawnCount = 0;
    function countingCrashOnLoadSpawn() {
      spawnCount++;
      return { url: CRASH_ON_LOAD_WORKER_URL, execArgv: [] };
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pool = createHashPool(1, { resolveWorkerSpawn: countingCrashOnLoadSpawn });
    try {
      // Bounded poll for the storm to run its own course and the slot to
      // go permanently dead — NOT driven by dispatching hashFile() (which
      // would itself race the slot's worker-null window and could hang on
      // the very bug this fix removes). A hard deadline means a
      // regression (unbounded respawns, no permanent-death transition)
      // fails this assertion fast instead of hanging CI.
      const deadline = Date.now() + 5_000;
      let wentPermanentlyDead = false;
      while (Date.now() < deadline) {
        wentPermanentlyDead = errorSpy.mock.calls.some(
          ([msg]) => typeof msg === "string" && /permanently dead/i.test(msg),
        );
        if (wentPermanentlyDead) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // (a) hard ceiling — nowhere near the ~74-in-2s the regression
      // produced, and strictly more than 1 (proves it actually tried to
      // heal at least once, not that spawning itself is broken).
      expect(spawnCount).toBeGreaterThan(1);
      expect(spawnCount).toBeLessThanOrEqual(10);

      // (b) the slot ends up permanently dead ...
      expect(wentPermanentlyDead).toBe(true);
      // ... and every dispatch to it rejects with a clear, specific error
      // instead of hanging or silently vanishing. By this point `dead` is
      // already true (set synchronously before the log line above), so
      // this rejects immediately with no race against the worker field.
      await expect(pool.hashFile("/media/after-storm.mkv", 1)).rejects.toThrow(
        /permanently dead/i,
      );

      // (c) console.error fired on every heal, not just the terminal one
      // — pre-fix this scenario was 100% silent. Every spawned worker
      // here crashes and heals exactly once (spawnCount healed calls),
      // plus one extra line announcing the permanent-death transition.
      expect(errorSpy).toHaveBeenCalledTimes(spawnCount + 1);
    } finally {
      await pool.terminate();
    }
  }, 15_000);
});

// Opus review of Wave 1 (FW1-C, AUD-A2d-002 fix) — SECOND regression,
// introduced by the respawn-storm-cap fix itself: hashFile() computed
// `slotIndex = nextWorkerIndex % slots.length` and only THEN checked
// `health.dead`. With poolSize=N and exactly one permanently-dead slot,
// every dispatch that landed on that slot's index rejected — forever,
// deterministically 1-in-N of every future hash — even though the other
// N-1 slots were perfectly healthy. The reviewer confirmed the shape
// empirically: with all 3 slots dead, dispatches 0/1/2 each rejected on
// their own index. The fix walks forward from nextWorkerIndex, skipping
// any dead slot, and rejects only once EVERY slot has been tried and
// found dead — see pool.ts's hashFile().
describe("createHashPool — dead-slot rotation (regression: opus review, P1-dead-slot-rotation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes MANY consecutive hashes around a single permanently-dead slot — all of them succeed on the healthy survivors", async () => {
    const poolSize = 3;
    const deadSlotIndex = 1;
    let spawnCount = 0;
    // The first `poolSize` spawn calls are the pool's initial slots
    // 0..N-1, in order (the constructor loop is synchronous, so these
    // can't interleave with any heal timer). Every spawn call AFTER that
    // is necessarily a respawn of `deadSlotIndex` — it is the only slot
    // that ever crashes here, so slots 0 and 2 never trigger healSlot.
    function spawnWithOneDeadSlot() {
      const callIndex = spawnCount++;
      const isDeadSlot = callIndex < poolSize ? callIndex === deadSlotIndex : true;
      return isDeadSlot
        ? { url: CRASH_ON_LOAD_WORKER_URL, execArgv: [] }
        : { url: CRASH_WORKER_URL, execArgv: [] };
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pool = createHashPool(poolSize, { resolveWorkerSpawn: spawnWithOneDeadSlot });
    try {
      // Bounded poll for slot 1 to finish its own respawn storm and go
      // permanently dead — same pattern as the respawn-storm-cap test
      // above; a hard deadline means a regression fails fast instead of
      // hanging CI.
      const deadline = Date.now() + 5_000;
      let wentPermanentlyDead = false;
      while (Date.now() < deadline) {
        wentPermanentlyDead = errorSpy.mock.calls.some(
          ([msg]) => typeof msg === "string" && /permanently dead/i.test(msg),
        );
        if (wentPermanentlyDead) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(wentPermanentlyDead).toBe(true);

      // Pre-fix, every 3rd of these (the ones round-robined onto index 1)
      // rejected forever — a fixed, deterministic 1-in-3 failure rate on
      // an otherwise fully-healthy pool. Post-fix, slots 0 and 2 absorb
      // the dead slot's share and every single dispatch succeeds. Several
      // full rotations past poolSize, not just one, so this can't pass by
      // accident of where nextWorkerIndex happens to start.
      const attempts = poolSize * 10;
      for (let i = 0; i < attempts; i++) {
        await expect(pool.hashFile(`/media/file-${i}.mkv`, i)).resolves.toBe(
          `echo:/media/file-${i}.mkv`,
        );
      }
    } finally {
      await pool.terminate();
    }
  }, 15_000);

  it("rejects only once EVERY slot is dead — not one-in-N of the time", async () => {
    const poolSize = 3;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createHashPool(poolSize, {
      resolveWorkerSpawn: () => ({ url: CRASH_ON_LOAD_WORKER_URL, execArgv: [] }),
    });
    try {
      // All three slots crash on load and independently run their own
      // respawn-storm cap; wait for all three to reach permanent death.
      const deadline = Date.now() + 8_000;
      let deadCount = 0;
      while (Date.now() < deadline) {
        deadCount = errorSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string" && /permanently dead/i.test(msg),
        ).length;
        if (deadCount >= poolSize) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(deadCount).toBe(poolSize);

      // Only NOW, with nowhere left to route to, should dispatch reject —
      // and it should say so plainly (pool exhausted), not point at
      // whichever slot the round-robin counter happened to land on.
      for (let i = 0; i < poolSize; i++) {
        await expect(pool.hashFile(`/media/file-${i}.mkv`, i)).rejects.toThrow(
          /all \d+ hash-worker slots are permanently dead/i,
        );
      }
    } finally {
      await pool.terminate();
    }
  }, 20_000);
});
