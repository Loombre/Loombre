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
 * One-time open_gop backfill (migrations/0038_media_streams_open_gop.sql —
 * same expand -> migrate -> contract policy as ImageBackfillJobPayload
 * above, "migrate" step for an expand-only ALTER TABLE). Existing libraries
 * were probed before this column existed, so every pre-existing
 * media_streams video row has open_gop = NULL. Each job invocation
 * processes exactly one id-ordered batch of HEVC rows still NULL (the only
 * ones that need the real bounded ffmpeg trace_headers scan,
 * apps/worker/src/probe/opengop.ts) via cursor pagination identical to
 * ImageBackfillJobPayload's; non-HEVC NULL video rows are bulk-set false in
 * one SQL statement on the FIRST batch (cursor === null) — no scan needed,
 * since @loombre/playback-engine never consults this field for a non-hevc
 * codec. `cursor: null` starts a fresh sweep from the beginning.
 * `batchSize` is optional (apps/worker/src/probe/opengop-backfill-
 * consumer.ts defaults it) — present here only so a caller MAY override it
 * (e.g. tests).
 */
export interface OpenGopBackfillJobPayload {
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

/** Cheap Stash-DB inventory pass: repopulates stash_scene_links with every
 *  scene's path/size/oshash/updated_at so the admin path-mapping preview is
 *  pure SQL (STATE.md Stash run, K10). Enqueued on connection save and as
 *  the first phase of a full sync. */
export interface StashInventoryJobPayload {
  libraryId: string;
}

/** Stash metadata sync (STATE.md Stash run, S8): 'full' walks every linked
 *  scene; 'incremental' diffs on Stash's updated_at columns and touches only
 *  changed scenes. Payload stays minimal — all connection state (sqlite
 *  path, mappings, checkpoints) lives in the db, keyed by libraryId. */
export interface StashSyncJobPayload {
  libraryId: string;
  mode: 'full' | 'incremental';
}

/**
 * Optional mail transport run (E6/M7): outbox-driven mail delivery. Callers
 * NEVER build raw HTML/text themselves — only a closed templateId + the
 * params its renderer (apps/worker/src/mail/templates/**) needs; the
 * worker consumer resolves effective settings + credentials fresh AT JOB
 * START (never once at worker boot, matching the image/scan consumers'
 * per-job settings re-resolution convention) and renders+sends via
 * nodemailer. `to` is a bare email address, never a display-name-plus-
 * address string (the template itself is what may carry a display name,
 * as one of `params`). Every field in `params` is HTML-escaped by the
 * renderer before it ever reaches an outgoing message (someone WILL put
 * `<script>` in a display name).
 */
export interface MailSendJobPayload {
  templateId: 'invite' | 'password-reset' | 'security-notice' | 'email-in-use-notice' | 'test';
  to: string;
  params: Record<string, string>;
}

export interface JobPayloads {
  scan: ScanJobPayload;
  probe: ProbeJobPayload;
  image: ImageJobPayload;
  metadata: MetadataJobPayload;
  'metadata-search': MetadataSearchJobPayload;
  import: ImportJobPayload;
  'image-backfill': ImageBackfillJobPayload;
  'opengop-backfill': OpenGopBackfillJobPayload;
  hwprobe: HwProbeJobPayload;
  transcode: TranscodeJobPayload;
  'subtitle-extract': SubtitleExtractJobPayload;
  'pg-upgrade': PgUpgradeJobPayload;
  'stash-inventory': StashInventoryJobPayload;
  'stash-sync': StashSyncJobPayload;
  'mail-send': MailSendJobPayload;
}

export type JobType = keyof JobPayloads;

/** Runtime-iterable mirror of the JobPayloads keys — used to register a
 *  pg-boss queue for every closed job type at startup. */
export const JOB_TYPES = [
  'scan',
  'probe',
  'image',
  'metadata',
  'metadata-search',
  'import',
  'image-backfill',
  'opengop-backfill',
  'hwprobe',
  'transcode',
  'subtitle-extract',
  'pg-upgrade',
  'stash-inventory',
  'stash-sync',
  'mail-send',
] as const satisfies readonly JobType[];

/**
 * pg-boss provisioning options for one queue (queue.ts passes these to
 * createQueue/updateQueue).
 *
 * retryDelay/retryBackoff/retryDelayMax (optional mail transport run, M7):
 * pg-boss 12 has supported exponential retry backoff since before this
 * package existed, but nothing in @loombre/jobs exposed it — every prior
 * job type either retries immediately (retryDelay implicitly 0) or doesn't
 * retry at all. `mail-send` is the first job whose failure mode
 * (transient SMTP hiccups, a mail provider's own rate limiting) actually
 * benefits from spacing retries out rather than hammering the same
 * connection immediately. Deliberate new package surface, not a
 * side-effect edit — every OTHER job type's options object simply omits
 * these three fields, which pg-boss defaults to "no delay, no backoff"
 * (its own QueueOptions.retryDelay/retryBackoff defaults), so this is
 * additive and changes nothing about any existing queue's behavior.
 */
export interface JobQueueOptions {
  /** Seconds a job may sit in pg-boss's `active` state before its
   *  maintenance sweep retries or fails the row. */
  expireInSeconds: number;
  /** Times pg-boss may re-dispatch a job after a handler failure. */
  retryLimit: number;
  /** Seconds between retries (pg-boss QueueOptions.retryDelay) — the base
   *  delay when retryBackoff is off, or the FIRST retry's delay (before
   *  exponential growth) when it's on. */
  retryDelay?: number;
  /** Exponential backoff between retries, based on retryDelay (pg-boss
   *  QueueOptions.retryBackoff). */
  retryBackoff?: boolean;
  /** Ceiling on the backed-off delay, in seconds — only consulted when
   *  retryBackoff is true (pg-boss QueueOptions.retryDelayMax). */
  retryDelayMax?: number;
}

// pg-boss asserts `expireInSeconds / 3600 < 24`, so this is effectively its
// ceiling — the point is only that no handler this registry dispatches can
// plausibly outlive it.
const LONG_RUNNING_EXPIRE_SECONDS = 23 * 60 * 60;
const BOUNDED_EXPIRE_SECONDS = 60 * 60;

/**
 * Per-queue pg-boss options, declared for EVERY job type so none of them
 * silently inherits a driver default.
 *
 * `expireInSeconds` is the one that matters: pg-boss defaults it to 900 and
 * its maintenance sweep flips any job still `active` past that back to
 * `retry` purely on wall-clock — it has no knowledge of whether the JS
 * handler promise is still pending. Several types here deliberately hold
 * their handler promise far longer than 15 minutes ('transcode' resolves
 * only when its playback session reaches a terminal state, i.e. a whole
 * movie; 'scan'/'import'/'hwprobe' run for as long as the library/archive/
 * probe battery takes), so at the default a SECOND worker slot re-fetches
 * the same job id and runs it concurrently with the still-live original.
 *
 * 'transcode' additionally opts out of retries entirely: its handler drives
 * one live `playback_sessions` row and one staging directory, so a re-run is
 * not idempotent and is never the right recovery — the session is failed and
 * the client starts a new one.
 */
export const JOB_QUEUE_OPTIONS: Readonly<Record<JobType, JobQueueOptions>> = {
  scan: { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 2 },
  probe: { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  image: { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  metadata: { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  'metadata-search': { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  import: { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 2 },
  'image-backfill': { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  // Each batch is a handful of bounded (~60-75ms) ffmpeg trace_headers
  // scans plus one optional bulk SQL update — same shape/cost class as
  // 'image-backfill's worker_thread decode batches above.
  'opengop-backfill': { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  hwprobe: { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 2 },
  transcode: { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 0 },
  'subtitle-extract': { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 2 },
  // Never dispatched through pg-boss at all (see PgUpgradeJobPayload) — the
  // queue exists only so JOB_TYPES stays a total map.
  'pg-upgrade': { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 0 },
  // Path/size/oshash rows only — bounded even at 33k scenes.
  'stash-inventory': { expireInSeconds: BOUNDED_EXPIRE_SECONDS, retryLimit: 2 },
  // A full 33k-scene sync holds its handler promise for the whole run
  // (checkpointed internally; a pg-boss retry resumes from the checkpoint).
  'stash-sync': { expireInSeconds: LONG_RUNNING_EXPIRE_SECONDS, retryLimit: 2 },
  // Optional mail transport run (E6/M7): a single send is a short-lived
  // SMTP conversation (connect + auth + DATA), never long-running —
  // BOUNDED_EXPIRE_SECONDS is generous for it. retryLimit 4 with
  // exponential backoff starting at retryDelay 60s (pg-boss's own formula,
  // this queue's own doc comment: `retryDelay * 2^retryCount` with jitter,
  // capped at retryDelayMax) gives roughly 1m / 2m / 4m / 8m between
  // attempts (~15 minutes end to end) — long enough to ride out a mail
  // provider's transient rate limiting or a brief network blip, short
  // enough that an admin waiting on an invite/reset email isn't left
  // hanging for hours. retryDelayMax 600 (10 minutes) keeps the LAST gap
  // from growing unbounded on a still-mostly-healthy provider. Per-send
  // callers may override retryLimit down to 0 (EnqueueOptions.retryLimit,
  // queue.ts) — the admin test-send action always does, since a manual
  // probe should fail fast and visibly rather than silently retrying for
  // 15 minutes.
  'mail-send': {
    expireInSeconds: BOUNDED_EXPIRE_SECONDS,
    retryLimit: 4,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 600,
  },
};
