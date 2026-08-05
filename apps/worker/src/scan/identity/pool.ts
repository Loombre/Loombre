// SPDX-License-Identifier: AGPL-3.0-only
/**
 * worker_threads pool for content-hashing (docs/PLAN.md §9.2, CLAUDE.md
 * invariant 9). Round-robins hashFile() requests across a fixed set of
 * long-lived worker threads (./hash-worker.ts), each request tagged with a
 * monotonic id so out-of-order replies (a large file's hash taking longer
 * than a small one queued after it) resolve the correct caller.
 *
 * Pool size comes from the caller (the scan job handler, apps/worker/src/
 * index.ts, re-resolves scanner.concurrency — Addendum A registry,
 * packages/shared/src/settings-registry.ts — fresh at the start of every
 * scan job via apps/worker/src/settings/effective-settings.ts's
 * resolveScanConcurrencyFromEffective(), default max(2, cpus/2) absent any
 * env pin/DB override, per the task's concurrency-cap mandate); this
 * module has no opinion on sizing itself.
 *
 * Trade-off, spelled out (opus review of Wave 1, FW1-C): once a slot is
 * marked permanently dead (see the respawn-storm guard below), dispatch
 * rotates around it forever — a scan degrades gracefully rather than
 * failing outright — but that dead slot has NO recovery path short of a
 * worker-process restart (a fresh createHashPool call, apps/worker/src/
 * index.ts) or a scanner.concurrency change (which replaces the whole
 * pool). And the only operator-visible symptom of the degradation is the
 * one console.error line healSlot logs at the moment of permanent death —
 * there is no metric, no health check, nothing else that surfaces "this
 * pool is now running one thread short." Accepted deliberately: silent-
 * but-slower beats the alternative this same wave fixed (a fixed fraction
 * of every scan's files rejecting forever), but it is still silent.
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HashPool {
  hashFile(filePath: string, sizeBytes: number): Promise<string>;
  terminate(): Promise<void>;
}

interface PendingEntry {
  /** Which slot index this request was dispatched to — lets a crashed
   * slot's cleanup reject only the work actually routed to IT, not every
   * in-flight request across the whole pool (see healSlot below). */
  slotIndex: number;
  resolve: (hash: string) => void;
  reject: (err: Error) => void;
}

interface WorkerSlot {
  /** Null between a crash and its (possibly backoff-delayed) respawn, and
   * forever once the slot is permanently dead — see healSlot below.
   * hashFile() checks slotHealth[index].dead BEFORE ever reading this
   * field, so a null worker on a dead slot is never actually
   * dereferenced; it is null there too only so terminate() has one shape
   * to iterate over. */
  worker: Worker | null;
}

/** Per-slot crash bookkeeping for the respawn-storm guard — see the
 * MAX_CONSECUTIVE_HEALS block below healSlot's own comment. */
interface SlotHealth {
  consecutiveHeals: number;
  /** Date.now() of the first heal in the current consecutive streak. A
   * heal arriving more than HEAL_WINDOW_MS after this resets the streak
   * instead of extending it — a lone crash months apart from another
   * shouldn't count against the slot alongside a fresh one. */
  windowStart: number;
  dead: boolean;
}

const JS_WORKER_URL = new URL("./hash-worker.js", import.meta.url);
const TS_WORKER_URL = new URL("./hash-worker.ts", import.meta.url);

/**
 * Resolves how to spawn the hash-worker thread across three runtimes this
 * repo actually runs in:
 *   - production (`tsc build` + `node dist/...`): dist/scan/identity/
 *     hash-worker.js exists (tsc mirrors the whole src/ tree per-file), so
 *     the plain compiled-JS path is used directly — cheapest, no extra
 *     loader.
 *   - `tsx watch`/`tsx` dev: only hash-worker.ts exists on disk. tsx's own
 *     process-wide loader hook makes `new Worker(new URL('./x.js', ...))`
 *     transparently resolve to `x.ts` (verified empirically while building
 *     this module), so the .js URL would actually still work here — BUT
 *     that resolution is a property of the PARENT process's loader
 *     registration, not something this module can assume in general (see
 *     vitest below), so it is not relied on.
 *   - `vitest run` (this package's own test suite): test files run through
 *     vite-node's module transform, which does NOT propagate any loader
 *     hook to a plain `node:worker_threads` Worker — spawning the .js URL
 *     here 404s (no build has run) and the worker fails to start. Passing
 *     `execArgv: ['--import', 'tsx']` makes the freshly spawned OS thread
 *     register tsx's loader for itself, independent of whatever the
 *     parent process is doing, so it can load hash-worker.ts directly.
 * `existsSync` is a one-time, synchronous, tiny disk check — negligible
 * next to spawning a worker thread at all.
 */
function resolveWorkerSpawn(): { url: URL; execArgv: string[] } {
  if (existsSync(fileURLToPath(JS_WORKER_URL))) {
    return { url: JS_WORKER_URL, execArgv: [] };
  }
  return { url: TS_WORKER_URL, execArgv: ["--import", "tsx"] };
}

/** Test-only override seam. Production always uses `resolveWorkerSpawn`
 * above; only apps/worker/test/scan/identity-pool.spec.ts (AUD-A2d-002)
 * passes a `resolveWorkerSpawn` override, pointed at a crash-on-demand
 * fixture worker, so it can crash a REAL worker_threads thread
 * deterministically and prove the pool heals — hash-worker.ts's own
 * hashFile() pipeline turns every per-file error into a normal
 * `{id, error}` reply (see its header), so it can never reach the actual
 * thread-crash path this seam exists to test. Same philosophy as the
 * `StashAdapterDeps.openDirectOnce` seam in ../../stash/adapter.ts:
 * deterministic injection beats trying to reproduce a real crash's timing.
 */
export interface HashPoolDeps {
  resolveWorkerSpawn?: () => { url: URL; execArgv: string[] };
}

// --- Respawn-storm guard --------------------------------------------------
// healSlot() originally respawned a crashed slot unconditionally,
// synchronously, with no cap and no log line. A crash-LOOPING worker
// (module-load failure, OOM — the two triggers healSlot's own comment
// already names) respawned straight back into the same failure forever,
// as fast as Node could spin up threads: measured empirically at ~74
// spawns in 2 seconds against a worker that throws at module load, never
// slowing down. Because this pool is created once at worker-process
// startup (apps/worker/src/index.ts) and only replaced when scan
// concurrency changes, that storm isn't bounded by a scan job — it's a
// PROCESS-LIFETIME thread-spawn storm. In the OOM case specifically, it
// respawns straight back into the memory pressure that caused the crash
// in the first place, ~37x/sec, forever.
//
// Three-part fix, all scoped per slot (a storm on one slot must not
// touch the others):
//   - MAX_CONSECUTIVE_HEALS: once a slot has healed this many times
//     inside HEAL_WINDOW_MS of each other, it is marked permanently
//     dead — no further respawn is attempted, and every future dispatch
//     to that slot index rejects immediately with a specific,
//     unambiguous error. Never silently degrades, never keeps retrying
//     into the same failure.
//   - Backoff: the FIRST heal in a fresh window respawns immediately
//     (preserves the original single-transient-crash-recovers-instantly
//     behavior, and keeps the pre-existing "in-flight settles, next hash
//     completes" test passing unchanged), but every heal after that
//     inside the same window waits, doubling each time up to
//     MAX_BACKOFF_MS, before respawning — a fast crash loop cannot spin
//     a CPU core or hammer OOM-adjacent memory pressure.
//   - console.error on every heal, and on the terminal dead transition:
//     pre-fix, a worker dying with no in-flight work to reject was 100%
//     silent — nothing anywhere recorded that a hash thread had died.
const MAX_CONSECUTIVE_HEALS = 5;
const HEAL_WINDOW_MS = 10_000;
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 2_000;

export function createHashPool(size: number, deps: HashPoolDeps = {}): HashPool {
  const spawnWorker = deps.resolveWorkerSpawn ?? resolveWorkerSpawn;
  const poolSize = Math.max(1, Math.floor(size));
  const slots: WorkerSlot[] = [];
  const slotHealth: SlotHealth[] = [];
  const pending = new Map<number, PendingEntry>();
  let nextId = 0;
  let nextWorkerIndex = 0;
  let terminated = false;

  // AUD-A2d-002: a worker-level crash (module-load failure, OOM — never a
  // per-file error; hash-worker.ts's own message handler already turns
  // those into a normal {id, error} reply) used to leave `slots[index]`
  // pointed at a dead Worker forever. `postMessage` on an already-exited
  // worker is a silent no-op (verified empirically, Node 24: no throw, no
  // event, nothing) — every future hashFile() round-robined onto that slot
  // would post into the void and its Promise would never settle, hanging
  // its caller permanently. healSlot fixes both halves: it settles (by
  // REJECTING, not retrying — see below) every request already in flight
  // on the dead thread, and replaces `slots[index]` in place so the next
  // dispatch to this index reaches a live worker again.
  //
  // reject, not retry: the only real caller, apps/worker/src/scan/
  // scanner.ts's processOneFile, already runs inside the walk loop's own
  // per-file try/catch (scanner.ts's runScan, `catch (err) { firstError
  // ??= ... }` then `continue`s to the next file) — a rejected hashFile()
  // already degrades to "skip this one file, keep scanning", which is
  // the correct behavior for a rare, non-transient failure (the crash
  // means the WORKER is gone, not that this one file is bad; there is
  // nothing about retrying the same content against a freshly-spawned
  // worker that a future scan attempt doesn't already give you for free).
  // Retrying inside the pool would duplicate that resilience at a second
  // layer for no benefit and risk masking a genuinely broken worker
  // script behind repeated silent respawns.
  function healSlot(index: number, cause: Error): void {
    if (terminated) return; // pool.terminate() tore this worker down on purpose
    for (const [id, entry] of pending.entries()) {
      if (entry.slotIndex !== index) continue; // another slot's work — untouched
      pending.delete(id);
      entry.reject(cause);
    }
    slots[index] = { worker: null }; // not routable again until respawned (or dead)

    const health = slotHealth[index]!;
    const now = Date.now();
    if (now - health.windowStart > HEAL_WINDOW_MS) {
      // Either the very first heal ever, or the previous one was long
      // enough ago that this is a fresh, unrelated crash — start a new
      // streak rather than extending a stale one.
      health.windowStart = now;
      health.consecutiveHeals = 0;
    }
    health.consecutiveHeals++;

    console.error(
      `createHashPool: hash-worker slot ${index} crashed (heal ${health.consecutiveHeals}/${MAX_CONSECUTIVE_HEALS} within ${HEAL_WINDOW_MS}ms): ${cause.message}`,
    );

    if (health.consecutiveHeals >= MAX_CONSECUTIVE_HEALS) {
      health.dead = true;
      console.error(
        `createHashPool: hash-worker slot ${index} exceeded ${MAX_CONSECUTIVE_HEALS} consecutive crashes within ${HEAL_WINDOW_MS}ms — marking it PERMANENTLY DEAD, no further respawns will be attempted`,
      );
      return; // do not respawn — see hashFile's slotHealth.dead check
    }

    // First heal in a streak respawns immediately — a lone transient
    // crash recovers at the original speed. Every heal after that inside
    // the same window backs off, doubling, so a fast crash loop cannot
    // spin.
    const backoffMs =
      health.consecutiveHeals <= 1
        ? 0
        : Math.min(BASE_BACKOFF_MS * 2 ** (health.consecutiveHeals - 2), MAX_BACKOFF_MS);
    const respawn = (): void => {
      if (terminated || health.dead) return; // torn down, or died while waiting
      slots[index] = makeWorkerSlot(index);
    };
    if (backoffMs === 0) {
      respawn();
    } else {
      setTimeout(respawn, backoffMs).unref();
    }
  }

  function makeWorkerSlot(index: number): WorkerSlot {
    const spawn = spawnWorker();
    const worker = new Worker(spawn.url, spawn.execArgv.length > 0 ? { execArgv: spawn.execArgv } : {});
    // Guards against healing twice for the SAME crash: an uncaught
    // exception in the worker fires 'error' and THEN 'exit' on this same
    // Worker instance, and only the first of the two should reject
    // pending work / spawn the replacement.
    let healed = false;
    function healOnce(cause: Error): void {
      if (healed) return;
      healed = true;
      healSlot(index, cause);
    }
    worker.on("message", (msg: { id: number; contentHash: string } | { id: number; error: string }) => {
      const entry = pending.get(msg.id);
      if (!entry) return; // already settled/terminated
      pending.delete(msg.id);
      if ("error" in msg) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.contentHash);
      }
    });
    worker.on("error", (err) => {
      // A worker-level (not task-level) failure — see healSlot above.
      healOnce(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on("exit", (code) => {
      // Covers a crash that skips 'error' entirely (e.g. the thread is
      // killed, or calls process.exit() directly) — anything OTHER than
      // this module's own deliberate `worker.terminate()` in terminate()
      // below, which sets `terminated` first specifically so this handler
      // no-ops for an intentional shutdown.
      healOnce(new Error(`createHashPool: worker thread exited unexpectedly (code ${code})`));
    });
    return { worker };
  }

  for (let i = 0; i < poolSize; i++) {
    slots.push(makeWorkerSlot(i));
    slotHealth.push({ consecutiveHeals: 0, windowStart: 0, dead: false });
  }

  return {
    hashFile(filePath: string, sizeBytes: number): Promise<string> {
      if (terminated) {
        return Promise.reject(new Error("createHashPool: pool already terminated"));
      }
      const id = nextId++;

      // Dead-slot rotation (opus review of Wave 1, FW1-C — a regression
      // introduced by the respawn-storm-cap fix itself): dispatch used to
      // compute slotIndex = nextWorkerIndex % slots.length and only THEN
      // check health.dead, so with poolSize=N and exactly one permanently
      // -dead slot, every dispatch that landed on that slot's index
      // rejected — forever, a fixed 1-in-N failure rate on an otherwise
      // fully-healthy pool. Walk forward from nextWorkerIndex instead,
      // skipping any slot already marked dead, and give up only once
      // every slot has been tried and found dead. nextWorkerIndex is a
      // single counter that just keeps incrementing (never resets, same
      // as before the fix), so skipping a dead index naturally falls back
      // to plain round-robin over whatever slots remain healthy — see
      // identity-pool.spec.ts's "dead-slot rotation" tests.
      let slotIndex = -1;
      for (let tried = 0; tried < slots.length; tried++) {
        const candidate = nextWorkerIndex % slots.length;
        nextWorkerIndex++;
        if (!slotHealth[candidate]!.dead) {
          slotIndex = candidate;
          break;
        }
      }
      if (slotIndex === -1) {
        return Promise.reject(
          new Error(
            `createHashPool: all ${slots.length} hash-worker slots are permanently dead — pool exhausted, not dispatched`,
          ),
        );
      }
      const slot = slots[slotIndex]!;
      if (!slot.worker) {
        // Between a crash and its (possibly backoff-delayed) respawn: the
        // old worker is already gone, and postMessage on an exited worker
        // is a silent no-op (see healSlot's header comment above) —
        // reject now, loudly, rather than post into the void and hang
        // the caller until the respawn eventually lands.
        return Promise.reject(
          new Error(
            `createHashPool: hash-worker slot ${slotIndex} is recovering from a crash (respawn backoff in progress) — not dispatched`,
          ),
        );
      }
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { slotIndex, resolve, reject });
        slot.worker!.postMessage({ id, filePath, sizeBytes });
      });
    },

    async terminate(): Promise<void> {
      terminated = true;
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(new Error("createHashPool: terminated while a hash was in flight"));
      }
      await Promise.all(slots.map((s) => (s.worker ? s.worker.terminate() : Promise.resolve())));
      slots.length = 0;
      slotHealth.length = 0;
    },
  };
}

// Re-exported so callers that only need the byte-range/hash rule (e.g. a
// single-file resume check) don't have to spin up a pool for one file.
export { hashFile } from "./hash.js";
