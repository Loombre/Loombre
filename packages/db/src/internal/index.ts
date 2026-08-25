// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/index.ts — internal writer barrel.
//
// Exported ONLY via the "@loombre/db/internal" package.json subpath (see
// package.json's "exports" map) — never re-exported from the public
// barrel (src/index.ts). This is the scanner/import write path (P1.13):
// guard-free BY DESIGN, because writes are not viewer-scoped and the reads
// in here (find-by-hash, checkpoint reads, cache reads, ...) are
// scanner-internal bookkeeping, not a catalog browse surface — the
// restricted-content guard (src/query/*) governs viewer-facing reads only.
//
// Who may import this subpath is enforced by the repo-root
// dependency-cruiser rule "no-internal-db-outside-worker": apps/worker,
// packages/jobs (ledger-mirroring writes into the `jobs` table — see
// src/internal/jobs.ts), and packages/db itself (including its own
// tests/seed). Every other package — notably apps/server, which serves
// viewer-scoped API requests — is forbidden from reaching these unguarded
// writers.

export type { DbOrTx } from './tx.js';
export { withTransaction } from './tx.js';

export type { CatalogItemRow, UpsertCatalogItemInput, UpsertSatelliteInput } from './catalog.js';
export {
  upsertCatalogItem,
  upsertSatellite,
  getCatalogItemById,
  getTrackDetails,
  findMovieByTitleYear,
  findSeriesByTitle,
  findSeasonByNumber,
  findEpisodeByNumber,
  findArtistByName,
  findAlbumByTitle,
  findTrackByNumberOrTitle,
} from './catalog.js';
export type { FindMovieInput } from './catalog.js';

export type {
  MediaFileRow,
  MediaStreamRow,
  ReplaceStreamInput,
  CreateMediaFileInput,
  SetProbeResultInput,
  HevcStreamNeedingOpenGopProbeRow,
} from './files.js';
export {
  findFileByContentHash,
  findFileByPath,
  getMediaFileById,
  relinkFile,
  markFileMissing,
  clearFileMissing,
  replaceFileStreams,
  createMediaFile,
  updateMediaFileHash,
  updateMediaFileMtime,
  setMediaFileProbeResult,
  deleteMediaFile,
  listMediaFilesForLibrary,
  listStaleMissingFiles,
  insertMediaFilePlaceholderForImport,
  hasVideoStreamsNeedingOpenGopBackfill,
  listHevcStreamsNeedingOpenGopProbe,
  setStreamOpenGop,
  bulkSetNonHevcVideoOpenGopFalse,
} from './files.js';
export type { InsertMediaFilePlaceholderInput } from './files.js';

// Data-freedom import additions (apps/worker/src/import — deliverable E):
// id-preserving users/progress writers. See import-users.ts/
// import-progress.ts headers for why these are new files rather than
// growing src/query/admin.ts / src/query/progress-write.ts (both live in
// the PUBLIC barrel and serve a materially different, viewer/isAdmin-
// authorized write path).
export type { ImportUserRow, InsertUserWithIdInput } from './import-users.js';
export { insertUserWithId, IMPORT_PLACEHOLDER_PASSWORD_HASH } from './import-users.js';
export type { ImportProgressRow, InsertProgressExactInput } from './import-progress.js';
export { insertProgressExact } from './import-progress.js';
export type { ImportTargetState } from './import-target-state.js';
export { getImportTargetState } from './import-target-state.js';

export type { LibraryRow, InsertLibraryWithIdInput } from './libraries.js';
export {
  getLibraryById,
  listLibraries,
  insertLibraryWithId,
  findLibraryByNameAndKind,
  grantLibraryPermission,
} from './libraries.js';

export type { ImageRow, UpsertImageInput, ImageNeedingDominantColorRow } from './images.js';
export {
  upsertImage,
  listImagesNeedingDominantColor,
  setImageDominantColor,
  copyDominantColorToVariants,
  hasOriginalImage,
} from './images.js';

export type { EventRow, WriteEventInput } from './events.js';
export { writeEvent } from './events.js';

export type { ProviderCacheRow, UpsertProviderCacheEntryInput } from './provider-cache.js';
export { upsertProviderCacheEntry, getProviderCacheEntry } from './provider-cache.js';

export type { ScanCheckpointRow, WriteCheckpointInput } from './checkpoints.js';
export { writeCheckpoint, getCheckpoint } from './checkpoints.js';

export type { StashSyncCheckpointRow, WriteStashSyncCheckpointInput } from './stash-sync-checkpoints.js';
export { writeStashSyncCheckpoint, getStashSyncCheckpoint, deleteStashSyncCheckpoint } from './stash-sync-checkpoints.js';

export type {
  MetadataProvenanceRow,
  UpsertMetadataProvenanceInput,
} from './provenance.js';
export { upsertMetadataProvenance, getProvenanceForItem } from './provenance.js';

export type {
  JobLedgerRow,
  InsertJobLedgerRowInput,
  TransitionJobLedgerRowInput,
  ReconcileAbandonedJobsInput,
  AbandonedJobLedgerRow,
} from './jobs.js';
export {
  insertJobLedgerRow,
  transitionJobLedgerRow,
  getJobLedgerRow,
  hasQueuedOrActiveJobOfType,
  reconcileAbandonedJobLedgerRows,
} from './jobs.js';

export type {
  HwCapabilitySnapshotRow,
  HwCapabilityBackendRow,
  RecordHwCapabilityBackendInput,
  RecordVerifiedCapabilitiesInput,
  RecordedVerifiedCapabilities,
} from './hwcaps.js';
export { recordVerifiedCapabilitiesSnapshot } from './hwcaps.js';

export type {
  ProviderIdRow,
  UpsertProviderIdInput,
  PersonRow,
  ItemPersonRow,
  ItemPersonInput,
  TagRow,
  ItemTagRow,
  ItemTagInput,
  FindOrCreateTagOptions,
} from './relations.js';
export {
  upsertProviderId,
  getProviderIdsForItem,
  findOrCreatePerson,
  replaceItemPeople,
  findOrCreateTag,
  replaceItemTags,
} from './relations.js';

// Stash SQLite metadata sync (STATE.md K11) — namespaced extension-sandbox
// writers (item_attributes/person_attributes) and the chapter_markers
// wholesale-replace writer, all consumed by apps/worker/src/stash/apply.ts.
export type { ItemAttributeRow, UpsertItemAttributeInput } from './item-attributes.js';
export { upsertItemAttribute, getItemAttributes } from './item-attributes.js';
export type { PersonAttributeRow, UpsertPersonAttributeInput } from './person-attributes.js';
export { upsertPersonAttribute, getPersonAttributes } from './person-attributes.js';
export type { ChapterMarkerRow, ChapterMarkerInput } from './chapter-markers.js';
export { replaceChapterMarkers, getChapterMarkers } from './chapter-markers.js';

// Phase 3 §11 step 6a — transcode session runtime (docs/PLAYBACK.md §9).
// See src/internal/transcode-sessions.ts's header for the guard-free
// rationale and migrations/0012_transcode_sessions.sql for the full
// worker/server column-ownership split this pairs with.
export type {
  TranscodeSessionRow,
  ConsumedSeekTarget,
  MarkSessionFailedInput,
  RecordSessionWorkerProcessInput,
  ReapableTranscodeSessionRow,
  RecordTranscodeRunInput,
  // d4-f5: shared with src/query/playback-sessions.ts's heartbeat-stale
  // suspend, the one status-changed emitter that is NOT worker-owned.
  SessionStatusChangeReason,
  SessionStatusSnapshot,
} from './transcode-sessions.js';
export {
  emitSessionStatusChanged,
  readSessionStatusSnapshot,
  getTranscodeSessionRow,
  markSessionStarting,
  markSessionActive,
  updateProducedSegment,
  setThrottleSuspended,
  clearThrottleSuspendedOnRestart,
  consumeSeekTarget,
  markSessionFailed,
  ensureSessionStagingDir,
  recordSessionWorkerProcess,
  listReapableTranscodeSessions,
  absorbSeekTarget,
  recordTranscodeRun,
  // migrations/0044 (Wave C2, docs/PLAYBACK.md §9.1) — the worker half of
  // the slot-handoff control channel.
  recordActiveRungIndex,
  consumePendingRungIndex,
} from './transcode-sessions.js';

export { getMediaInfoForFile } from './media-assembly.js';
