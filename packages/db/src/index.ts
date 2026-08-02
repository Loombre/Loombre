// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/index.ts — public package barrel.
//
// Deliberately narrow. Exported:
//   - ViewerContext (the shape every guarded call requires)
//   - getItemById / listItems (the only guarded catalog reads today)
//   - createDb (factory to obtain a handle to pass into the above)
//
// NOT exported: the raw `applyGuard` function and anything that would let a
// consumer build an unguarded query. Combined with the repo-root
// dependency-cruiser rule banning `pg`/`kysely` imports outside
// packages/db, this makes an unfiltered catalog read a compile-time
// impossibility for every other package, not a code-review hope
// (docs/PLAN.md §6.4).

export type { ViewerContext } from './context.js';
export type {
  CatalogItemRow,
  GetRecentlyAddedParams,
  ListItemsParams,
  ListItemsResult,
} from './query/items.js';
export { getItemById, getRecentlyAdded, listItems } from './query/items.js';
export { createDb } from './db.js';
export type {
  ItemType,
  ContentClass,
  ItemTagKind,
  MediaKind,
  WatchState,
} from './types.js';

// Search (docs/PLAN.md §6.4 task spec item 1).
export type {
  SearchCatalogParams,
  SearchCatalogResult,
  SearchResultRow,
} from './query/search.js';
export { searchCatalog } from './query/search.js';

// People / tags (leak surfaces per §6.4 / STATE.md P1.17).
export type { ListPeopleParams, ListPeopleResult, PersonRow } from './query/people.js';
export { getPersonById, listPeople } from './query/people.js';
export type { ListTagsParams, ListTagsResult, TagRow } from './query/tags.js';
export { listTags } from './query/tags.js';

// Person filmography (Phosphor Wave 2 lane L3, /people/[id] route) — see
// src/query/people.ts's "Filmography" section header for the guard posture
// (same two-clause rule listPeople/getPersonById already enforce).
export type {
  ListItemsForPersonParams,
  ListItemsForPersonResult,
  PersonItemRow,
} from './query/people.js';
export { listItemsForPerson } from './query/people.js';

// Watchlist (Phosphor Wave 2 lane L3) — migrations/0017_watchlists.sql, see
// src/query/watchlist.ts header for the guard posture (mirrors src/query/
// progress.ts exactly: no content_class of its own, applyGuardToJoined on
// item_id) and the evidenced ADD-reachability decision for restricted
// items.
export type {
  ListWatchlistParams,
  ListWatchlistResult,
  RemoveFromWatchlistResult,
  WatchlistRow,
} from './query/watchlist.js';
export { addToWatchlistAndEmit, listWatchlist, removeFromWatchlistAndEmit } from './query/watchlist.js';

// Continue-watching / raw progress listing.
export type {
  ContinueWatchingRow,
  GetContinueWatchingParams,
  ListProgressParams,
  ListProgressResult,
  ProgressRow,
} from './query/progress.js';
export { getContinueWatching, listProgress } from './query/progress.js';

// Progress write (P1.17 additive — see src/query/progress-write.ts header).
export type { ProgressWriteRow, UpsertProgressInput } from './query/progress-write.js';
export { upsertProgress, getProgressForItem } from './query/progress-write.js';

// Image authorization choke-point (leak todo 4).
export type { GetImageEntityAccessParams, ImageEntityType, ImageRow } from './query/images.js';
export { getImageEntityAccess } from './query/images.js';

// Data export (docs/PLAN.md §8.4, leak todo 8).
export type {
  ExportChunk,
  ExportItemRow,
  ExportLibraryRow,
  ExportProgress,
  ExportProviderId,
  ExportUserRow,
} from './query/export.js';
export { exportData } from './query/export.js';

// Clearance digest (leak todo 6 — cache-key input).
export { clearanceDigest } from './query/clearance.js';

// Outbox read helper, query-layer half of leak todo 7 (socket delivery
// lands next wave on top of this — see src/query/events.ts header).
export type { EventRow, ReadEventsForViewerParams } from './query/events.js';
export { readEventsForViewer } from './query/events.js';

// Websocket broadcaster support (P1.17 deliverable H, delivery half of
// leak todo 7) — see src/query/events.ts's dedicated section header.
export { filterEventsForViewer, readUnprocessedEvents, markEventsProcessed } from './query/events.js';

// Test-support only — see src/testing.ts header.
export { ensureTestDatabase } from './testing.js';

// Hardware capability self-test snapshot (P1.14 identity-reads precedent —
// instance facts, not viewer-scoped catalog data) — see src/query/hwcaps.ts
// header for why this lives here rather than @loombre/db/internal.
export type {
  VerifiedCapabilities,
  VerifiedCapabilityBackend,
  HwCapabilitySnapshotSummary,
} from './query/hwcaps.js';
export { getCurrentHwCapabilitySnapshot, getCurrentVerifiedCapabilities } from './query/hwcaps.js';
export type { HwPlatform } from './types.js';

// Worker liveness from pg_stat_activity — the same "instance fact, not
// viewer-scoped catalog data" precedent as hwcaps above. apps/worker
// imports workerApplicationName to label its queue connection; the server's
// IPC status imports getWorkerLiveness to read it back.
export type { WorkerLiveness } from './query/worker-liveness.js';
export {
  getWorkerLiveness,
  workerApplicationName,
  WORKER_APPLICATION_NAME_PREFIX,
} from './query/worker-liveness.js';

// Catalog detail / hierarchy reads (satellite fields, genres, images,
// parent-chain resolution) — additive query surface, see
// src/query/catalog-detail.ts header for why this exists and how it stays
// guard-safe.
export type {
  CatalogDetail,
  GetCatalogDetailOptions,
  ImageDescriptor,
  ListCatalogItemsParams,
  ListCatalogItemsResult,
  MediaFileAudioTrackSummary,
  MediaFileSubtitleTrackSummary,
  MediaFileSummary,
  PersonCredit,
} from './query/catalog-detail.js';
export { getCatalogDetail, listCatalogItems } from './query/catalog-detail.js';

// Library creation (admin identity-plumbing, outbox-transactional) —
// P1.17/mission spec: "add a createLibrary function to the db PUBLIC
// barrel that does insert+event in one tx". See src/query/libraries.ts,
// which also carries the rest of the /libraries surface this wave needed
// (viewer-guarded list/get, admin CRUD + permissions writes — see that
// file's header addendum).
export type {
  CreateLibraryInput,
  LibraryRow,
  ListLibrariesForViewerParams,
  ListLibrariesForViewerResult,
  LibraryPermissionEntry,
  UpdateLibraryAdminInput,
  // Wave 1c (Phosphor retheme, "contract enablers" lane).
  LibraryItemCountRow,
} from './query/libraries.js';
export {
  createLibrary,
  listLibrariesForViewer,
  getLibraryForViewer,
  getLibraryByIdAdmin,
  updateLibraryAdmin,
  deleteLibraryAdmin,
  getLibraryPermissionsAdmin,
  putLibraryPermissionsAdmin,
  // Wave 1c (Phosphor retheme, "contract enablers" lane) — see
  // src/query/libraries.js's own "Wave 1c additions" section header.
  getLibraryItemCountsForViewer,
  listLibraryPathsAdmin,
} from './query/libraries.js';

// Restricted zone aggregate count (Wave 1c, Phosphor retheme "contract
// enablers" lane) — see src/query/restricted-zone.js header for the
// ground-truthed entitlement model (allowedLibraryIds carrying a
// restricted library id, independent of restrictedCleared) and the U10
// "visible regardless of lock state, count only" disclosure this
// implements. resolveEntitledRestrictedLibraryIds is exported (STATE.md
// Stash run K4) as the ONE entitlement resolver every restricted-zone
// query module below shares.
export type { RestrictedZoneCount } from './query/restricted-zone.js';
export { getRestrictedZoneCountForViewer, resolveEntitledRestrictedLibraryIds } from './query/restricted-zone.js';

// Restricted Content surface (STATE.md Stash run, S9) — the dedicated
// zone's own guarded, keyset-paginated query modules. SUPERSEDES the old
// "fetch the whole list client-side" design (K4): listRestrictedZoneItemsForViewer
// / GET /restricted/items is retired, replaced by real filtered/sorted
// server-side browse below. Every export here is entitlement-gated the
// SAME way (undefined for zero restricted-zone entitlement; a real,
// guard-filtered — possibly empty while locked — result otherwise), built
// entirely from src/query/guard.ts's primitives, so a leak here would have
// to defeat the same guard every other catalog read already relies on.
export type {
  RestrictedBrowseFilterParams,
  RestrictedBrowseItemRow,
  RestrictedBrowseSort,
  RestrictedBrowseOrder,
  RestrictedResolutionBand,
  RestrictedSceneDetail,
  RestrictedSceneChapter,
  RestrictedScenePersonChip,
  RestrictedSceneTagChip,
  ListRestrictedBrowseParams,
  ListRestrictedBrowseResult,
} from './query/restricted-browse.js';
export { getRestrictedSceneDetail, listRestrictedBrowse } from './query/restricted-browse.js';

export type {
  RestrictedPerformerRow,
  ListRestrictedPerformersParams,
  ListRestrictedPerformersResult,
} from './query/restricted-performers.js';
export {
  getRestrictedPerformerById,
  listRestrictedPerformers,
  listRestrictedPerformerScenes,
} from './query/restricted-performers.js';

export type {
  RestrictedStudioRow,
  ListRestrictedStudiosParams,
  ListRestrictedStudiosResult,
} from './query/restricted-studios.js';
export { getRestrictedStudioById, listRestrictedStudios } from './query/restricted-studios.js';

export type {
  RestrictedSearchResult,
  RestrictedSearchResultPage,
  SearchRestrictedZoneParams,
} from './query/restricted-search.js';
export { searchRestrictedZone } from './query/restricted-search.js';

export type {
  RestrictedZoneHome,
  RestrictedContinueWatchingEntry,
  RestrictedContinueWatchingProgress,
  GetRestrictedZoneHomeParams,
} from './query/restricted-home.js';
export { getRestrictedZoneHome } from './query/restricted-home.js';

// Chapters (STATE.md Stash run S7/K9, Lane E) — GET /items/{id}/chapters,
// the generic content-agnostic twin of RestrictedSceneDetail.chapters. See
// src/query/chapters.ts header for the visibility model (rides the owning
// item, house pattern).
export type { ChapterMarkerRow } from './query/chapters.js';
export { getChaptersForItem } from './query/chapters.js';

// Identity plumbing (users/user_settings/library_permissions/devices/
// refresh_tokens) — see src/query/identity.ts header for why this lives in
// the public barrel rather than @loombre/db/internal.
export type {
  UserRow,
  UserSettingsRow,
  DeviceRow,
  RefreshTokenRow,
  UpdateRestrictedSettingsInput,
  UpdateUserPrefsInput,
  LibraryPermissionSummary,
  CreateDeviceInput,
  UpdateDeviceForLoginInput,
  InsertRefreshTokenInput,
  CreateFirstAdminInput,
  CreateUserAdminAndEmitInput,
  ResetRestrictedPinInput,
  ResetRestrictedPinResult,
  ResetUserPasswordAdminInput,
} from './query/identity.js';
export {
  getUserByUsername,
  getUserByEmail,
  getUserById,
  getUserSettings,
  updateRestrictedSettings,
  updateUserPrefs,
  setRestrictedUnlockUntil,
  setRestrictedUnlockUntilAndEmit,
  // H2 — server-local CLI admin recovery path
  // (apps/server/src/cli/admin-reset-pin.ts); see src/query/identity.js's
  // resetRestrictedPinAndEmit doc comment for why this is never reachable
  // over HTTP.
  resetRestrictedPinAndEmit,
  getLibraryPermissionSummary,
  createDevice,
  getDeviceById,
  touchDevice,
  updateDeviceForLogin,
  insertRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshTokenById,
  revokeRefreshTokenChain,
  revokeRefreshTokensForDevice,
  // Password recovery (E3/M14/M15) — see src/query/identity.js's own doc
  // comments; revokeAllRefreshTokensForUser is also reused by
  // src/query/password-reset.js's resetPasswordViaTokenAndEmit. (F5's
  // sibling revokeOtherRefreshTokensForUser lives in src/query/admin.js
  // instead, private to that file — see its own doc comment for why.)
  revokeAllRefreshTokensForUser,
  resetUserPasswordAndEmit,
  // First-boot setup (STATE.md P4.6/P4.10) — see src/query/identity.js's
  // countUsers/createFirstAdminIfEmpty doc comments.
  countUsers,
  createFirstAdminIfEmpty,
  // Interactive user creation (POST /v1/users) — createUserAdmin's
  // outbox-transactional sibling. apps/server must never reach for the
  // non-emitting `createUserAdmin` below; see src/query/identity.js's
  // createUserAdminAndEmit doc comment for why the split exists.
  createUserAdminAndEmit,
} from './query/identity.js';

// Self-service password recovery, email tier (E3b/M15) — see
// src/query/password-reset.js header for the token posture (M3: same
// hashed-opaque-token shape as refresh_tokens) and
// resetPasswordViaTokenAndEmit's doc comment for the atomic-consume
// contract.
export type {
  PasswordResetTokenRow,
  IssuePasswordResetTokenInput,
  ResetPasswordViaTokenInput,
  ResetPasswordViaTokenResult,
} from './query/password-reset.js';
export {
  invalidateUnusedPasswordResetTokens,
  issuePasswordResetToken,
  resetPasswordViaTokenAndEmit,
} from './query/password-reset.js';

// Playback sessions (P2.4/P2.13/P2.14/P2.17, Wave-1 lane B) — see
// src/query/playback-sessions.ts header for guard posture (per-user scoped,
// not content_class-scoped) and the sweeper's deliberately-unguarded pair.
export type {
  PlaybackSessionRow,
  PlaybackSessionFileRow,
  CreatePlaybackSessionInput,
} from './query/playback-sessions.js';
export {
  createPlaybackSession,
  getPlaybackSessionForUser,
  getMediaFileForPlaybackSession,
  heartbeatPlaybackSession,
  endPlaybackSession,
  listStalePlaybackSessions,
  endStalePlaybackSession,
  updateRequestedSegment,
  requestSeek,
  listHeartbeatStalePlaybackSessions,
  suspendStalePlaybackSession,
  countActiveTranscodeSessions,
} from './query/playback-sessions.js';
export type { PlaybackSessionStatus } from './types.js';

// MediaInfo assembly (P2.17) — see src/query/media-info.ts header for why
// this package doesn't depend on @loombre/playback-engine's MediaInfo type
// directly (structural typing carries the shape instead).
export type {
  AssembledAudioStream,
  AssembledContainer,
  AssembledHdr,
  AssembledMediaInfo,
  AssembledSubtitleStream,
  AssembledVideoStream,
  GetMediaInfoAssemblyParams,
  MediaInfoAssembly,
} from './query/media-info.js';
export { getMediaInfoAssembly } from './query/media-info.js';

// Admin/self-service user CRUD, device list/revoke, job-ledger reads —
// additive query surface (P1.17), see src/query/admin.ts header for why
// these live here despite the "don't touch query/**" instruction.
export type {
  UserRow as AdminUserRow,
  DeviceRow as AdminDeviceRow,
  JobRow,
  ListUsersParams,
  ListUsersResult,
  CreateUserAdminInput,
  UpdateUserAdminInput,
  UpdateUserAdminResult,
  UpdateUserSelfInput,
  UpdateUserSelfResult,
  ListDevicesParams,
  ListDevicesResult,
  ListJobsParams,
  ListJobsResult,
  AdminSessionRow,
  ListActiveSessionsAdminParams,
  ListActiveSessionsAdminResult,
  UnmatchedLibraryItemRow,
  ListUnmatchedLibraryItemsParams,
  ListUnmatchedLibraryItemsResult,
  EnrichableCatalogItemAdminRow,
} from './query/admin.js';
export {
  listUsersAdmin,
  createUserAdmin,
  updateUserAdmin,
  deleteUserAdmin,
  updateUserSelf,
  listDevicesForUser,
  getDeviceForUser,
  deleteDeviceForUser,
  listJobsAdmin,
  getJobAdmin,
  listActiveSessionsAdmin,
  listUnmatchedLibraryItemsForViewer,
  getEnrichableCatalogItemForAdmin,
} from './query/admin.js';

// Invitations (E2, migrations/0023_user_invites.sql) — see src/query/
// invites.ts header for why this lives in the public barrel.
export type {
  InviteAdminRow,
  InviteStatus,
  InviteClaimStateRow,
  CreateInviteInput,
  ListInvitesParams,
  ListInvitesResult,
  ClaimInviteInput,
  ClaimInviteResult,
} from './query/invites.js';
export {
  createInviteAndEmit,
  listInvitesAdmin,
  revokeInviteAndEmit,
  getInviteByTokenHash,
  isInviteClaimable,
  mapClaimState,
  deriveInviteStatus,
  claimInviteAndEmit,
} from './query/invites.js';

// Email-collision notice ledger (G7, STATE.md "Current-password re-auth on
// self-changes") — see src/query/email-collision-notice.ts header.
export {
  EMAIL_COLLISION_NOTICE_WINDOW_MS,
  claimEmailCollisionNoticeWindow,
  releaseEmailCollisionNoticeWindow,
} from './query/email-collision-notice.js';

// Addendum A/A4 (STATE.md, admin-configurable server settings) —
// server_settings reads/writes + outbox emission, see src/query/
// settings.ts header for why this is public-barrel and registry-unaware.
export type {
  ServerSettingRow,
  UpsertServerSettingInput,
  UpsertServerSettingResult,
} from './query/settings.js';
export {
  listServerSettings,
  getServerSetting,
  upsertServerSettingAndEmit,
  emitRedactedSettingsUpdated,
} from './query/settings.js';

// LPP v1 (Lane W2) plugin registry — migrations/0014_plugins.sql, see
// src/query/plugins.ts header for the outbox-transactional emit-helper
// pattern (replicates src/query/settings.ts's upsertServerSettingAndEmit).
export type {
  PluginRow,
  PluginEventGrantRow,
  PluginWithGrants,
  RegisterPluginInput,
  UpdatePluginManifestInput,
  UpdatePluginConfigInput,
  SetPluginEnabledInput,
  ReapprovePluginInput,
  SetPluginHealthInput,
  TouchPluginHmacRotatedInput,
  RemovePluginInput,
  // Lane W5b additions — see src/query/plugins.ts's own section headers.
  SetPluginPseudonymizationInput,
  UpdatePluginEventGrantsInput,
} from './query/plugins.js';
export {
  listPlugins,
  getPluginById,
  getPluginByBaseUrl,
  getPluginEventGrants,
  insertPluginAndEmit,
  updatePluginManifestAndEmit,
  updatePluginConfigAndEmit,
  setPluginEnabledAndEmit,
  reapprovePluginAndEmit,
  setPluginHealthAndEmit,
  touchPluginHmacRotatedAndEmit,
  removePluginAndEmit,
  // Lane W5b: pseudonymization toggle + honest grants audit.
  setPluginPseudonymizationAndEmit,
  updatePluginEventGrantsAndEmit,
} from './query/plugins.js';
export type { PluginHealthState, PluginDisabledReason } from './types.js';

// LPP v1 (Lane W3) per-library metadata-provider chains —
// migrations/0015_library_provider_chains.sql, see src/query/
// library-provider-chains.ts header for why this is public-barrel and for
// the C5 STRICT write-time enforcement (layer 1 of that lane's three-layer
// defense-in-depth).
export type {
  LibraryProviderChainEntryInput,
  LibraryProviderEntryRow,
} from './query/library-provider-chains.js';
export {
  LibraryNotFoundError,
  LibraryProviderChainScopeError,
  PluginNotFoundError,
  InvalidLibraryProviderEntryError,
  getLibraryProviderChain,
  replaceLibraryProviderChain,
} from './query/library-provider-chains.js';
export type { LibraryProviderKind } from './types.js';

// LPP v1 (Lane W4) event-subscriber capability: outbox fanout delivery
// cursors + pseudonymization salt — migrations/
// 0016_plugin_delivery_cursors.sql, see src/query/plugins-delivery.ts
// header for why this module is protocol-agnostic (manifest returned
// verbatim, parsed worker-side) and for the deliberate split from
// src/query/plugins.ts's plugins.consecutive_failures breaker column.
export type {
  EventSubscriberPlugin,
  PluginCandidateEventRow,
  PluginDeliveryCursorRow,
  RecordDeliveryFailureInput,
  RecordDeliverySuccessInput,
} from './query/plugins-delivery.js';
export {
  advanceCursorPastFilteredEvents,
  ensurePseudonymSalt,
  findOldestUnconsumedBeforeMs,
  getDeliveryCursor,
  listCandidateEventsForDelivery,
  listEventSubscriberPlugins,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from './query/plugins-delivery.js';

// Keyset-cursor codec errors (R1 review lane): MalformedCursorError is the
// ONE thing apps/server needs from src/query/cursor.ts — a typed class so
// a controller can map "this client sent a cursor we did not mint" to a
// 4xx problem+json without string-matching an Error message (the same
// typed-error-across-the-boundary pattern LibraryNotFoundForStashError
// below already establishes). encode/decodeCursor themselves stay
// package-private: minting and interpreting cursors is the guarded query
// layer's job, never a caller's.
export { MalformedCursorError } from './query/cursor.js';

// Stash SQLite metadata sync, Lane A (provider core) — migrations/
// 0018_stash_provider_core.sql. See src/query/stash-connections.ts and
// src/query/stash-inventory.ts headers for why these live in the PUBLIC
// barrel without a ViewerContext (admin-only instance configuration /
// connection-health / matching bookkeeping, not a viewer-scoped catalog
// browse surface — same posture library-provider-chains.ts already
// establishes for itself).
export type { LibraryPathMappingRow, LibraryStashConnectionRow } from './query/stash-connections.js';
export {
  LibraryNotFoundForStashError,
  StashConnectionNotConfiguredError,
  deleteLibraryStashConnection,
  getLibraryPathMappings,
  getLibraryStashConnection,
  recordStashConnectionOutcome,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
} from './query/stash-connections.js';
export type {
  CandidateMediaFile,
  PathMappingMatchPreview,
  PathMappingPreviewUnmatchedScene,
  StashSceneLinkRow,
  StashSceneMatchResultInput,
  UpsertStashInventorySceneInput,
} from './query/stash-inventory.js';
export {
  applyStashSceneMatchResults,
  computePathMappingMatchPreview,
  listCandidateMediaFilesForLibrary,
  listStashSceneLinksForLibrary,
  upsertStashSceneLinksFromInventory,
} from './query/stash-inventory.js';
export type { StashConnectionStatus, StashMatchedBy } from './types.js';

// Stash SQLite metadata sync, Lane C (sync engine) — migrations/
// 0020_stash_sync_reports.sql. See src/query/stash-sync-reports.ts's
// header for why these live in the PUBLIC barrel (same posture as the
// Lane A stash exports immediately above): apps/worker (writing report
// rows) and apps/server's admin surface (K14, reading the latest report +
// the live unmatched/stale lists) are both fenced off from
// @loombre/db/internal.
export type {
  CreateStashSyncReportInput,
  FinishStashSyncReportInput,
  ListStashScenesParams,
  MarkStashScenesStaleInput,
  StashSceneLinkCounts,
  StashSyncReportRow,
  StashSyncSceneListResult,
  StashSyncSceneListRow,
  // FX3 fix wave: the Loombre-side twin of the Stash-side unmatched/stale
  // list types immediately above (S4/S8 "both unmatched sides" law).
  UnmatchedLoombreFileListResult,
  UnmatchedLoombreFileRow,
} from './query/stash-sync-reports.js';
export {
  createStashSyncReport,
  finishStashSyncReport,
  findRunningStashSyncReport,
  getLatestStashSyncReport,
  getStashSceneLinkCounts,
  getStashSyncReportByJobId,
  listStaleStashScenes,
  listUnmatchedLoombreFiles,
  listUnmatchedStashScenes,
  markStashScenesStale,
} from './query/stash-sync-reports.js';
export type { StashSyncMode, StashSyncReportStatus } from './types.js';
