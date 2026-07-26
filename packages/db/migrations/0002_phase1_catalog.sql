-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0002_phase1_catalog
--
-- Additive-only (P1.10-P1.12, P1.14): no column drops, no type narrowing, no
-- rewriting of 0001_init.sql. See that file's header for the schema.sql
-- generation/verification algorithm this migration is replayed under.
--
-- Conventions carried forward from 0001 (docs/PLAN.md §6.2, CLAUDE.md):
--   * UUIDv7 primary keys via loombre_uuidv7().
--   * All timestamps are BIGINT epoch milliseconds, columns suffixed `_ms`.
--   * Postgres enums for closed enumerations.
--   * Every foreign key states ON DELETE explicitly.
--   * JSONB stays confined to the plan §6.3 whitelist (0001's comment); none
--     of the tables/columns added here introduce a new JSONB use — see each
--     table's own comment for why (provider_cache.body is deliberately TEXT).

-- ============================================================================
-- media_streams: typed HDR / Dolby Vision / interlace / Atmos extraction
-- ============================================================================
-- docs/PLAYBACK.md §2.1 VideoStream/AudioStream: these fields are populated
-- by the probe worker only for the matching stream_type and stay NULL for
-- every other stream_type (e.g. `has_atmos` is meaningful only when
-- stream_type = 'audio'; `hdr`/`dv_profile`/`dv_bl_compat_id`/`interlaced`
-- only when stream_type = 'video'). This is intentionally not split into
-- per-type satellite tables — media_streams already carries other
-- video/audio-only nullable columns (width/height vs channels/sample_rate)
-- under the same convention (0001_init.sql).

CREATE TYPE hdr_type AS ENUM ('none', 'hdr10', 'hlg', 'dv');

ALTER TABLE media_streams ADD COLUMN hdr             hdr_type NULL;
ALTER TABLE media_streams ADD COLUMN dv_profile      SMALLINT NULL;
ALTER TABLE media_streams ADD COLUMN dv_bl_compat_id SMALLINT NULL;
ALTER TABLE media_streams ADD COLUMN has_atmos       BOOLEAN NULL;
ALTER TABLE media_streams ADD COLUMN interlaced      BOOLEAN NULL;

COMMENT ON COLUMN media_streams.hdr IS
  'Video-only (docs/PLAYBACK.md §2.1 VideoStream.hdr), derived from '
  'color_transfer + side data at probe time. NULL for non-video streams and '
  'for video streams not yet probed.';

COMMENT ON COLUMN media_streams.dv_profile IS
  'Video-only; Dolby Vision profile (5|7|8) when hdr = ''dv''. NULL '
  'otherwise (docs/PLAYBACK.md §2.1).';

COMMENT ON COLUMN media_streams.dv_bl_compat_id IS
  'Video-only; DV profile 8.1 HDR10-compatible base-layer compatibility id. '
  'NULL unless applicable (docs/PLAYBACK.md §2.1, Stage C).';

COMMENT ON COLUMN media_streams.has_atmos IS
  'Audio-only (docs/PLAYBACK.md §2.1 AudioStream.hasAtmos); TrueHD/EAC3 JOC '
  'side-data detection. NULL for non-audio streams.';

COMMENT ON COLUMN media_streams.interlaced IS
  'Video-only (docs/PLAYBACK.md §2.1 VideoStream.interlaced). NULL for '
  'non-video streams.';

-- ============================================================================
-- scan_checkpoints (P1.12) — resumable scanner progress, one row per job
-- ============================================================================

CREATE TABLE scan_checkpoints (
  job_id               UUID PRIMARY KEY,
  library_id           UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  phase                TEXT NOT NULL,
  last_processed_path  TEXT NULL,
  files_seen           INTEGER NOT NULL DEFAULT 0,
  files_processed      INTEGER NOT NULL DEFAULT 0,
  updated_at_ms        BIGINT NOT NULL
);

COMMENT ON TABLE scan_checkpoints IS
  'Resumable progress for a running/interrupted scan job (P1.12): typed '
  'columns only, no JSONB — the scanner reads (phase, last_processed_path) '
  'back to resume a crashed or restarted job without rescanning from '
  'scratch. job_id is not a FK to jobs(id): the checkpoint row is created '
  'when the scan starts and the ledger row lifecycle is independent '
  '(@loombre/jobs owns jobs; this table is scanner-internal state).';

CREATE INDEX scan_checkpoints_library_id_idx ON scan_checkpoints (library_id);

-- ============================================================================
-- provider_cache (P1.11) — raw metadata-provider response cache
-- ============================================================================

CREATE TABLE provider_cache (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  provider       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  body           TEXT NOT NULL,
  fetched_at_ms  BIGINT NOT NULL,
  expires_at_ms  BIGINT NOT NULL,
  UNIQUE (provider, request_hash)
);

COMMENT ON TABLE provider_cache IS
  'Raw serialized-JSON response cache for metadata providers (tmdb/tvdb/'
  'musicbrainz), keyed by a hash of the request. `body` is deliberately '
  'TEXT, not JSONB: the JSONB whitelist (docs/PLAN.md §6.3 / CLAUDE.md '
  'invariant 3) is closed, and this cache is opaque bytes that are never '
  'queried into — only fetched whole and re-parsed by the caller.';

CREATE INDEX provider_cache_expires_at_ms_idx ON provider_cache (expires_at_ms);

-- ============================================================================
-- metadata_provenance (P1.7) — field-level provenance + editorial locks
-- ============================================================================

CREATE TABLE metadata_provenance (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id        UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  field          TEXT NOT NULL,
  source         TEXT NOT NULL,
  locked         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at_ms  BIGINT NOT NULL,
  UNIQUE (item_id, field)
);

COMMENT ON TABLE metadata_provenance IS
  'One row per (item, field) naming which source last wrote that field '
  '(''nfo'', ''tag'', ''provider:tmdb'', ''provider:tvdb'', '
  '''provider:musicbrainz'', ''filename'') and whether a user has locked it '
  'against future scanner/provider overwrites (docs/PLAN.md §8.1 refresh '
  'precedence). Field-level, not row-level: two fields on the same item can '
  'independently have different sources and lock states.';

CREATE INDEX metadata_provenance_item_id_idx ON metadata_provenance (item_id);

-- ============================================================================
-- refresh_tokens (P1.14) — rotating session refresh tokens
-- ============================================================================

CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  issued_at_ms    BIGINT NOT NULL,
  expires_at_ms   BIGINT NOT NULL,
  rotated_from    UUID NULL,
  revoked_at_ms   BIGINT NULL
);

COMMENT ON COLUMN refresh_tokens.device_id IS
  'ON DELETE SET NULL: a removed device must not destroy the audit trail '
  'of tokens that were issued to it (mirrors devices.profile handling in '
  '0001_init.sql for playback_sessions.device_id).';

COMMENT ON COLUMN refresh_tokens.rotated_from IS
  'id of the refresh_tokens row this one rotated out, forming a hash chain '
  'for reuse-detection (a presented token whose row is already rotated/'
  'revoked signals token theft). Deliberately NOT a FK: the predecessor row '
  'is retained indefinitely for audit and must never be affected by a '
  'later row being deleted or vice versa.';

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
