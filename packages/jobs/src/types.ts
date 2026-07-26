// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/types.ts
//
// The closed job-type registry (P1.15). Every payload shape lives here so
// enqueue()/work() are fully typed end to end — adding a new job type is a
// deliberate, additive edit to this file (mirrors the additive-only
// discipline used for the event schemas and the openapi contract).

export interface ScanJobPayload {
  libraryId: string;
  full: boolean;
}

export interface ProbeJobPayload {
  mediaFileId: string;
}

export interface ImageJobPayload {
  entityType: string;
  entityId: string;
  kind: string;
  sourcePath: string;
}

/**
 * Metadata-provider enrichment job (P1.6/P1.7): resolve the provider chain
 * for `mediaKind`, merge results into the item's fields/provenance, and
 * enqueue follow-on 'image' jobs from any discovered image refs. `mediaKind`
 * and `contentClass` mirror @loombre/shared's MediaKind/ContentClass value
 * sets verbatim (this package does not take a workspace dependency on
 * @loombre/shared, so the literal unions are inlined here — both are closed
 * enums that only change in coordinated cross-package edits anyway).
 *
 * `forceRef` (additive, Phosphor retheme Wave 2 Lane L2 — Fix Match's
 * POST /admin/items/{id}/apply-match): when present, the consumer skips
 * search/pickBestMatch entirely and fetches details+images for EXACTLY this
 * provider ref, merging them through the same precedence engine every
 * scan-triggered metadata job already uses. Omitted (the common case): the
 * normal chain-search-and-best-match behavior, unchanged.
 */
export interface MetadataJobPayload {
  itemId: string;
  mediaKind: 'movie' | 'tv' | 'music';
  contentClass: 'general' | 'restricted';
  forceRef?: { provider: string; externalId: string };
}

/**
 * Bounded metadata-provider candidate SEARCH job (Phosphor retheme Wave 2,
 * Lane L2 — Fix Match's POST /admin/items/{id}/match-search). CLAUDE.md
 * invariant 6: the search itself (HTTP calls to the item's resolved
 * provider chain) runs here, in the worker, never inline in the admin
 * request path. The handler never writes to the catalog — it only scores
 * results (apps/worker/src/metadata/match.ts) and delivers them via an
 * admin-only `metadata.match-candidates` outbox event; applying a choice is
 * a SEPARATE 'metadata' job (MetadataJobPayload.forceRef above).
 */
export interface MetadataSearchJobPayload {
  itemId: string;
}

/**
 * Data-freedom import job (P1.17, docs/PLAN.md §8.4): POST /import enqueues
 * one of these per archive upload. Phase 1 shipped only the job-queue
 * plumbing (a stub that immediately failed every job with
 * `not-implemented-phase-2`); Phase 4 lane E replaces that stub with the
 * real apps/worker/src/import consumer (see that module's header for the
 * full archive-apply design: conflict policy, transaction/event/id-
 * preservation decisions).
 *
 * `mode` (additive, optional): typed conflict policy for a NON-EMPTY
 * target — 'fail-if-not-empty' (the safe default when omitted: the whole
 * job fails before any write, naming which table already has data) or
 * 'merge-skip-existing' (natural-key skip-duplicates, per-section counts).
 * On an EMPTY target both values behave identically (nothing can conflict)
 * and the consumer additionally preserves every archive id verbatim — see
 * the consumer module header for the exact empty-target definition (it
 * tolerates the onboarding-wizard's own already-created admin user, P4.10).
 * POST /import's request body is closed to exactly ExportArchive
 * (packages/contract/openapi.yaml, `additionalProperties: false`) — the
 * frozen contract has no field for this today, so every HTTP-enqueued
 * import currently gets the default; a caller that enqueues an 'import'
 * job directly (e.g. a future lane C wizard-restore surface) may set this
 * explicitly.
 */
export interface ImportJobPayload {
  archive: unknown;
  requestedByUserId: string;
  mode?: 'fail-if-not-empty' | 'merge-skip-existing';
}

/**
 * One-time dominant_color backfill (P2.11, docs/PLAN.md §4.2's
 * expand -> migrate -> contract policy — this is the "migrate" step for
 * migrations/0005_images_dominant_color.sql's expand-only ALTER TABLE).
 * Each job invocation processes exactly one id-ordered batch of pre-
 * existing `images` rows still missing a dominant_color, then either
 * re-enqueues itself with `cursor` advanced to the last row it processed
 * (more remain) or does not re-enqueue (batch was short — backfill done).
 * `cursor: null` starts from the beginning. `batchSize` is optional
 * (apps/worker/src/image/backfill-consumer.ts defaults it) — present here
 * only so a caller MAY override it (e.g. tests).
 */
export interface ImageBackfillJobPayload {
  cursor: string | null;
  batchSize?: number;
}

/**
 * Hardware capability self-test battery (docs/PLAYBACK.md §8.1, Phase 3
 * §11 step 5): apps/worker/src/hwcaps/** runs the full probe-runner
 * battery for the current platform's candidate backends and persists a
 * fresh `VerifiedCapabilities` snapshot (migrations/
 * 0011_hw_capability_snapshots.sql). Enqueued at worker boot when the
 * current snapshot is missing or its (platform, ffmpeg_build_hash,
 * gpu_fingerprint) no longer matches what's actually resolved — `reason`
 * is diagnostic only (surfaces in job-ledger/log output, never branches
 * behavior). Idempotent at the enqueue site via the existing
 * hasQueuedOrActiveJobOfType pattern (P2.11 precedent), so a worker
 * restart never stacks a second concurrent probe run.
 */
export interface HwProbeJobPayload {
  reason: 'boot-invalidation' | 'manual';
}

/**
 * HLS transcode session pipeline (docs/PLAYBACK.md §9, Phase 3 §11 step 6a
 * — this REPLACES the old bespoke no-op `transcodeConsumer` stub that used
 * to live outside the real @loombre/jobs queue entirely, apps/worker/src/
 * consumers/transcode.ts, deleted in this step). One job = one
 * `playback_sessions` row: Lane B (apps/server) creates the row (plan +
 * engineVersion already stored, docs/PLAYBACK.md §9's audit requirement)
 * THEN enqueues this job with just its id — every other fact the worker
 * needs (file path, device profile, the stored plan/selection, staging
 * root) is read fresh from the row/its joins, never duplicated into the
 * payload (payload duplication would go stale the moment the row changes
 * out from under it, e.g. a seek). The job handler's promise resolves only
 * when the session reaches a terminal state (`ended`/`failed`) — for as
 * long as that takes, mirroring how a scan job holds its promise for the
 * whole scan rather than firing-and-forgetting a background loop
 * (CLAUDE.md invariant 6: long-running work goes through the job queue).
 *
 * Control channel = the `playback_sessions` row itself, NOT this payload
 * (apps/worker/src/transcode/index.ts (module header) has the full seam contract): the
 * server writes desired state (requested_segment/seek_target_ms) and the
 * worker polls its own session's row at a short interval and reacts — no
 * new IPC infrastructure, per this step's binding constraint 1.
 */
export interface TranscodeJobPayload {
  sessionId: string;
}

/**
 * Segmented-VTT subtitle side-track extraction (docs/PLAYBACK.md §9/
 * P3.9(e), Phase 3 §11 step 6b). Enqueued by apps/server at session create
 * time whenever `plan.subtitle.strategy === 'hls-vtt'` — regardless of the
 * session's own `decision` (a direct-play session can still carry an
 * hls-vtt subtitle side-track; it just never enqueues a `'transcode'` job
 * for its own video/audio). One job = one `playback_sessions` row, exactly
 * like `TranscodeJobPayload` — every other fact the worker needs (file
 * path, the stored plan's `subtitle.streamIndex`/`selection`, staging root)
 * is read fresh from the row, never duplicated into the payload. The
 * consumer (apps/worker/src/subtitles/**) extracts the SELECTED subtitle
 * stream to WebVTT and writes a single-segment HLS subtitle playlist under
 * the session's staging directory (shared with — and independent of —
 * the 'transcode' job's own staging_dir, see packages/db/src/internal/
 * transcode-sessions.ts's `ensureSessionStagingDir`).
 */
export interface SubtitleExtractJobPayload {
  sessionId: string;
}

/**
 * Boot-time PostgreSQL major-version upgrade AUDIT row (STATE.md Phase 4
 * Open item "Upgrade jobs-ledger follow-up (lane B)" — the exact gap named
 * in packages/provisioning-pg/src/supervisor.ts's own `upgrade()` doc
 * comment: "packages/jobs's JobType enum has no upgrade-history member;
 * adding one is out of this package's ownership, documented as a
 * follow-up"). This is NOT a real dispatchable pg-boss job: the upgrade
 * itself runs at boot, BEFORE pg-boss can even connect (the queue lives
 * inside the PG instance being replaced — see that module's header), so
 * nothing ever `boss.send()`s a 'pg-upgrade' job and no consumer ever
 * registers `queue.work('pg-upgrade', ...)`. It exists purely so the admin
 * jobs dashboard (STATE.md deliverable D) shows upgrade history: a caller
 * writes this AFTER THE FACT via the `createLedger()` export directly
 * (recordQueued -> recordActive -> recordCompleted/recordFailed, exactly
 * like every other ledger row, just never routed through
 * `createJobQueue()`/pg-boss at all).
 *
 * `fromVersion`/`toVersion` mirror packages/provisioning-pg's own
 * `UpgradePlan.fromVersion`/`toVersion` field names verbatim (full pinned
 * version strings, e.g. "16.14.0" -> "17.10.0", not bare major numbers) —
 * wiring provisioning-pg's boot sequence to actually call `createLedger`
 * with these fields is a direct copy, not a translation. That wiring is
 * explicitly OUT of this lane's scope (this file + createLedger's export
 * only); provisioning-pg imports it later.
 */
export interface PgUpgradeJobPayload {
  fromVersion: string;
  toVersion: string;
  reason: 'boot-major-upgrade';
}

export interface JobPayloads {
  scan: ScanJobPayload;
  probe: ProbeJobPayload;
  image: ImageJobPayload;
  metadata: MetadataJobPayload;
  'metadata-search': MetadataSearchJobPayload;
  import: ImportJobPayload;
  'image-backfill': ImageBackfillJobPayload;
  hwprobe: HwProbeJobPayload;
  transcode: TranscodeJobPayload;
  'subtitle-extract': SubtitleExtractJobPayload;
  'pg-upgrade': PgUpgradeJobPayload;
}

export type JobType = keyof JobPayloads;

/** Runtime-iterable mirror of the JobPayloads keys — used to register a
 *  pg-boss queue for every closed job type at startup. */
export const JOB_TYPES: readonly JobType[] = [
  'scan',
  'probe',
  'image',
  'metadata',
  'metadata-search',
  'import',
  'image-backfill',
  'hwprobe',
  'transcode',
  'subtitle-extract',
  'pg-upgrade',
];
