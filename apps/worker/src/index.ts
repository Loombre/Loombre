// SPDX-License-Identifier: AGPL-3.0-only
import { cpus } from "node:os";
import { createJobQueue } from "@loombre/jobs";
import { createDb, getCurrentHwCapabilitySnapshot, getLibraryStashConnection, workerApplicationName } from "@loombre/db";
import { listLibraries, listImagesNeedingDominantColor, hasQueuedOrActiveJobOfType } from "@loombre/db/internal";
import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { installCrashHandlers, installGracefulShutdown, type ShutdownSignal } from "./crash/index.js";
import { resolveWorkerDatabaseUrl } from "./db-url.js";
import { resolveWorkerDataDir } from "./crash/data-dir.js";
import { createTranscodeConsumerHandler, resolveTranscodeWorkerConcurrency } from "./transcode/index.js";
import { createSubtitleExtractConsumerHandler } from "./subtitles/index.js";
import { runScan } from "./scan/scanner.js";
import { createHashPool, type HashPool } from "./scan/identity/pool.js";
import { startWatcher, type WatcherHandle } from "./scan/watcher.js";
import { getWorkerSettingValue, loadWorkerEffectiveSettings, resolveScanConcurrencyFromEffective } from "./settings/effective-settings.js";
import { runProbe } from "./probe/consumer.js";
import { createProbeTerminalFailureHook } from "./probe/terminal-failure-hook.js";
import { createStashProvider } from "./metadata/providers/stash.js";
import { applyStashSceneMetadata } from "./stash/apply.js";
import { stashInventoryConsumerHandler } from "./stash/inventory-consumer.js";
import { stashSyncConsumerHandler, createStashSyncTerminalFailureHook } from "./stash/sync-consumer.js";
import { startStashScheduleLoop, type StashScheduleLoopHandle } from "./stash/schedule-loop.js";
import { startStashWatcher, type StashWatcherConnection } from "./stash/watcher.js";
import {
  ProviderRegistry,
  createMusicBrainzProvider,
  createTmdbProvider,
  createTvdbProvider,
  metadataConsumerHandler,
  metadataSearchConsumerHandler,
  resolveApiKeyWithKeyring,
} from "./metadata/index.js";
import { imageConsumerHandler, imageBackfillConsumerHandler } from "./image/index.js";
import { createImportConsumerHandler } from "./import/index.js";
import {
  assertHwPlatform,
  computeCurrentFingerprint,
  decideInvalidation,
  persistProbeReport,
  runRealHwProbeBattery,
} from "./hwcaps/index.js";
import { startPluginDeliveryLoop, type PluginDeliveryLoopHandle } from "./plugin-delivery/index.js";
import { createMailTerminalFailureHook, mailSendConsumerHandler } from "./mail/index.js";

// Lane G1 (STATE.md P4.14): installed as the FIRST thing this module does
// after its imports resolve — before createJobQueue()/createDb() below (or
// anything else that could theoretically throw synchronously at module-eval
// time) — so a crash here still produces a redacted local crash file rather
// than falling through to Node's bare default uncaught-exception behavior.
installCrashHandlers({
  dataDir: resolveWorkerDataDir(process.platform, process.env),
  version: LOOMBRE_VERSION_FULL,
  processName: "@loombre/worker",
});

// Resolution order lives in db-url.ts (P4.2 discovery seam): explicit
// DATABASE_URL -> installed embedded mode (LOOMBRE_DATA_DIR set: poll for
// the credentials apps/server's provisioner writes) -> the same dev
// compose fallback a bare `pnpm dev`/`node dist/index.js` always had.
// Top-level await: nothing below can exist without a database URL.
const DATABASE_URL = await resolveWorkerDatabaseUrl(process.env);

// Label the QUEUE's connection with this process's identity so the server
// can answer "is the worker running?" from pg_stat_activity instead of
// guessing from job-ledger activity (packages/db/src/query/worker-liveness.ts
// has the full rationale). pg-boss's pool is the right one to label: it
// polls continuously, so the connection persists while an ORDINARY pg pool
// closes its idle clients after ~10s and would make a healthy idle worker
// look dead — the exact false negative being fixed. It is also the more
// truthful signal, because it exists only while queue consumers are really
// registered and running.
const WORKER_STARTED_AT_MS = Date.now();
const queue = createJobQueue(DATABASE_URL, {
  applicationName: workerApplicationName(process.pid, WORKER_STARTED_AT_MS),
});
const db = createDb(DATABASE_URL);

// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): the hash
// worker_threads pool (scanner.concurrency, packages/shared/src/
// settings-registry.ts) is now re-resolved fresh at the START OF EVERY
// SCAN JOB (below) — not once at worker boot — via the worker-side
// effective-settings reader (./settings/effective-settings.ts), so a
// concurrency change applies to the NEXT scan job with no worker restart
// (requiresRestart:false; mid-job is deliberately NOT re-resolved — a
// resize mid-scan would mean tearing down worker threads a scan is
// actively using, which this lane judged not worth the complexity for a
// setting that only affects throughput, never correctness). "scan" itself
// stays concurrency:1 at the pg-boss level (unrelated to this setting —
// one full-library scan at a time per worker node; internal parallelism
// comes from the hash pool).
//
// probe/subtitle-extract job concurrency (pg-boss `work()` options,
// below) are a SEPARATE, STRUCTURAL number: pg-boss registers a
// consumer's concurrency once, at `queue.work()` call time, and there is
// no supported way to change it without restarting the worker process —
// genuinely restart-only, unlike the hash pool (which this module owns
// end-to-end and can freely tear down/recreate per job). These two never
// read LOOMBRE_SCAN_CONCURRENCY/scanner.concurrency at all (that reuse was
// incidental — the registry entry's own description scopes it to "the
// hash worker_threads pool ... during a library scan" only) — they use
// the SAME CPU-derived floor scanner.concurrency's registry default
// documents (max(2, cpus/2)) as a plain, unconditional boot-time heuristic,
// preserving today's actual behavior for the common no-env-override case
// without adding a second env-reading code path outside the registry.
function cpuDerivedConcurrencyFloor(): number {
  const cpuCount = cpus().length || 1;
  return Math.max(2, Math.floor(cpuCount / 2));
}

let hashPool: HashPool = createHashPool(cpuDerivedConcurrencyFloor());
let hashPoolSize = cpuDerivedConcurrencyFloor();

// Deliverable A: the real scanner (docs/PLAN.md §8.1/§8.2). One scan job at
// a time per worker node (concurrency: 1) — internal parallelism comes from
// the hash pool, not from racing two full-library scans' checkpoint
// bookkeeping against each other in the same process.
queue.work(
  "scan",
  async (payload, meta) => {
    const settingsResult = await loadWorkerEffectiveSettings(db);
    const jobScanConcurrency = resolveScanConcurrencyFromEffective(settingsResult);
    if (jobScanConcurrency !== hashPoolSize) {
      const staleHashPool = hashPool;
      hashPool = createHashPool(jobScanConcurrency);
      hashPoolSize = jobScanConcurrency;
      await staleHashPool.terminate();
    }
    const missingFileGraceHours = getWorkerSettingValue(settingsResult, "scanner.missingFileGraceHours", 72);
    await runScan({ db, queue, hashPool, missingFileGraceHours }, payload, meta);
  },
  { concurrency: 1 },
);

// Deliverable B: the real probe consumer (docs/PLAN.md §8.3/P1.5).
// onTerminalFailure (owner ledger L1, adjudication A-3): once retries are
// exhausted, writes an admin-only probe.failed outbox event — see
// ./probe/terminal-failure-hook.ts's header for the full architecture-
// honest rationale (the scanner never runs ffprobe itself; a terminal
// probe failure used to be invisible outside the generic jobs ledger).
queue.work(
  "probe",
  async (payload) => {
    await runProbe({ db }, payload);
  },
  { concurrency: cpuDerivedConcurrencyFloor(), onTerminalFailure: createProbeTerminalFailureHook(db) },
);

// Deliverable D: metadata providers behind the registry choke-point
// (P1.6/P1.7). Providers with missing API keys register but report
// disabled — the worker boots and scans fine without any keys (P1.9);
// the admin notice surfaces via registry.disabledProviders().
//
// Addendum A / A9: keys resolve env-first (A8 — env always wins), else
// from the keyring entry the admin settings screen writes (resolved here
// at boot; a newly saved key is used from the next worker restart). The
// resolved key is injected through the provider's existing deps.env seam
// so provider internals stay untouched and the value is never logged.
const registry = new ProviderRegistry();
const tmdbKey = await resolveApiKeyWithKeyring("LOOMBRE_TMDB_API_KEY", "tmdb");
const tvdbKey = await resolveApiKeyWithKeyring("LOOMBRE_TVDB_API_KEY", "tvdb");
registry.register(
  createTmdbProvider({
    db,
    ...(tmdbKey.enabled ? { env: { ...process.env, LOOMBRE_TMDB_API_KEY: tmdbKey.apiKey } } : {}),
  }),
);
registry.register(
  createTvdbProvider({
    db,
    ...(tvdbKey.enabled ? { env: { ...process.env, LOOMBRE_TVDB_API_KEY: tvdbKey.apiKey } } : {}),
  }),
);
registry.register(createMusicBrainzProvider({ db }));
// Stash SQLite metadata sync, K7: restricted-scoped, attaches per-library
// via library_provider_entries (never in provider-chain-defaults.ts's
// PROVIDER_CHAIN) — registered here alongside the other built-ins so a
// per-item refresh through the registry can resolve it by name.
registry.register(createStashProvider({ db }));
for (const notice of registry.disabledProviders()) {
  console.warn(`worker: metadata provider "${notice.name}" disabled — ${notice.reason}`);
}

queue.work(
  "metadata",
  metadataConsumerHandler({
    db,
    registry,
    enqueueImageJob: (payload) => queue.enqueue("image", payload),
  }),
  { concurrency: 2 },
);

// Phosphor retheme Wave 2 (Lane L2 — Fix Match): the bounded candidate-
// search job POST /admin/items/{id}/match-search enqueues. Shares the SAME
// registry instance as 'metadata' above (one set of provider clients per
// worker process) but its OWN PluginCircuitBreaker registry (default,
// omitted below) — a plugin provider's breaker state for automatic scan
// matching and for an admin's manual Fix Match search are tracked
// independently, so a breaker tripped by one never silently blocks the
// other. concurrency: 2 mirrors 'metadata' — same class of work (a few
// bounded outbound HTTP calls per job), same reasonable ceiling.
queue.work(
  "metadata-search",
  metadataSearchConsumerHandler({ db, registry }),
  { concurrency: 2 },
);

// Deliverable E (worker half): image ingest pipeline — pre-scaled variants
// + blurhash, all CPU work in worker_threads (P1.8 / Tier-0 law).
queue.work("image", imageConsumerHandler({ db }), { concurrency: 2 });

// Phase 3 §11 step 5: hardware capability self-test battery (docs/
// PLAYBACK.md §8.1). Runs synchronously within the job (the battery itself
// is the long-running work — CLAUDE.md invariant 6: nothing spawns ffmpeg
// inline from a REQUEST path; this is a queued job like every other
// consumer here, not an inline call). concurrency: 1 — a second concurrent
// probe run racing the first (e.g. two rapid boot-time enqueues on a
// restart loop) would just contend for the same temp workDir and waste
// CPU; the boot check's hasQueuedOrActiveJobOfType guard already prevents
// that stacking, this is defense in depth.
queue.work(
  "hwprobe",
  async () => {
    const report = await runRealHwProbeBattery();
    await persistProbeReport(db, report);
  },
  { concurrency: 1 },
);

// Phase 3 §11 step 6a: the real HLS transcode session runtime (docs/
// PLAYBACK.md §9) — REPLACES the old bespoke no-op `transcodeConsumer`
// stub (apps/worker/src/consumers/transcode.ts, deleted) that never went
// through the real @loombre/jobs queue at all. One job = one
// `playback_sessions` row; the handler's promise resolves only once that
// session reaches a terminal state (CLAUDE.md invariant 6). Concurrency is
// advisory only here — real admission control is Lane B's semaphore +
// 429 at session-CREATE time (apps/worker/src/transcode/index.ts's module
// header, §2/§8); this cap just bounds how many concurrent ffmpeg
// children ONE worker process will run.
queue.work(
  "transcode",
  createTranscodeConsumerHandler(db),
  { concurrency: resolveTranscodeWorkerConcurrency() },
);

// Phase 3 §11 step 6b (Lane B, P3.9(e)): segmented-VTT subtitle side-track
// extraction (apps/worker/src/subtitles/**) — a small, separate job type
// alongside 'transcode', enqueued whenever a session's plan carries
// `subtitle.strategy === 'hls-vtt'` (works for direct-play sessions too).
// Concurrency mirrors 'probe' (short-lived ffmpeg invocations, no
// throttle/suspend state to manage).
queue.work(
  "subtitle-extract",
  createSubtitleExtractConsumerHandler(db),
  { concurrency: cpuDerivedConcurrencyFloor() },
);

// Phase 4 lane E: the real data-freedom import consumer (docs/PLAN.md
// §8.4) — REPLACES the apps/server stub (apps/server/src/common/
// job-queue.provider.ts, deleted) that used to fail every 'import' job
// with `not-implemented-phase-2`. concurrency: 1 — an import is a single
// whole-archive transaction (see apps/worker/src/import/consumer.ts's
// module header); running two concurrently on one worker node buys nothing
// and only doubles memory/lock pressure for no benefit, same reasoning as
// the 'scan'/'hwprobe' consumers above.
queue.work("import", createImportConsumerHandler({ db }), { concurrency: 1 });

// P2.11: one-time dominant_color backfill for images rows that predate
// migrations/0005_images_dominant_color.sql. Same concurrency cap as the
// 'image' consumer above — it runs the same CPU-bound worker_thread decode,
// just for pre-existing rows instead of newly-ingested ones.
queue.work(
  "image-backfill",
  imageBackfillConsumerHandler({
    db,
    enqueueSelf: async (cursor) => {
      await queue.enqueue("image-backfill", { cursor });
    },
  }),
  { concurrency: 2 },
);

// Stash SQLite metadata sync, Lane C (S8): 'stash-inventory' is the cheap
// K10 pass (path/size/oshash rows only, bounded even at 33k scenes);
// 'stash-sync' is the full/incremental engine (checkpointed internally —
// see apps/worker/src/stash/sync-consumer.ts's own header for the
// checkpoint-pattern choice). Both concurrency:1, same reasoning as
// 'scan'/'import'/'hwprobe' above — one run per worker node at a time per
// job type; internal parallelism (if any) is the job's own, not a second
// concurrent run racing the same library's checkpoint/report bookkeeping.
//
// applyStashSceneMetadata is Lane B's REAL mapper (apps/worker/src/stash/
// apply.ts) — wired at integration exactly as K11 planned (this line was
// the stub during Lane C's parallel build; apply-types.ts's stub remains
// only as a test double).
queue.work("stash-inventory", stashInventoryConsumerHandler({ db }), { concurrency: 1 });
queue.work(
  "stash-sync",
  stashSyncConsumerHandler({
    db,
    applyStashSceneMetadata,
    enqueueImageJob: (payload) => queue.enqueue("image", payload),
  }),
  { concurrency: 1, onTerminalFailure: createStashSyncTerminalFailureHook(db) },
);

// Optional mail transport run (E6/M7): outbox-driven mail delivery.
// concurrency: 1 — a single worker node never holds open more than one
// SMTP connection at a time (mirrors 'import'/'stash-sync's "one run per
// worker node" reasoning; a personal mail server or relay is exactly the
// kind of target that benefits from not being hit concurrently).
// onTerminalFailure (E6/M6): once retries are exhausted, writes an
// admin-only mail.failed outbox event carrying the REAL SMTP error — see
// ./mail/terminal-failure-hook.ts's header for the deliberate deviation
// from probe.failed's closed-code posture.
queue.work("mail-send", mailSendConsumerHandler({ db }), { concurrency: 1, onTerminalFailure: createMailTerminalFailureHook(db) });

let watcherHandle: WatcherHandle | undefined;
let stashWatcherHandle: WatcherHandle | undefined;
let stashScheduleLoopHandle: StashScheduleLoopHandle | undefined;
let pluginDeliveryLoopHandle: PluginDeliveryLoopHandle | undefined;

// P1.3: chokidar watch per library path (polling fallback auto-enabled for
// network mounts — see ./scan/watcher.ts), debounced into incremental scan
// jobs. Best-effort at boot: a watcher-start failure (e.g. a library path
// that no longer exists) is logged, not fatal — the worker still serves
// scan/probe/image jobs either way.
async function startLibraryWatcher(): Promise<void> {
  try {
    const libraries = await listLibraries(db);
    watcherHandle = startWatcher(
      libraries.map((l) => ({ id: l.id, paths: l.paths })),
      {
        onChange: (libraryId) => {
          queue.enqueue("scan", { libraryId, full: false }).catch((err: unknown) => {
            console.error(`worker: failed to enqueue watch-triggered scan for library ${libraryId}:`, err);
          });
        },
      },
    );
  } catch (err) {
    console.error("worker: failed to start library watcher:", err);
  }
}

// Stash SQLite metadata sync, Lane C, deliverable 7(c): chokidar watch of
// each ENABLED library's Stash sqlite_path (+ -wal/-shm sidecars, WAL
// mode) — apps/worker/src/stash/watcher.ts's own header. Best-effort at
// boot, same posture as startLibraryWatcher immediately above: a
// per-library lookup failure never blocks the other watcher or the rest
// of the worker's boot sequence.
async function startStashLibraryWatcher(): Promise<void> {
  try {
    const libraries = await listLibraries(db);
    const connections: StashWatcherConnection[] = [];
    for (const library of libraries) {
      const connection = await getLibraryStashConnection(db, library.id);
      if (connection?.enabled) {
        connections.push({ libraryId: library.id, sqlitePath: connection.sqlite_path });
      }
    }
    if (connections.length === 0) return;

    stashWatcherHandle = startStashWatcher(connections, {
      onChange: (libraryId) => {
        queue.enqueue("stash-sync", { libraryId, mode: "incremental" }).catch((err: unknown) => {
          console.error(`worker: failed to enqueue watch-triggered stash-sync for library ${libraryId}:`, err);
        });
      },
    });
  } catch (err) {
    console.error("worker: failed to start Stash library watcher:", err);
  }
}

// P2.11: idempotent boot-time enqueue of the one-time dominant_color
// backfill. "Singleton key" semantics without touching packages/jobs'
// createJobQueue (out of this wave's edit scope, and it doesn't expose
// pg-boss's native singletonKey through EnqueueOptions anyway): consult the
// jobs ledger directly first, so a worker restart never stacks a second
// concurrent backfill run behind one that's already queued/active. Once
// every images row has a dominant_color (real or the backfill's own ''
// sentinel), listImagesNeedingDominantColor returns empty and this becomes
// a permanent no-op on every future boot.
async function enqueueImageBackfillIfNeeded(): Promise<void> {
  try {
    const alreadyPending = await hasQueuedOrActiveJobOfType(db, "image-backfill");
    if (alreadyPending) return;

    const pending = await listImagesNeedingDominantColor(db, { afterId: null, limit: 1 });
    if (pending.length === 0) return;

    await queue.enqueue("image-backfill", { cursor: null });
    console.log("worker: enqueued image-backfill (images rows pending dominant_color found)");
  } catch (err) {
    console.error("worker: failed to enqueue image-backfill:", err);
  }
}

// Phase 3 §11 step 5, STATE.md P3.5: boot-time hardware-capability
// invalidation check. Compares the CURRENT persisted snapshot for this
// platform (if any) against the freshly-resolved ffmpeg build hash + GPU
// fingerprint; missing or mismatched -> enqueue a 'hwprobe' job. Idempotent
// via the same hasQueuedOrActiveJobOfType pattern the image-backfill
// boot check above uses (P2.11 precedent) — a worker restart never stacks
// a second concurrent probe run behind one already queued/active. Every
// failure mode here (ffmpeg unresolved, an unsupported `os.platform()`
// value, a DB error) is logged and swallowed, never fatal to boot — the
// worker still serves scan/probe/image/metadata jobs regardless of
// whether hardware capabilities have ever been verified.
async function checkHwCapabilitiesAndEnqueueIfNeeded(): Promise<void> {
  try {
    const alreadyPending = await hasQueuedOrActiveJobOfType(db, "hwprobe");
    if (alreadyPending) return;

    const resolved = await computeCurrentFingerprint();
    if (!resolved) {
      console.warn("worker: hwcaps boot check skipped — ffmpeg could not be resolved (LOOMBRE_FFMPEG/PATH)");
      return;
    }

    let platform;
    try {
      platform = assertHwPlatform(resolved.platform);
    } catch (err) {
      console.warn(`worker: hwcaps boot check skipped — ${(err as Error).message}`);
      return;
    }

    const current = await getCurrentHwCapabilitySnapshot(db, platform);
    const reason = decideInvalidation(current, resolved);
    if (!reason) return;

    await queue.enqueue("hwprobe", { reason: "boot-invalidation" });
    console.log(`worker: enqueued hwprobe (${reason})`);
  } catch (err) {
    console.error("worker: failed to run hwcaps boot check:", err);
  }
}

let keepAlive: NodeJS.Timeout | undefined;

// STATE.md P4.14 + the I3 Windows SIGBREAK gap (Phase 4 Open list): this
// used to be a hand-rolled SIGINT/SIGTERM-only close() with no SIGBREAK at
// all, so LoombreServiceHost's CTRL_BREAK_EVENT graceful-stop mechanism
// (installers/windows/service-host/LoombreServiceHost/NativeMethods.cs's own
// header names this exact gap) always fell through to its timeout-then-kill
// fallback on Windows. installGracefulShutdown (apps/worker/src/crash/
// handlers.ts, same module apps/server/src/main.ts now uses) registers
// SIGTERM/SIGINT everywhere and SIGBREAK on win32 only, with a bounded
// timeout so a hung shutdown still exits instead of hanging the process
// forever. The actual work performed on shutdown is UNCHANGED (queue.stop()
// + hashPool.terminate() + watcherHandle.stop() + db.destroy()), PLUS the
// LPP v1 event-subscriber delivery loop's stop (added alongside the
// others, not appended after — pluginDeliveryLoopHandle.stop() itself
// waits out any in-flight tick before resolving, see delivery-loop.ts, so
// it is exactly as safe to run concurrently with the others as
// watcherHandle.stop() already was).
async function shutdown(_signal: ShutdownSignal): Promise<void> {
  if (keepAlive) clearInterval(keepAlive);
  await Promise.all([
    queue.stop(),
    hashPool.terminate(),
    watcherHandle?.stop() ?? Promise.resolve(),
    stashWatcherHandle?.stop() ?? Promise.resolve(),
    stashScheduleLoopHandle?.stop() ?? Promise.resolve(),
    pluginDeliveryLoopHandle?.stop() ?? Promise.resolve(),
    db.destroy(),
  ]);
}

// STATE.md P4.2 (lane B): single-provisioner rule — only apps/server owns
// the embedded-PostgreSQL child process (apps/server/src/bootstrap/
// provisioning.ts); this worker never provisions anything itself. If the
// worker's service-manager unit starts before the server has finished
// provisioning (or DATABASE_URL simply points nowhere reachable yet), every
// query above would otherwise fail once at boot and never retry (pg-boss's
// own `work()` registration already swallows its start() rejection into a
// bare console.error — see @loombre/jobs/src/queue.ts). This bounded
// wait-then-fail-fast guard uses `listLibraries` (already imported above)
// as the readiness probe rather than a raw SQL import, which stays banned
// outside packages/db by dependency-cruiser's "no-raw-db-driver-outside-
// packages-db" rule.
async function waitForDatabaseReady(timeoutMs = 30_000, intervalMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await listLibraries(db);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  console.error(
    `worker: could not reach DATABASE_URL after ${timeoutMs}ms — is the server's embedded PostgreSQL running yet? ` +
      "Single-provisioner rule (STATE.md P4.2): only apps/server provisions the embedded database; start it first, " +
      "or point this worker's DATABASE_URL at an already-running external PostgreSQL instance. " +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  await waitForDatabaseReady();
  await startLibraryWatcher();
  await startStashLibraryWatcher();
  await enqueueImageBackfillIfNeeded();
  await checkHwCapabilitiesAndEnqueueIfNeeded();

  // LPP v1, Lane W4: outbox fanout to event-subscriber plugins. Not a
  // pg-boss consumer (nothing here is a queued job — it is its own poll
  // loop, same "own interval, own handle, own clean-shutdown" shape as
  // startLibraryWatcher above) — see apps/worker/src/plugin-delivery/
  // delivery-loop.ts's header for the full per-tick algorithm.
  pluginDeliveryLoopHandle = startPluginDeliveryLoop({ db });

  // Stash SQLite metadata sync, Lane C, deliverable 7(b): the schedule
  // trigger — see apps/worker/src/stash/schedule-loop.ts's own header for
  // why this is a boot-timer rather than pg-boss's `.schedule()`. Default
  // OFF (stash.sync.scheduleIntervalMs = 0); starting the loop
  // unconditionally is cheap (each tick's own settings read decides
  // whether anything happens) and lets a later admin-set interval take
  // effect without a worker restart.
  stashScheduleLoopHandle = startStashScheduleLoop({
    db,
    enqueueIncrementalSync: (libraryId) => queue.enqueue("stash-sync", { libraryId, mode: "incremental" }),
  });

  // Assert the consumers ACTUALLY registered before saying so. The ten
  // queue.work() calls at module scope are fire-and-forget, and they run at
  // IMPORT time — before waitForDatabaseReady() above has had any chance to
  // wait for anything. On the rc.2 Windows install the worker lost that race
  // with the server's first-boot PostgreSQL provisioning by ~8 seconds, all
  // ten registrations failed with ECONNREFUSED, and this line printed the
  // full list of "registered" consumers anyway. The result was a live worker
  // process with zero consumers: no job ever ran, hwprobe never reported, the
  // setup wizard sat on "Worker not detected yet" forever, and because the
  // process stayed alive no supervisor ever restarted it.
  //
  // @loombre/jobs now retries its pg-boss start (a database that is still
  // coming up is "not yet", not "broken"), so this normally just resolves.
  // If it does not, throwing is the correct outcome: main()'s catch exits
  // non-zero, and every installer supervises this process (Windows SCM
  // recovery actions, systemd Restart=, launchd KeepAlive) so it comes back
  // once the database is genuinely reachable. A silent no-op worker is far
  // worse than a loud restart.
  await queue.ready();

  console.log(
    "worker up — pg-boss consumers registered: scan, probe, metadata, image, import, image-backfill, hwprobe, transcode, subtitle-extract, stash-inventory, stash-sync, mail-send",
  );
  console.log("worker up — plugin-delivery loop started (LPP v1 event-subscriber fanout)");
  console.log("worker up — stash schedule-loop started (Stash SQLite metadata sync, trigger (b), default OFF)");

  installGracefulShutdown({ onShutdown: shutdown, processName: "@loombre/worker" });

  // A pending Promise alone does not hold the event loop open — only a real
  // handle (timer, socket, ...) does. This interval is the worker's
  // keep-alive; installGracefulShutdown's exit(0)/exit(1) is what actually
  // ends the process after shutdown() resolves/fails.
  keepAlive = setInterval(() => {}, 1 << 30);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
