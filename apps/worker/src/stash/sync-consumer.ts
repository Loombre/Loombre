// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/sync-consumer.ts
//
// The 'stash-sync' job consumer (STATE.md S8, Lane C sync engine) —
// `stashSyncConsumerHandler(deps)` is a FACTORY (same convention as
// apps/worker/src/metadata/consumer.ts's metadataConsumerHandler), closing
// over injected deps and returning the real JobHandler<'stash-sync'> that
// apps/worker/src/index.ts's `queue.work('stash-sync', ...)` expects.
//
// CHECKPOINT PATTERN CHOSEN: scan_checkpoints' same-job-id-on-retry shape
// (apps/worker/src/scan/scanner.ts:336-456), NOT image-backfill's
// self-requeue-cursor shape (apps/worker/src/image/backfill-consumer.ts).
// Why: packages/jobs/src/types.ts registers 'stash-sync' LONG_RUNNING
// (23h expireInSeconds) with retryLimit 2 — the pre-set pg-boss options
// this lane must respect (mission constraint). That configuration means
// ONE job holds its handler promise open for the WHOLE run and pg-boss
// itself retries a failed attempt UNDER THE SAME job.id (packages/jobs/
// src/queue.ts's work() batch handler: `attempts = job.retryCount + 1`,
// same id every attempt) — exactly 'scan's shape. image-backfill's
// pattern is the opposite: BOUNDED per-batch jobs, a FRESH job.id per
// batch, no reliance on pg-boss retrying the same job id at all — the
// right fit for a cursor-driven sweep with no single long-lived handler
// promise, not for a job type explicitly provisioned to hold one open for
// up to 23 hours.
//
// RESUME ALGORITHM (mirrors scanner.ts's maybeCheckpoint/resume-by-skip
// EXACTLY, including its equality-not-comparison resume test — see that
// module's own header for why a `>` comparison over Stash scene ids would
// be wrong: ids are numeric-ordered at the SQL layer but converted to
// strings by read-model.ts, so "10" < "2" lexically; an equality check
// sidesteps that entirely, same as scanner.ts's absolute-path equality
// check does for filesystem walks): inventory + matching ALWAYS re-run in
// full on every attempt (idempotent, bulk, fast even at 33k scenes — a
// resumed attempt gets the FRESHEST facts rather than trusting a stale
// partial pass); only the per-scene APPLY phase is checkpointed and
// skipped-by-equality on resume, because that is the expensive,
// per-scene work whose partial progress is worth preserving. A new scene
// appearing (numerically) BEFORE the checkpoint marker between attempts
// would be skipped by this same skip-by-equality algorithm — an accepted,
// already-precedented limitation (scanner.ts's own walk has the identical
// gap for new files appearing before a resumed walk's last path), not a
// new one introduced here.
//
// EVENTS (K12): stash.sync.started is written the FIRST time a report row
// is created for this job.id (never re-written on a resume — one job.id,
// one started event); stash.sync.completed is written once, either here
// (status: 'succeeded') or from createStashSyncTerminalFailureHook below
// (status: 'failed', once pg-boss retries are exhausted) — both in the
// SAME transaction as the state they describe (writeEvent(trx, ...)
// alongside finishStashSyncReport).
//
// REPORT COUNTS (migrations/0020_stash_sync_reports.sql's own column
// comments): matched/unmatched/stale are LIVE SNAPSHOTS (getStashSceneLinkCounts)
// taken at run completion — correct for both full and incremental modes,
// where "how many scenes are matched RIGHT NOW" is what an admin actually
// wants, not "how many became matched in the last 12-scene incremental
// touch". updated/skipped are THIS-RUN tallies of what
// applyStashSceneMetadata (K11, injected) actually did.

import type { JobHandler, JobPayloads, StashSyncJobPayload } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import { withTransaction, writeEvent, getStashSyncCheckpoint, writeStashSyncCheckpoint, deleteStashSyncCheckpoint, type StashSyncCheckpointRow } from '@loombre/db/internal';
import {
  createStashSyncReport,
  finishStashSyncReport,
  findRunningStashSyncReport,
  getLibraryStashConnection,
  getStashSceneLinkCounts,
  getStashSyncReportByJobId,
  listStashSceneLinksForLibrary,
  markStashScenesStale,
  type StashSyncReportRow,
} from '@loombre/db';
import { connectToStashLibrary, type ConnectToStashLibraryDeps } from './connect.js';
import { getBlob, getScene, getSceneFiles, getScenePerformers, getSceneTags, getSceneMarkers, getStudio, listScenesForInventory, type SqliteReadable, type StashInventoryScene, type StashStudio } from './read-model.js';
import { runInventoryPass, runMatchingPass, upsertInventorySubset, toMatchInput } from './pipeline.js';
import type { StashSceneMatchResult } from './matching.js';
import type { ApplyStashSceneMetadataFn } from './apply-types.js';

/** Resolves the FULL studio ancestor chain for a scene's studioId: [0] =
 *  the scene's own studio, [1] = its parent, and so on (apply.ts's frozen
 *  input shape, per the orchestrator's B/C seam update — apply.ts never
 *  opens a Stash connection itself, so this walk happens here). A
 *  malformed/cyclic parent chain in upstream Stash data is defended
 *  against with a hard depth cap rather than an infinite loop; a break
 *  mid-walk just means the chain is shorter than the true hierarchy,
 *  never a crash. */
const MAX_STUDIO_CHAIN_DEPTH = 32;

function resolveStudioChain(stashDb: SqliteReadable, studioId: string | null): StashStudio[] {
  const chain: StashStudio[] = [];
  let currentId = studioId;
  const seen = new Set<string>();
  while (currentId != null && chain.length < MAX_STUDIO_CHAIN_DEPTH && !seen.has(currentId)) {
    const studio = getStudio(stashDb, currentId);
    if (!studio) break;
    chain.push(studio);
    seen.add(currentId);
    currentId = studio.parentId;
  }
  return chain;
}

/** scanner.ts's own CHECKPOINT_INTERVAL_FILES precedent (50) — the same
 *  "how often is checkpoint-write overhead worth it" tradeoff, just
 *  counted in scenes instead of files. */
const DEFAULT_CHECKPOINT_INTERVAL_SCENES = 50;

export interface StashSyncConsumerDeps {
  db: DbOrTx;
  /** K11: Lane B's injected apply — see apply-types.ts's header for the
   *  full rationale. Production wiring (apps/worker/src/index.ts) passes
   *  createStubApplyStashSceneMetadata() until Lane B's apply.ts lands. */
  applyStashSceneMetadata: ApplyStashSceneMetadataFn;
  enqueueImageJob: (payload: JobPayloads['image']) => Promise<unknown>;
  /** Defaults to Date.now — injectable for deterministic tests. */
  clock?: () => number;
  /** Defaults to DEFAULT_CHECKPOINT_INTERVAL_SCENES — overridable for
   *  tests so a small fixture set can exercise the checkpoint-write/
   *  resume path without needing 50+ scenes. */
  checkpointIntervalScenes?: number;
  /** FX4 fix wave test seams: forwarded VERBATIM to connectToStashLibrary
   *  (ConnectToStashLibraryDeps.adapterDeps/openOptions — that interface's
   *  own doc comment: "production callers never set this"). Lets a test
   *  force S2's snapshot-copy fallback deterministically and fast (small
   *  retry/backoff budgets) rather than waiting out adapter.ts's real
   *  multi-second default retry budget. */
  stashAdapterDeps?: ConnectToStashLibraryDeps['adapterDeps'];
  stashOpenOptions?: ConnectToStashLibraryDeps['openOptions'];
}

export interface StashSyncRunResult {
  reportId: string;
  /** Scenes actually upserted this run — the FULL inventory count in full
   *  mode, or just the new+changed subset in incremental mode (S8: "12
   *  changed of 33k touches 12 items" — this is that count). */
  touchedCount: number;
  counts: { matched: number; updated: number; unmatched: number; stale: number; skipped: number };
}

interface RunCounts {
  updated: number;
  skipped: number;
}

/** Applies ONE matched scene's rich metadata via the injected apply,
 *  inside its own transaction (mirrors apps/worker/src/metadata/
 *  consumer.ts's per-item transaction convention — a mid-run crash loses
 *  at most this one scene's write, never the whole batch). A scene that
 *  vanished from Stash between the matching pass and this call (rare, but
 *  possible on a live database) is a documented no-op, not an error. */
async function applyOneScene(
  deps: StashSyncConsumerDeps,
  stashDb: SqliteReadable,
  libraryId: string,
  stashSceneId: string,
  itemId: string,
  genreTagNames: string[] | null
): Promise<{ changedFields: string[] }> {
  const scene = getScene(stashDb, stashSceneId);
  if (!scene) return { changedFields: [] };

  const files = getSceneFiles(stashDb, stashSceneId);
  const performers = getScenePerformers(stashDb, stashSceneId);
  const studioChain = resolveStudioChain(stashDb, scene.studioId);
  const tags = getSceneTags(stashDb, stashSceneId);
  const markers = getSceneMarkers(stashDb, stashSceneId);

  // apply.ts opens its OWN withTransaction internally (joins an active
  // one — packages/db/src/internal/tx.ts's `if (db.isTransaction) return
  // fn(db)`) — wrapping this call in withTransaction here still gives
  // per-scene atomicity (this lane's own requirement, mirrors
  // apps/worker/src/metadata/consumer.ts's per-item convention) and
  // composes for free with apply.ts's join-if-already-a-transaction
  // behavior, per the orchestrator's B/C seam note ("call it with a plain
  // db handle or inside your batch transaction, either works").
  return withTransaction(deps.db, (trx) =>
    deps.applyStashSceneMetadata(
      trx,
      { getBlob: (checksum) => getBlob(stashDb, checksum), enqueueImageJob: deps.enqueueImageJob, ...(deps.clock ? { clock: deps.clock } : {}) },
      { libraryId, itemId, stashSceneId, scene, files, performers, studioChain, tags, markers, genreTagNames }
    )
  );
}

/**
 * The checkpointed, resumable apply phase — shared by full and
 * incremental mode. `matchResults` MUST be in the same order
 * runMatchingPass produced them (which itself inherits read-model's own
 * `ORDER BY s.id ASC`) so a resume's skip-by-equality lands on the exact
 * same sequence a prior attempt saw.
 */
async function runApplyPhase(
  deps: StashSyncConsumerDeps,
  stashDb: SqliteReadable,
  libraryId: string,
  jobId: string,
  matchResults: readonly StashSceneMatchResult[],
  checkpoint: StashSyncCheckpointRow | undefined,
  clock: () => number,
  genreTagNames: string[] | null,
  counts: RunCounts
): Promise<void> {
  const checkpointInterval = deps.checkpointIntervalScenes ?? DEFAULT_CHECKPOINT_INTERVAL_SCENES;
  let resuming = checkpoint != null && checkpoint.phase === 'applying' && checkpoint.last_processed_stash_scene_id != null;
  // A resumed attempt re-derives its OWN scenesSeen from this walk (the
  // matchResults array is regenerated fresh every attempt, same as
  // scanner.ts's own filesSeen never carrying over) — scenesProcessed DOES
  // carry over (real completed work from a prior attempt).
  let scenesSeen = 0;
  let scenesProcessed = checkpoint?.scenes_processed ?? 0;

  for (const result of matchResults) {
    scenesSeen++;

    if (resuming) {
      if (result.stashSceneId === checkpoint!.last_processed_stash_scene_id) {
        resuming = false;
      }
      if (scenesSeen % checkpointInterval === 0) {
        await writeStashSyncCheckpoint(deps.db, {
          jobId,
          libraryId,
          phase: 'applying',
          lastProcessedStashSceneId: checkpoint!.last_processed_stash_scene_id,
          scenesSeen,
          scenesProcessed,
          updatedAtMs: clock(),
        });
      }
      continue;
    }

    if (result.itemId != null) {
      const applyResult = await applyOneScene(deps, stashDb, libraryId, result.stashSceneId, result.itemId, genreTagNames);
      if (applyResult.changedFields.length > 0) counts.updated++;
      else counts.skipped++;
    }
    scenesProcessed++;

    if (scenesSeen % checkpointInterval === 0) {
      await writeStashSyncCheckpoint(deps.db, {
        jobId,
        libraryId,
        phase: 'applying',
        lastProcessedStashSceneId: result.stashSceneId,
        scenesSeen,
        scenesProcessed,
        updatedAtMs: clock(),
      });
    }
  }

  const lastId = matchResults.length > 0 ? matchResults[matchResults.length - 1]!.stashSceneId : (checkpoint?.last_processed_stash_scene_id ?? null);
  await writeStashSyncCheckpoint(deps.db, {
    jobId,
    libraryId,
    phase: 'completed',
    lastProcessedStashSceneId: lastId,
    scenesSeen,
    scenesProcessed,
    updatedAtMs: clock(),
  });
}

async function runFullSync(
  deps: StashSyncConsumerDeps,
  stashDb: SqliteReadable,
  libraryId: string,
  jobId: string,
  checkpoint: StashSyncCheckpointRow | undefined,
  clock: () => number,
  genreTagNames: string[] | null,
  counts: RunCounts
): Promise<{ touchedCount: number }> {
  // Staleness (S8): capture the pre-existing link set BEFORE the
  // inventory pass touches anything, so "present in links but absent
  // from THIS pass" is unambiguous.
  const preExisting = await listStashSceneLinksForLibrary(deps.db, libraryId);
  const preExistingIds = new Set(preExisting.map((r) => r.stash_scene_id));

  const { scenes } = await runInventoryPass(deps.db, stashDb, libraryId, clock());
  const currentIds = new Set(scenes.map((s) => s.stashSceneId));
  const vanished = [...preExistingIds].filter((id) => !currentIds.has(id));
  await markStashScenesStale(deps.db, { libraryId, stashSceneIds: vanished, nowMs: clock() });

  const { results } = await runMatchingPass(deps.db, libraryId, scenes.map(toMatchInput), clock());
  await runApplyPhase(deps, stashDb, libraryId, jobId, results, checkpoint, clock, genreTagNames, counts);

  return { touchedCount: scenes.length };
}

async function runIncrementalSync(
  deps: StashSyncConsumerDeps,
  stashDb: SqliteReadable,
  libraryId: string,
  jobId: string,
  checkpoint: StashSyncCheckpointRow | undefined,
  clock: () => number,
  genreTagNames: string[] | null,
  counts: RunCounts
): Promise<{ touchedCount: number }> {
  const freshScenes: StashInventoryScene[] = listScenesForInventory(stashDb);
  const existingLinks = await listStashSceneLinksForLibrary(deps.db, libraryId);
  const existingUpdatedAtMs = new Map(existingLinks.map((r) => [r.stash_scene_id, r.stash_updated_at_ms]));
  const currentIds = new Set(freshScenes.map((s) => s.stashSceneId));

  // S8: "diffing Stash's updated_at columns and touches only changed/new
  // scenes" — new (no existing row at all) or changed (fresh updatedAtMs
  // strictly newer than what's on record); an untouched majority is never
  // even read from the DB side beyond this one map lookup.
  const touched = freshScenes.filter((s) => {
    const prev = existingUpdatedAtMs.get(s.stashSceneId);
    return prev === undefined || prev === null || prev < s.updatedAtMs;
  });
  const vanished = [...existingUpdatedAtMs.keys()].filter((id) => !currentIds.has(id));

  await upsertInventorySubset(deps.db, libraryId, touched, clock());
  await markStashScenesStale(deps.db, { libraryId, stashSceneIds: vanished, nowMs: clock() });

  const { results } = await runMatchingPass(deps.db, libraryId, touched.map(toMatchInput), clock());
  await runApplyPhase(deps, stashDb, libraryId, jobId, results, checkpoint, clock, genreTagNames, counts);

  return { touchedCount: touched.length };
}

/**
 * The full stash-sync orchestration — importable directly by tests and
 * the 33k scale-proof script (deliverable 8) for result inspection, and
 * wrapped by stashSyncConsumerHandler below for real queue.work()
 * registration (JobHandler<'stash-sync'> is a bare Promise<void>; a
 * function returning a more specific Promise<T> is structurally
 * assignable to that in TypeScript, so no separate adapter is needed —
 * the factory below just discards the return value for clarity at the
 * real call site).
 */
export async function runStashSync(deps: StashSyncConsumerDeps, payload: StashSyncJobPayload, meta: { jobId: string }): Promise<StashSyncRunResult> {
  const clock = deps.clock ?? Date.now;
  const startedAtMs = clock();

  const connRow = await getLibraryStashConnection(deps.db, payload.libraryId);
  const genreTagNames = connRow?.genre_tag_names ?? null;

  const existingCheckpoint = await getStashSyncCheckpoint(deps.db, meta.jobId);

  let report: StashSyncReportRow | undefined = await getStashSyncReportByJobId(deps.db, meta.jobId);
  if (!report) {
    report = await withTransaction(deps.db, async (trx) => {
      const created = await createStashSyncReport(trx, { libraryId: payload.libraryId, jobId: meta.jobId, mode: payload.mode, startedAtMs });
      await writeEvent(trx, {
        type: 'stash.sync.started',
        tsMs: startedAtMs,
        actorUserId: null,
        payload: { jobId: meta.jobId, libraryId: payload.libraryId, mode: payload.mode, startedAtMs },
      });
      return created;
    });
  }

  const connectResult = await connectToStashLibrary(
    {
      db: deps.db,
      clock,
      ...(deps.stashAdapterDeps !== undefined ? { adapterDeps: deps.stashAdapterDeps } : {}),
      ...(deps.stashOpenOptions !== undefined ? { openOptions: deps.stashOpenOptions } : {}),
    },
    payload.libraryId
  );
  if (connectResult.status !== 'ok') {
    const reason = connectResult.status === 'unreachable' ? connectResult.reason : connectResult.notice;
    // Thrown, not swallowed: pg-boss's own retry/onTerminalFailure
    // machinery is what turns this into a 'failed' report + event once
    // retries are exhausted (createStashSyncTerminalFailureHook below) —
    // this handler never writes a 'failed' status itself.
    throw new Error(`stash-sync: cannot open Stash connection for library ${payload.libraryId} (${connectResult.status}): ${reason}`);
  }

  // FX4 fix wave (S2): captured NOW, while the connection is still open —
  // readingFrom is a property of the open connection itself, known at
  // openStashConnection's return, not something close() invalidates. Never
  // re-derived after the fact.
  const usedSnapshotFallback = connectResult.connection.readingFrom === 'snapshot';

  const counts: RunCounts = { updated: 0, skipped: 0 };
  let touchedCount: number;
  try {
    const result =
      payload.mode === 'full'
        ? await runFullSync(deps, connectResult.connection.db, payload.libraryId, meta.jobId, existingCheckpoint, clock, genreTagNames, counts)
        : await runIncrementalSync(deps, connectResult.connection.db, payload.libraryId, meta.jobId, existingCheckpoint, clock, genreTagNames, counts);
    touchedCount = result.touchedCount;
  } finally {
    connectResult.connection.close();
  }

  const snapshot = await getStashSceneLinkCounts(deps.db, payload.libraryId);
  const finishedAtMs = clock();
  const finalCounts = { matched: snapshot.matched, updated: counts.updated, unmatched: snapshot.unmatched, stale: snapshot.stale, skipped: counts.skipped };

  await withTransaction(deps.db, async (trx) => {
    await finishStashSyncReport(trx, report!.id, {
      status: 'succeeded',
      matchedCount: finalCounts.matched,
      updatedCount: finalCounts.updated,
      unmatchedCount: finalCounts.unmatched,
      staleCount: finalCounts.stale,
      skippedCount: finalCounts.skipped,
      finishedAtMs,
      usedSnapshotFallback,
    });
    await writeEvent(trx, {
      type: 'stash.sync.completed',
      tsMs: finishedAtMs,
      actorUserId: null,
      payload: {
        jobId: meta.jobId,
        libraryId: payload.libraryId,
        mode: payload.mode,
        status: 'succeeded',
        counts: finalCounts,
        durationMs: finishedAtMs - report!.started_at_ms,
        completedAtMs: finishedAtMs,
        usedSnapshotFallback,
      },
    });
  });

  // Terminal success — the checkpoint's only purpose was surviving an
  // in-flight crash (see stash-sync-checkpoints.ts's own header).
  await deleteStashSyncCheckpoint(deps.db, meta.jobId);

  return { reportId: report.id, touchedCount, counts: finalCounts };
}

export function stashSyncConsumerHandler(deps: StashSyncConsumerDeps): JobHandler<'stash-sync'> {
  return async (payload, meta) => {
    await runStashSync(deps, payload, meta);
  };
}

/**
 * onTerminalFailure hook (packages/jobs/src/queue.ts's WorkOptions seam,
 * mirroring apps/worker/src/probe/terminal-failure-hook.ts's precedent):
 * fires once pg-boss has exhausted 'stash-sync's retryLimit (2). Finds
 * the in-flight report via {libraryId} alone (the hook signature carries
 * no jobId — see that file's own doc comment) using the SAME
 * "use the payload to find the resource" pattern probe's hook
 * establishes, finalizes it 'failed', and writes the paired
 * stash.sync.completed event — closing the gap where a permanently-failed
 * sync would otherwise leave a 'running' report row forever and no
 * terminal event at all.
 *
 * Honesty note: updated/skipped counts are reported as 0 here — this
 * hook has no access to the failed attempt's in-progress RunCounts
 * closure (a fresh function call, no shared state with the handler that
 * threw). matched/unmatched/stale remain accurate live snapshots
 * regardless (getStashSceneLinkCounts), since those were never this-run
 * tallies to begin with. Same honesty applies to FX4's usedSnapshotFallback
 * (S2): deliberately OMITTED from both finishStashSyncReport's input (the
 * column stays whatever it already was — NULL, from createStashSyncReport's
 * insert) and the event payload (the field is optional/omittable per the
 * evolution policy) — this hook never obtains a StashConnection for the
 * failed attempt, so it genuinely does not know the answer.
 */
export function createStashSyncTerminalFailureHook(db: DbOrTx): (payload: StashSyncJobPayload, error: unknown) => Promise<void> {
  return async (payload, error) => {
    const running = await findRunningStashSyncReport(db, payload.libraryId);
    if (!running) {
      console.warn(`[worker] stash-sync terminal-failure hook: no running report found for library ${payload.libraryId} — skipping event (no orphan)`);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const finishedAtMs = Date.now();
    const snapshot = await getStashSceneLinkCounts(db, payload.libraryId);
    const finalCounts = { matched: snapshot.matched, updated: 0, unmatched: snapshot.unmatched, stale: snapshot.stale, skipped: 0 };

    await withTransaction(db, async (trx) => {
      await finishStashSyncReport(trx, running.id, { status: 'failed', matchedCount: finalCounts.matched, updatedCount: finalCounts.updated, unmatchedCount: finalCounts.unmatched, staleCount: finalCounts.stale, skippedCount: finalCounts.skipped, finishedAtMs });
      await writeEvent(trx, {
        type: 'stash.sync.completed',
        tsMs: finishedAtMs,
        actorUserId: null,
        payload: {
          jobId: running.job_id,
          libraryId: payload.libraryId,
          mode: payload.mode,
          status: 'failed',
          counts: finalCounts,
          durationMs: finishedAtMs - running.started_at_ms,
          completedAtMs: finishedAtMs,
        },
      });
    });

    console.error(`[worker] stash-sync terminal failure for library ${payload.libraryId}: ${message}`);
  };
}
