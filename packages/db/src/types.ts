// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/types.ts
//
// Kysely `DB` interface. Models every table the catalog pipeline
// writes/reads internally (P1.13): catalog_items, its 7 satellite detail
// tables, media_files/media_streams, images, people/tags (+ join tables),
// provider_ids, metadata_provenance, provider_cache, scan_checkpoints,
// events, jobs, progress, libraries/library_permissions, users/
// user_settings, refresh_tokens, item_attributes, devices. Matches
// migrations/0001_init.sql + migrations/0002_phase1_catalog.sql exactly,
// including nullability and DEFAULT-bearing columns (wrapped in
// `Generated<T>` so Kysely's insert types make them optional).
//
// `devices` was added for P1.14 (real auth): login registers/refreshes a
// device row and refresh_tokens.device_id references it.
//
// `playback_sessions` was added for P2.4/P2.13/P2.14 (Wave-1 lane B):
// direct-play session rows, now with the status/error_code/updated_at_ms/
// last_heartbeat_ms columns migrations/0006_playback_sessions.sql adds on
// top of 0001_init.sql's original four columns. Still deliberately NOT
// modeled here: schema_migrations — outside the catalog pipeline's + auth's
// + playback's internal write/read surface this interface exists to cover.
//
// This is still the guard boundary for external callers: the public barrel
// (src/index.ts) exports only the guarded query functions in src/query/*,
// which are the only consumers of this file reachable from outside this
// package for *catalog_items* reads. The wider table surface added here
// backs src/internal (writer module, itself gated by
// @loombre/db/internal + the dependency-cruiser rule restricting who may
// import that subpath) and is never re-exported from the public barrel.

import type { ColumnType, Generated } from 'kysely';

export type ItemType =
  | 'movie'
  | 'series'
  | 'season'
  | 'episode'
  | 'artist'
  | 'album'
  | 'track';

export type ContentClass = 'general' | 'restricted';

export type WatchState = 'unplayed' | 'in-progress' | 'played';

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';

export type PersonRole =
  | 'actor'
  | 'director'
  | 'writer'
  | 'artist'
  | 'album_artist'
  | 'performer'
  | 'guest';

export type ImageKind = 'poster' | 'backdrop' | 'logo' | 'disc' | 'thumb';

export type ImageSource = 'provider' | 'embedded' | 'local';

export type MediaKind = 'movie' | 'tv' | 'music';

export type StreamType = 'video' | 'audio' | 'subtitle';

export type SeriesStatus = 'continuing' | 'ended' | 'cancelled';

/** migrations/0006_playback_sessions.sql + migrations/0012_transcode_sessions.sql
 *  — the full contract PlaybackSessionStatus enum (packages/contract/
 *  openapi.yaml) as of Phase 3 §11 step 6a: Phase 2 used only
 *  created/active/ended/failed; 0012 adds starting/suspended/seeking for
 *  the HLS transcode session state machine (docs/PLAYBACK.md §9). */
export type PlaybackSessionStatus =
  | 'created'
  | 'starting'
  | 'active'
  | 'suspended'
  | 'seeking'
  | 'ended'
  | 'failed';

export type ItemTagKind = 'genre' | 'tag' | 'studio';

/** Entity-level tag kind (migrations/0019, K2/S6): what kind of thing the
 *  tag names — distinct from ItemTagKind, which classifies one edge. */
export type TagKind = 'general' | 'genre' | 'studio';

/** migrations/0002_phase1_catalog.sql */
export type HdrType = 'none' | 'hdr10' | 'hlg' | 'dv';

// ============================================================================
// users / user_settings
// ============================================================================

export interface UsersTable {
  id: Generated<string>;
  username: string;
  /** migrations/0023_user_invites.sql (M1): CITEXT NOT NULL UNIQUE loosened
   *  to CITEXT NULL UNIQUE — an additive DROP NOT NULL, not a new column.
   *  An email-less user authenticates by username only. */
  email: string | null;
  password_hash: string;
  birth_date: string | null;
  max_content_rating: string | null;
  is_admin: Generated<boolean>;
  /** migrations/0023_user_invites.sql (M2): the H1 bug-class fix — the
   *  contract's User.displayName had nowhere to persist until this column
   *  existed. NULL = unset. */
  display_name: string | null;
  /** migrations/0024_password_recovery.sql (E3a/M14) — set by an admin/CLI
   *  temporary-password reset, cleared on the next successful self-service
   *  password change. */
  must_change_password: Generated<boolean>;
  /** migrations/0026_password_changed_epoch.sql (R-F7) — the credentials-
   *  changed epoch; NULL until the first password change. Set alongside
   *  password_hash by every password-change path (self-service, admin/CLI
   *  reset, self-service token reset). apps/server/src/gateway/
   *  auth.guard.ts rejects an access token whose iat predates this. */
  password_changed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface UserSettingsTable {
  user_id: string;
  restricted_opt_in: Generated<boolean>;
  restricted_pin_hash: string | null;
  restricted_unlocked_until_ms: number | null;
  prefs: Generated<Record<string, unknown>>;
  updated_at_ms: number;
}

// ============================================================================
// libraries / library_permissions
// ============================================================================

export interface LibrariesTable {
  id: Generated<string>;
  name: string;
  media_kind: MediaKind;
  paths: Generated<string[]>;
  content_class: Generated<ContentClass>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface LibraryPermissionsTable {
  user_id: string;
  library_id: string;
  granted_at_ms: number;
}

// ============================================================================
// devices (P1.14 — login registers/refreshes a device row)
// ============================================================================

/** migrations/0030_wg_peers.sql (STATE.md "Loombre Remote", RG3, lane WG2):
 *  'app' (default — every login-created device) or 'remote' (admin-
 *  initiated WireGuard enrollment ONLY, packages/db/src/query/wg-peers.ts —
 *  never the login-driven createDevice path). */
export type DeviceKind = 'app' | 'remote';

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  platform: string | null;
  /** Legacy single-hash column from 0001_init.sql, superseded by the
   *  rotating refresh_tokens table (0002_phase1_catalog.sql, P1.14) — left
   *  unused by the auth write path added here, not migrated away (out of
   *  this wave's scope). */
  refresh_token_hash: string | null;
  profile: Generated<Record<string, unknown>>;
  last_seen_ms: number | null;
  created_at_ms: number;
  kind: Generated<DeviceKind>;
}

// ============================================================================
// catalog_items
// ============================================================================

export interface CatalogItemsTable {
  id: Generated<string>;
  library_id: string;
  item_type: ItemType;
  parent_id: string | null;
  title: string;
  sort_title: string;
  year: number | null;
  community_rating: number | null;
  /** Overwritten server-side by the catalog_items_enforce_content_class
   *  trigger regardless of what a caller supplies — still has a DEFAULT. */
  content_class: Generated<ContentClass>;
  added_at_ms: number;
  updated_at_ms: number;
  /** GENERATED ALWAYS AS (...) STORED — never insertable/updatable. */
  search_tsv: ColumnType<string, never, never>;
}

// ============================================================================
// Satellites (1:1, FK = PK) — one per item_type
// ============================================================================

export interface MovieDetailsTable {
  item_id: string;
  content_rating: string | null;
  runtime_ms: number | null;
  tagline: string | null;
  overview: string | null;
  premiere_at_ms: number | null;
}

export interface SeriesDetailsTable {
  item_id: string;
  content_rating: string | null;
  status: SeriesStatus | null;
  overview: string | null;
}

export interface SeasonDetailsTable {
  item_id: string;
  season_number: number;
}

export interface EpisodeDetailsTable {
  item_id: string;
  episode_number: number;
  aired_at_ms: number | null;
  overview: string | null;
}

export interface ArtistDetailsTable {
  item_id: string;
  overview: string | null;
}

export interface AlbumDetailsTable {
  item_id: string;
  year: number | null;
}

export interface TrackDetailsTable {
  item_id: string;
  track_number: number | null;
  disc_number: number | null;
  duration_ms: number | null;
}

// ============================================================================
// provider_ids
// ============================================================================

export interface ProviderIdsTable {
  id: Generated<string>;
  item_id: string;
  provider: string;
  external_id: string;
}

// ============================================================================
// people / item_people
// ============================================================================

export interface PeopleTable {
  id: Generated<string>;
  name: string;
  content_class: Generated<ContentClass>;
}

export interface ItemPeopleTable {
  id: Generated<string>;
  item_id: string;
  person_id: string;
  role: PersonRole;
  credit: string | null;
  ord: Generated<number>;
}

// ============================================================================
// tags / item_tags
// ============================================================================

export interface TagsTable {
  id: Generated<string>;
  name: string;
  content_class: Generated<ContentClass>;
  kind: Generated<TagKind>;
  parent_tag_id: string | null;
}

export interface ItemTagsTable {
  id: Generated<string>;
  item_id: string;
  tag_id: string;
  kind: Generated<ItemTagKind>;
}

// ============================================================================
// item_attributes
// ============================================================================

export interface ItemAttributesTable {
  id: Generated<string>;
  item_id: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
}

// ============================================================================
// person_attributes (migrations/0019 — K3: person-scoped twin of
// item_attributes; namespaced sandbox, core code never reads it)
// ============================================================================

export interface PersonAttributesTable {
  id: Generated<string>;
  person_id: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
}

// ============================================================================
// chapter_markers (migrations/0019 — K9/S7: Stash markers -> chapters)
// ============================================================================

export type ChapterMarkerSource = 'stash';

export interface ChapterMarkersTable {
  id: Generated<string>;
  item_id: string;
  title: string;
  start_ms: number;
  source: ChapterMarkerSource;
}

// ============================================================================
// media_files / media_streams
// ============================================================================

export interface MediaFilesTable {
  id: Generated<string>;
  item_id: string;
  path: string;
  content_hash: string | null;
  size_bytes: number | null;
  container: string | null;
  duration_ms: number | null;
  probe: Record<string, unknown> | null;
  probed_at_ms: number | null;
  missing_since_ms: number | null;
  /** migrations/0003_media_files_version_label.sql */
  version_label: string | null;
  /** migrations/0010_media_files_mtime_ms.sql — filesystem mtime (integer
   *  ms) at last hash/probe; NULL for a legacy row not yet observed since
   *  this column landed. See that migration's column comment. */
  mtime_ms: number | null;
}

export interface MediaStreamsTable {
  id: Generated<string>;
  file_id: string;
  stream_index: number;
  stream_type: StreamType;
  codec: string | null;
  profile: string | null;
  level: string | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  color_transfer: string | null;
  channels: number | null;
  sample_rate: number | null;
  bitrate_bps: number | null;
  frame_rate: number | null;
  language: string | null;
  is_default: Generated<boolean>;
  is_forced: Generated<boolean>;
  /** migrations/0002_phase1_catalog.sql — video-only, NULL for other
   *  stream_type values and for unprobed video streams. */
  hdr: HdrType | null;
  dv_profile: number | null;
  dv_bl_compat_id: number | null;
  /** migrations/0002_phase1_catalog.sql — audio-only. */
  has_atmos: boolean | null;
  /** migrations/0002_phase1_catalog.sql — video-only. */
  interlaced: boolean | null;
}

// ============================================================================
// progress
// ============================================================================

export interface ProgressTable {
  user_id: string;
  item_id: string;
  position_ms: Generated<number>;
  state: Generated<WatchState>;
  play_count: Generated<number>;
  updated_at_ms: number;
  /** migrations/0006_playback_sessions.sql — contract Progress.durationMs;
   *  client-supplied snapshot, never independently probed by this table. */
  duration_ms: number | null;
}

// ============================================================================
// watchlists (migrations/0017_watchlists.sql — Phosphor Wave 2 lane L3)
// ============================================================================

export interface WatchlistsTable {
  user_id: string;
  item_id: string;
  added_at_ms: number;
}

// ============================================================================
// playback_sessions (0001_init.sql + migrations/0006_playback_sessions.sql)
// ============================================================================

export interface PlaybackSessionsTable {
  id: Generated<string>;
  user_id: string;
  device_id: string | null;
  file_id: string | null;
  plan: Record<string, unknown> | null;
  engine_version: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  status: Generated<PlaybackSessionStatus>;
  error_code: string | null;
  updated_at_ms: number;
  last_heartbeat_ms: number | null;
  /** Migration 0007 (P2.8 websocket-presence lane): the throttle marker for
   *  playback.progress emission — see that migration's header. */
  last_progress_event_at_ms: number | null;
  /** migrations/0012_transcode_sessions.sql — see that file's column
   *  comments for the full worker/server write-ownership split. */
  staging_dir: string | null;
  requested_segment: number | null;
  produced_segment: number | null;
  seek_target_ms: number | null;
  discontinuity_count: Generated<number>;
  suspended_by_throttle: Generated<boolean>;
  stderr_tail: string | null;
}

// ============================================================================
// events (outbox)
// ============================================================================

export interface EventsTable {
  id: Generated<string>;
  type: string;
  ts_ms: number;
  actor_user_id: string | null;
  payload: Generated<Record<string, unknown>>;
  processed_at_ms: number | null;
}

// ============================================================================
// jobs — queue-agnostic ledger
// ============================================================================

export interface JobsTable {
  id: Generated<string>;
  type: string;
  status: Generated<JobStatus>;
  priority: Generated<number>;
  attempts: Generated<number>;
  last_error: string | null;
  subject_item_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

// ============================================================================
// images
// ============================================================================

export interface ImagesTable {
  id: Generated<string>;
  entity_type: string;
  entity_id: string;
  kind: ImageKind;
  source: ImageSource;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** '#rrggbb' | '' (unavailable sentinel) | null (not yet computed) —
   *  migrations/0005_images_dominant_color.sql. See that file's comment for
   *  the NULL vs '' distinction. */
  dominant_color: string | null;
  file_path: string;
  created_at_ms: number;
}

// ============================================================================
// migrations/0002_phase1_catalog.sql tables
// ============================================================================

export interface ScanCheckpointsTable {
  /** No DEFAULT — supplied by the caller (the scan job's own id), not
   *  self-generated (migrations/0002_phase1_catalog.sql). */
  job_id: string;
  library_id: string;
  phase: string;
  last_processed_path: string | null;
  files_seen: Generated<number>;
  files_processed: Generated<number>;
  /** FW2-E/AUD-A2d-003 (migrations/0033_scan_checkpoint_item_counters.sql)
   *  — running totals across every attempt of this job, carried the same
   *  way files_processed already is. */
  items_added: Generated<number>;
  items_updated: Generated<number>;
  items_removed: Generated<number>;
  updated_at_ms: number;
}

export interface ProviderCacheTable {
  id: Generated<string>;
  provider: string;
  request_hash: string;
  body: string;
  fetched_at_ms: number;
  expires_at_ms: number;
}

export interface MetadataProvenanceTable {
  id: Generated<string>;
  item_id: string;
  field: string;
  source: string;
  locked: Generated<boolean>;
  updated_at_ms: number;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
  rotated_from: string | null;
  revoked_at_ms: number | null;
}

/** migrations/0024_password_recovery.sql (E3b/M15) — self-service
 *  password-reset tokens; see that migration's COMMENT ON TABLE for the
 *  atomic-consume/invalidation-by-supersession contract. */
export interface PasswordResetTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  created_at_ms: number;
  expires_at_ms: number;
  used_at_ms: number | null;
}

/** migrations/0025_email_collision_notice_ledger.sql (G7, STATE.md
 *  "Current-password re-auth on self-changes"): per-address 24h rate-limit
 *  window for the email-in-use security notice; see that migration's
 *  COMMENT ON TABLE. `email` (CITEXT) is the primary key — one row per
 *  address ever notified, overwritten (never appended) on every successful
 *  window claim. */
export interface EmailCollisionNoticeLedgerTable {
  email: string;
  last_notice_at_ms: number;
}

// ============================================================================
// user_invites / user_invite_grants
// (migrations/0023_user_invites.sql — E2, M3/M4)
// ============================================================================

export interface UserInvitesTable {
  id: Generated<string>;
  token_hash: string;
  created_by: string;
  created_at_ms: number;
  expires_at_ms: number;
  username_preset: string | null;
  display_name_preset: string | null;
  email: string | null;
  claimed_at_ms: number | null;
  claimed_user_id: string | null;
  revoked_at_ms: number | null;
}

export interface UserInviteGrantsTable {
  invite_id: string;
  library_id: string;
}

// ============================================================================
// system_notices (migrations/0028_system_notices.sql — admin broadcast
// notifications, N1/NG4/NG8)
// ============================================================================

export type NoticeSeverity = 'info' | 'warning' | 'critical';

export interface SystemNoticesTable {
  id: Generated<string>;
  message: string;
  severity: NoticeSeverity;
  effective_at_ms: number | null;
  expires_at_ms: number | null;
  created_by: string | null;
  created_at_ms: number;
  cancelled_at_ms: number | null;
}

// ============================================================================
// remote_tunnel_state (migrations/0032_remote_tunnel_state.sql — Loombre
// Remote Tunnel path, STATE.md R4/R9/RG7, lane T1). Singleton row (id
// always 1) -- see the migration's own COMMENT ON TABLE for the full
// enabled/cleared-together discipline.
// =====================================================================
export interface RemoteTunnelStateTable {
  id: Generated<number>;
  enabled: Generated<boolean>;
  hostname: string | null;
  tunnel_id: string | null;
  account_id: string | null;
  zone_id: string | null;
  dns_record_id: string | null;
  enabled_at_ms: number | null;
}

// ============================================================================
// probe_tokens (migrations/0031_probe_tokens.sql — Loombre Remote's
// one-time-token reachability proof, R6/RG6, Lane P1)
// ============================================================================

/** Deliberately narrower than the contract's RemotePathId (no 'none' — a
 *  probe always proves ONE specific path's setup flow). See the migration
 *  file's own header for why this mirrors packages/shared/src/remote/
 *  wizard-state.ts's PathId rather than the contract's wider union. */
export type RemoteProbePath = 'remote' | 'tunnel' | 'direct';

export interface ProbeTokensTable {
  id: Generated<string>;
  token_hash: string;
  expected_endpoint: string;
  path: RemoteProbePath;
  created_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  arrived_at_ms: number | null;
}

// ============================================================================
// hw_capability_snapshots / hw_capability_backends
// (migrations/0011_hw_capability_snapshots.sql — Phase 3 §11 step 5)
// ============================================================================

/** `os.platform()` value the snapshot was verified on — CHECK-constrained
 *  to these three in the migration (the only platforms docs/PLAYBACK.md
 *  §8.2 gives a candidate order for). */
export type HwPlatform = 'darwin' | 'linux' | 'win32';

export interface HwCapabilitySnapshotsTable {
  id: Generated<string>;
  ffmpeg_build_hash: string;
  gpu_fingerprint: Generated<string>;
  platform: HwPlatform;
  verified_at_ms: number;
  is_current: Generated<boolean>;
}

/** `backend`/`decode`/`encode`/`tone_map` are plain TEXT/TEXT[] at the SQL
 *  level (CHECK-constrained, not native enums — see the migration's column
 *  typing note) but typed as their closed §2.5 unions here, matching every
 *  other Selectable-facing convention in this file. */
export interface HwCapabilityBackendsTable {
  id: Generated<string>;
  snapshot_id: string;
  position: number;
  backend: 'videotoolbox' | 'qsv' | 'vaapi' | 'nvenc' | 'amf' | 'd3d11va' | 'software';
  decode: ('h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg2' | 'vc1' | 'mpeg4' | 'unknown')[];
  encode: ('h264' | 'hevc' | 'av1')[];
  tone_map: ('opencl' | 'vulkan' | 'videotoolbox' | 'cuda' | 'none')[];
  verified_at_ms: number;
}

// ============================================================================
// server_settings (migrations/0013_server_settings.sql — Addendum A/A4)
// ============================================================================

export interface ServerSettingsTable {
  key: string;
  /** JSONB — shape is whatever the matching packages/shared registry
   *  entry's zod schema declares; untyped here on purpose (this table has
   *  no registry knowledge, see src/query/settings.ts's header). */
  value: unknown;
  updated_at_ms: number;
  updated_by: string | null;
}

// ============================================================================
// plugins / plugin_event_grants (migrations/0014_plugins.sql — LPP v1, Lane W2)
// ============================================================================

export type PluginHealthState = 'unknown' | 'healthy' | 'unhealthy';

/** CHECK-constrained TEXT at the SQL level (migrations/0014_plugins.sql's
 *  column comment — mirrors the hw_capability_backends precedent), typed as
 *  its closed union here like every other Selectable-facing convention in
 *  this file. */
export type PluginDisabledReason = 'admin' | 'breaker' | 'scope-change';

export interface PluginsTable {
  id: Generated<string>;
  name: string;
  base_url: string;
  version: string;
  protocol_version: number;
  enabled: Generated<boolean>;
  content_class: Generated<ContentClass>;
  granted_capability_types: Generated<string[]>;
  health_state: Generated<PluginHealthState>;
  consecutive_failures: Generated<number>;
  last_health_check_ms: number | null;
  last_ok_ms: number | null;
  disabled_reason: PluginDisabledReason | null;
  lan_allowlist: Generated<string[]>;
  /** JSONB — verbatim GET /lpp/manifest snapshot. CLAUDE.md invariant 3
   *  whitelist entry 8. Opaque here, never queried field-by-field. */
  manifest: Record<string, unknown>;
  /** JSONB — non-secret configSchema field values only (LD1). CLAUDE.md
   *  invariant 3 whitelist entry 9. */
  config: Generated<Record<string, unknown>>;
  created_at_ms: number;
  updated_at_ms: number;
  approved_at_ms: number;
  /** migrations/0016_plugin_delivery_cursors.sql (Lane W4, additive ALTER)
   *  — see that migration's column comment. */
  pseudonymize_actor_ids: Generated<boolean>;
  /** migrations/0016_plugin_delivery_cursors.sql — see that migration's
   *  column comment. */
  pseudonym_salt: string | null;
}

export interface PluginEventGrantsTable {
  id: Generated<string>;
  plugin_id: string;
  event_type: string;
  granted_at_ms: number;
}

// ============================================================================
// plugin_delivery_cursors (migrations/0016_plugin_delivery_cursors.sql —
// LPP v1, Lane W4) — see that migration's table/column comments for the
// full rationale of every field here.
// ============================================================================

export interface PluginDeliveryCursorsTable {
  plugin_id: string;
  cursor_event_id: string | null;
  last_attempt_ms: number | null;
  last_success_ms: number | null;
  consecutive_failures: Generated<number>;
  delivered_batches: Generated<number>;
  delivered_events: Generated<number>;
  gap_reported_through_ms: number | null;
}

// ============================================================================
// library_provider_entries (migrations/0015_library_provider_chains.sql —
// LPP v1, Lane W3)
// ============================================================================

export type LibraryProviderKind = 'builtin' | 'plugin';

export interface LibraryProviderEntriesTable {
  id: Generated<string>;
  library_id: string;
  position: number;
  provider_kind: LibraryProviderKind;
  builtin_name: string | null;
  plugin_id: string | null;
}

// ============================================================================
// library_stash_connections / library_path_mappings / stash_scene_links
// (migrations/0018_stash_provider_core.sql — Stash SQLite metadata sync,
// Lane A provider core)
// ============================================================================

export type StashConnectionStatus = 'never_connected' | 'ok' | 'unsupported_schema' | 'unreachable';

export interface LibraryStashConnectionsTable {
  id: Generated<string>;
  library_id: string;
  sqlite_path: string;
  enabled: Generated<boolean>;
  status: Generated<StashConnectionStatus>;
  status_detail: string | null;
  last_seen_schema_version: number | null;
  last_connected_at_ms: number | null;
  last_checked_at_ms: number | null;
  genre_tag_names: string[] | null;
  stash_blobs_path: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface LibraryPathMappingsTable {
  id: Generated<string>;
  library_id: string;
  stash_prefix: string;
  loombre_prefix: string;
  position: number;
}

export type StashMatchedBy = 'path' | 'oshash';

export interface StashSceneLinksTable {
  id: Generated<string>;
  library_id: string;
  stash_scene_id: string;
  stash_path: string;
  stash_oshash: string | null;
  stash_size_bytes: number | null;
  stash_updated_at_ms: number | null;
  item_id: string | null;
  matched_by: StashMatchedBy | null;
  stale: Generated<boolean>;
  last_synced_at_ms: number;
}

// ============================================================================
// stash_sync_reports / stash_sync_checkpoints
// (migrations/0020_stash_sync_reports.sql — Stash SQLite metadata sync,
// Lane C sync engine, S8/K14)
// ============================================================================

export type StashSyncMode = 'full' | 'incremental';

export type StashSyncReportStatus = 'running' | 'succeeded' | 'failed' | 'partial';

export interface StashSyncReportsTable {
  id: Generated<string>;
  library_id: string;
  job_id: string;
  mode: StashSyncMode;
  status: Generated<StashSyncReportStatus>;
  matched_count: Generated<number>;
  updated_count: Generated<number>;
  unmatched_count: Generated<number>;
  stale_count: Generated<number>;
  skipped_count: Generated<number>;
  started_at_ms: number;
  finished_at_ms: number | null;
  /** FX4 fix wave (migrations/0022_stash_sync_report_snapshot.sql, S2):
   *  NULL means unknown (never fabricated to 'read from source'). */
  used_snapshot_fallback: boolean | null;
}

export interface StashSyncCheckpointsTable {
  /** No DEFAULT — supplied by the caller (the sync job's own id), same
   *  convention as ScanCheckpointsTable.job_id above. */
  job_id: string;
  library_id: string;
  phase: string;
  last_processed_stash_scene_id: string | null;
  scenes_seen: Generated<number>;
  scenes_processed: Generated<number>;
  updated_at_ms: number;
}

// ============================================================================
// remote_wireguard_state (migrations/0029_remote_wireguard_state.sql —
// STATE.md "Loombre Remote", lane WG1, R1/R2/R9)
// ============================================================================

export interface RemoteWireguardStateTable {
  id: boolean;
  server_public_key: string | null;
  enabled: boolean;
  enabled_at_ms: number | null;
  updated_at_ms: number;
}

// ============================================================================
// wg_peers (migrations/0030_wg_peers.sql — STATE.md "Loombre Remote",
// R2/R9/RG3/RG9, lane WG2). device_id IS the primary key (1:1 with
// devices(kind='remote')) -- see the migration's own COMMENT ON TABLE.
// NO PRIVATE KEY COLUMN, EVER (R9).
// ============================================================================

export interface WgPeersTable {
  device_id: string;
  public_key: string;
  tunnel_ip: string;
  created_at_ms: number;
}

// ============================================================================
// DB
// ============================================================================

export interface DB {
  users: UsersTable;
  user_settings: UserSettingsTable;
  libraries: LibrariesTable;
  library_permissions: LibraryPermissionsTable;
  devices: DevicesTable;
  catalog_items: CatalogItemsTable;
  movie_details: MovieDetailsTable;
  series_details: SeriesDetailsTable;
  season_details: SeasonDetailsTable;
  episode_details: EpisodeDetailsTable;
  artist_details: ArtistDetailsTable;
  album_details: AlbumDetailsTable;
  track_details: TrackDetailsTable;
  provider_ids: ProviderIdsTable;
  people: PeopleTable;
  item_people: ItemPeopleTable;
  tags: TagsTable;
  item_tags: ItemTagsTable;
  item_attributes: ItemAttributesTable;
  person_attributes: PersonAttributesTable;
  chapter_markers: ChapterMarkersTable;
  media_files: MediaFilesTable;
  media_streams: MediaStreamsTable;
  progress: ProgressTable;
  watchlists: WatchlistsTable;
  playback_sessions: PlaybackSessionsTable;
  events: EventsTable;
  jobs: JobsTable;
  images: ImagesTable;
  scan_checkpoints: ScanCheckpointsTable;
  provider_cache: ProviderCacheTable;
  metadata_provenance: MetadataProvenanceTable;
  refresh_tokens: RefreshTokensTable;
  user_invites: UserInvitesTable;
  user_invite_grants: UserInviteGrantsTable;
  password_reset_tokens: PasswordResetTokensTable;
  hw_capability_snapshots: HwCapabilitySnapshotsTable;
  hw_capability_backends: HwCapabilityBackendsTable;
  server_settings: ServerSettingsTable;
  plugins: PluginsTable;
  plugin_event_grants: PluginEventGrantsTable;
  library_provider_entries: LibraryProviderEntriesTable;
  plugin_delivery_cursors: PluginDeliveryCursorsTable;
  library_stash_connections: LibraryStashConnectionsTable;
  library_path_mappings: LibraryPathMappingsTable;
  stash_scene_links: StashSceneLinksTable;
  stash_sync_reports: StashSyncReportsTable;
  stash_sync_checkpoints: StashSyncCheckpointsTable;
  email_collision_notice_ledger: EmailCollisionNoticeLedgerTable;
  system_notices: SystemNoticesTable;
  remote_tunnel_state: RemoteTunnelStateTable;
  probe_tokens: ProbeTokensTable;
  remote_wireguard_state: RemoteWireguardStateTable;
  wg_peers: WgPeersTable;
}
