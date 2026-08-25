-- GENERATED FILE — do not hand-edit.
-- Produced by concatenating migrations/*.sql (filename order) with this
-- banner prepended. Source of truth is migrations/; regenerate with:
--   node scripts/migrate.mjs generate-schema
-- Verified in sync by: node scripts/migrate.mjs migrate-check

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0001_init
--
-- This migration IS the schema. `schema.sql` at the package root is a
-- generated concatenation of every file in migrations/*.sql, applied in
-- filename order, with a banner header prepended. For a single migration
-- (today) schema.sql's body is byte-identical to this file's body after the
-- banner; `scripts/migrate.mjs migrate-check` verifies that invariant by
-- (a) actually replaying every migration into a scratch schema and
-- confirming it applies cleanly, and (b) sha256-comparing schema.sql against
-- the concatenation of migrations/*.sql, so drift between the two is a hard
-- failure, not a hope. See scripts/migrate.mjs for the exact algorithm.
--
-- Conventions (see docs/PLAN.md §6.2, CLAUDE.md):
--   * UUIDv7 primary keys via loombre_uuidv7() (clean-room, RFC 9562 layout).
--   * All timestamps are BIGINT epoch milliseconds, columns suffixed `_ms`
--     (the sole exception is users.birth_date DATE, a calendar date).
--   * Postgres enums for closed enumerations.
--   * Every foreign key states ON DELETE explicitly; non-obvious choices are
--     commented at the point of declaration.
--   * JSONB is used ONLY for: media_files.probe, events.payload,
--     playback_sessions.plan, item_attributes.value, devices.profile,
--     user_settings.prefs. Nowhere else.
--   * CITEXT for case-insensitive text (usernames, person/tag names).

-- ============================================================================
-- Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================
-- loombre_uuidv7() — clean-room UUIDv7 generator (RFC 9562 §5.7 layout)
-- ============================================================================
--
-- Layout (16 bytes / 128 bits), built from scratch against the RFC's bit
-- diagram (not adapted from any existing implementation):
--
--   bytes  0-5  (48 bits) : unix_ts_ms, big-endian unsigned
--   byte   6  hi nibble   : version = 0b0111 (7)
--   byte   6  lo nibble   : top 4 bits of a 12-bit rand_a
--   byte   7  (8 bits)    : low 8 bits of rand_a
--   byte   8  top 2 bits  : variant = 0b10
--   byte   8  low 6 bits  : top 6 bits of a 62-bit rand_b
--   bytes  9-15 (56 bits) : remaining bits of rand_b
--
-- Randomness uses pg_catalog.random(); cryptographic strength is not required
-- for a primary-key generator (only uniqueness + rough time-ordering are),
-- so no extension dependency (e.g. pgcrypto) is introduced for this.
CREATE OR REPLACE FUNCTION loombre_uuidv7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  unix_ts_ms BIGINT;
  buf        BYTEA := '\x00000000000000000000000000000000'::bytea;
BEGIN
  unix_ts_ms := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;

  -- bytes 0-5: 48-bit big-endian unix_ts_ms
  buf := set_byte(buf, 0, ((unix_ts_ms >> 40) & 255)::int);
  buf := set_byte(buf, 1, ((unix_ts_ms >> 32) & 255)::int);
  buf := set_byte(buf, 2, ((unix_ts_ms >> 24) & 255)::int);
  buf := set_byte(buf, 3, ((unix_ts_ms >> 16) & 255)::int);
  buf := set_byte(buf, 4, ((unix_ts_ms >> 8)  & 255)::int);
  buf := set_byte(buf, 5, ( unix_ts_ms        & 255)::int);

  -- byte 6: version nibble (0111_) | top 4 bits of rand_a
  buf := set_byte(buf, 6, ((FLOOR(random() * 256)::int & 15) | 112));
  -- byte 7: low 8 bits of rand_a
  buf := set_byte(buf, 7, FLOOR(random() * 256)::int);
  -- byte 8: variant bits (10______) | top 6 bits of rand_b
  buf := set_byte(buf, 8, ((FLOOR(random() * 256)::int & 63) | 128));
  -- bytes 9-15: remaining 56 bits of rand_b
  buf := set_byte(buf, 9,  FLOOR(random() * 256)::int);
  buf := set_byte(buf, 10, FLOOR(random() * 256)::int);
  buf := set_byte(buf, 11, FLOOR(random() * 256)::int);
  buf := set_byte(buf, 12, FLOOR(random() * 256)::int);
  buf := set_byte(buf, 13, FLOOR(random() * 256)::int);
  buf := set_byte(buf, 14, FLOOR(random() * 256)::int);
  buf := set_byte(buf, 15, FLOOR(random() * 256)::int);

  RETURN encode(buf, 'hex')::uuid;
END;
$$;

COMMENT ON FUNCTION loombre_uuidv7() IS
  'Clean-room UUIDv7 generator per RFC 9562 layout (unix-ts-ms 48b + ver 7 + '
  'rand_a 12b + variant 10 + rand_b 62b). Used as the default for every '
  'primary key in this schema. Not copied from any third-party source.';

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE item_type AS ENUM
  ('movie', 'series', 'season', 'episode', 'artist', 'album', 'track');

CREATE TYPE content_class AS ENUM ('general', 'restricted');

-- Hyphenated to match the contract's ProgressState and @loombre/shared
-- WatchState verbatim — the enum value crosses the API boundary unmapped.
CREATE TYPE watch_state AS ENUM ('unplayed', 'in-progress', 'played');

CREATE TYPE job_status AS ENUM
  ('queued', 'active', 'completed', 'failed', 'cancelled');

CREATE TYPE person_role AS ENUM
  ('actor', 'director', 'writer', 'artist', 'album_artist', 'performer', 'guest');

CREATE TYPE image_kind AS ENUM ('poster', 'backdrop', 'logo', 'disc', 'thumb');

CREATE TYPE image_source AS ENUM ('provider', 'embedded', 'local');

-- Singular to match the contract's MediaKind and item_type verbatim — the
-- enum value crosses the API boundary unmapped.
CREATE TYPE media_kind AS ENUM ('movie', 'tv', 'music');

-- Not in the master enum list from the spec, but required by media_streams
-- ("stream_type (video|audio|subtitle enum)" per docs/PLAN.md §6.3).
CREATE TYPE stream_type AS ENUM ('video', 'audio', 'subtitle');

CREATE TYPE series_status AS ENUM ('continuing', 'ended', 'cancelled');

-- ============================================================================
-- users
-- ============================================================================

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  username            CITEXT NOT NULL UNIQUE,
  email               CITEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  birth_date          DATE NULL,
  max_content_rating  TEXT NULL,
  is_admin            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at_ms       BIGINT NOT NULL,
  updated_at_ms       BIGINT NOT NULL
);

COMMENT ON COLUMN users.max_content_rating IS
  'Admin-set ceiling on this user''s browsing (e.g. a kid profile capped at '
  'PG). NULL = no ceiling. Independent of the restricted-content gates.';

-- ============================================================================
-- user_settings (PK = FK, one row per user)
-- ============================================================================

CREATE TABLE user_settings (
  user_id                       UUID PRIMARY KEY
                                  REFERENCES users(id) ON DELETE CASCADE,
  restricted_opt_in             BOOLEAN NOT NULL DEFAULT FALSE,
  restricted_pin_hash           TEXT NULL,
  restricted_unlocked_until_ms  BIGINT NULL,
  prefs                         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at_ms                 BIGINT NOT NULL
);

COMMENT ON TABLE user_settings IS
  'Gate 3 (opt-in + PIN) and gate 5 (session unlock) state for restricted '
  'content live here; see docs/PLAN.md §6.4 for the full five-gate model.';

-- ============================================================================
-- devices
-- ============================================================================

CREATE TABLE devices (
  id                  UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  platform            TEXT NULL,
  refresh_token_hash  TEXT NULL,
  profile             JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_ms        BIGINT NULL,
  created_at_ms       BIGINT NOT NULL
);

COMMENT ON COLUMN devices.profile IS
  'Cached device capability profile (codecs, containers, HDR support), '
  'refreshed on login. NOT read by PlaybackPlan today — plan-request.ts '
  'parses the caller''s request-body DeviceProfile on every call instead '
  '(apps/server/src/playback/plan-request.ts). This column stays as a '
  'deliberate cache for future use (LD-4/C10, owner-adjudicated '
  '2026-08-10) rather than being dropped as dead persistence.';

CREATE INDEX devices_user_id_idx ON devices (user_id);

-- ============================================================================
-- libraries
-- ============================================================================

CREATE TABLE libraries (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  name           TEXT NOT NULL,
  media_kind     media_kind NOT NULL,
  paths          TEXT[] NOT NULL DEFAULT '{}',
  content_class  content_class NOT NULL DEFAULT 'general',
  created_at_ms  BIGINT NOT NULL,
  updated_at_ms  BIGINT NOT NULL
);

COMMENT ON COLUMN libraries.content_class IS
  'Coarse gate (§6.4): restricted is a property of the library. A restricted '
  'item can never live in a general library (enforced by the catalog_items '
  'trigger below, which denormalizes and pins this value onto every item).';

-- ============================================================================
-- library_permissions — default-deny, explicit grant required (incl. admins)
-- ============================================================================

CREATE TABLE library_permissions (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id    UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  granted_at_ms BIGINT NOT NULL,
  PRIMARY KEY (user_id, library_id)
);

COMMENT ON TABLE library_permissions IS
  'Per user x library visibility grant. Default-deny: a library — restricted '
  'or general — is invisible to a user until a row exists here. For '
  'restricted libraries this is gate 4 of 5 and applies even to admin '
  'accounts; there is no implicit access for anyone, including the owner of '
  'the instance.';

-- ============================================================================
-- catalog_items — thin polymorphic core
-- ============================================================================

CREATE TABLE catalog_items (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id        UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_type         item_type NOT NULL,
  parent_id         UUID NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  sort_title        TEXT NOT NULL,
  year              INTEGER NULL,
  community_rating  REAL NULL,
  content_class     content_class NOT NULL DEFAULT 'general',
  added_at_ms       BIGINT NOT NULL,
  updated_at_ms     BIGINT NOT NULL,
  search_tsv        tsvector GENERATED ALWAYS AS (
                       setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                       setweight(to_tsvector('simple', coalesce(sort_title, '')), 'B')
                     ) STORED
);

COMMENT ON COLUMN catalog_items.parent_id IS
  'Self-FK chaining episode->season->series and track->album->artist. '
  'ON DELETE CASCADE: deleting a season deletes its episodes, etc. — the '
  'catalog''s hierarchy is deliberately expressed as one recursive-free '
  'indexed table (docs/PLAN.md §5).';

COMMENT ON COLUMN catalog_items.content_class IS
  'Denormalized from the owning library so the restricted-content query '
  'guard filters on one indexed column with no join. Kept in lock-step with '
  'libraries.content_class by the trigger below — application code cannot '
  'set this column to anything else.';

CREATE INDEX catalog_items_library_type_idx
  ON catalog_items (library_id, item_type);

CREATE INDEX catalog_items_parent_id_idx
  ON catalog_items (parent_id);

CREATE INDEX catalog_items_content_class_added_idx
  ON catalog_items (content_class, added_at_ms DESC);

CREATE INDEX catalog_items_type_sort_title_idx
  ON catalog_items (item_type, sort_title);

CREATE INDEX catalog_items_search_tsv_idx
  ON catalog_items USING GIN (search_tsv);

-- Trigger: catalog_items.content_class always equals its owning library's
-- content_class, regardless of what a caller supplies on INSERT/UPDATE.
CREATE OR REPLACE FUNCTION catalog_items_enforce_content_class()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lib_class content_class;
BEGIN
  SELECT content_class INTO lib_class
  FROM libraries
  WHERE id = NEW.library_id;

  IF lib_class IS NULL THEN
    RAISE EXCEPTION 'catalog_items.library_id % does not reference an existing library', NEW.library_id;
  END IF;

  NEW.content_class := lib_class;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_items_enforce_content_class_trg
  BEFORE INSERT OR UPDATE OF library_id, content_class ON catalog_items
  FOR EACH ROW
  EXECUTE FUNCTION catalog_items_enforce_content_class();

COMMENT ON TRIGGER catalog_items_enforce_content_class_trg ON catalog_items IS
  'Structural guarantee behind §6.4 gate: a restricted item cannot exist in '
  'a general library or vice versa, independent of application code.';

-- Companion trigger: if a LIBRARY''s content_class is ever updated after items
-- exist, propagate to every child item — the query guard filters on the
-- denormalized catalog_items.content_class, so a stale copy would be a
-- security hole, not a cosmetic one.
CREATE OR REPLACE FUNCTION libraries_propagate_content_class()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE catalog_items
  SET content_class = NEW.content_class
  WHERE library_id = NEW.id
    AND content_class IS DISTINCT FROM NEW.content_class;
  RETURN NULL;
END;
$$;

CREATE TRIGGER libraries_propagate_content_class_trg
  AFTER UPDATE OF content_class ON libraries
  FOR EACH ROW
  EXECUTE FUNCTION libraries_propagate_content_class();

COMMENT ON TRIGGER libraries_propagate_content_class_trg ON libraries IS
  'Keeps the denormalized catalog_items.content_class in lock-step when a '
  'library is reclassified (the item-side trigger only fires on item writes).';

-- ============================================================================
-- Satellites (1:1, FK = PK) — one per item_type
-- ============================================================================

CREATE TABLE movie_details (
  item_id        UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  content_rating TEXT NULL,
  runtime_ms     BIGINT NULL,
  tagline        TEXT NULL,
  overview       TEXT NULL
);

CREATE TABLE series_details (
  item_id        UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  content_rating TEXT NULL,
  status         series_status NULL,
  overview       TEXT NULL
);

COMMENT ON COLUMN series_details.status IS
  'Continuing/ended/cancelled from the metadata provider; NULL until known '
  '(contract field is nullable to match).';

-- season_number / episode_number are NOT NULL: they come from filename
-- parsing at scan time and exist before any metadata provider runs, so the
-- contract can require them.
CREATE TABLE season_details (
  item_id       UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL
);

CREATE TABLE episode_details (
  item_id         UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  episode_number  INTEGER NOT NULL,
  aired_at_ms     BIGINT NULL,
  overview        TEXT NULL
);

COMMENT ON COLUMN episode_details.aired_at_ms IS
  'Original air date, epoch ms (spec alias: air_date_ms).';

CREATE TABLE artist_details (
  item_id  UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  overview TEXT NULL
);

CREATE TABLE album_details (
  item_id UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  year    INTEGER NULL
);

CREATE TABLE track_details (
  item_id      UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  track_number INTEGER NULL,
  disc_number  INTEGER NULL,
  duration_ms  BIGINT NULL
);

-- ============================================================================
-- provider_ids
-- ============================================================================

CREATE TABLE provider_ids (
  id          UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id     UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  UNIQUE (item_id, provider)
);

-- ============================================================================
-- people / item_people
-- ============================================================================

CREATE TABLE people (
  id            UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  name          CITEXT NOT NULL,
  content_class content_class NOT NULL DEFAULT 'general'
);

COMMENT ON COLUMN people.content_class IS
  'Metadata isolation (§6.4): a person credited only on restricted items '
  'carries content_class = restricted so they never surface in general '
  'people search/browse, independent of the query guard on catalog_items.';

CREATE INDEX people_name_idx ON people (name);
CREATE INDEX people_content_class_idx ON people (content_class);

CREATE TABLE item_people (
  id       UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id  UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      person_role NOT NULL,
  credit    TEXT NULL,
  ord       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX item_people_item_id_idx ON item_people (item_id);
CREATE INDEX item_people_person_id_idx ON item_people (person_id);

-- ============================================================================
-- tags / item_tags
-- ============================================================================

CREATE TABLE tags (
  id            UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  name          CITEXT NOT NULL,
  content_class content_class NOT NULL DEFAULT 'general',
  UNIQUE (name, content_class)
);

COMMENT ON TABLE tags IS
  'Same metadata-isolation rule as people: a tag/genre scoped to restricted '
  'content carries content_class = restricted and is uniqued per class, so '
  'a general "Horror" genre and a restricted "Horror" genre are distinct '
  'rows and never cross-surface.';

CREATE TABLE item_tags (
  id      UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL DEFAULT 'tag' CHECK (kind IN ('genre', 'tag')),
  UNIQUE (item_id, tag_id, kind)
);

CREATE INDEX item_tags_item_id_idx ON item_tags (item_id);
CREATE INDEX item_tags_tag_id_idx ON item_tags (tag_id);

-- ============================================================================
-- item_attributes — namespaced extension sandbox (core never reads this)
-- ============================================================================

CREATE TABLE item_attributes (
  id        UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id   UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     JSONB NOT NULL,
  UNIQUE (item_id, namespace, key)
);

COMMENT ON TABLE item_attributes IS
  'Namespaced extension/plugin sandbox (docs/PLAN.md §4.2). Core code never '
  'reads this table; only namespaced features do.';

-- ============================================================================
-- media_files / media_streams
-- ============================================================================

CREATE TABLE media_files (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id           UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  path              TEXT NOT NULL UNIQUE,
  content_hash      TEXT NULL,
  size_bytes        BIGINT NULL,
  container         TEXT NULL,
  duration_ms       BIGINT NULL,
  probe             JSONB NULL,
  probed_at_ms      BIGINT NULL,
  missing_since_ms  BIGINT NULL
);

COMMENT ON COLUMN media_files.content_hash IS
  'xxHash3 of a partial read (first+last 4 MiB + size). Together with path, '
  'this is the file identity used for rename/move detection (D16, §8.2).';

COMMENT ON COLUMN media_files.missing_since_ms IS
  'Set when the scanner cannot find the file at `path` on a pass. A 72h '
  'grace window (job-driven, not a DB-level cascade) allows a transient '
  'unmount to self-heal before the row (and its item, if orphaned) is '
  'reaped — see D16.';

CREATE INDEX media_files_content_hash_idx ON media_files (content_hash);
CREATE INDEX media_files_item_id_idx ON media_files (item_id);

CREATE TABLE media_streams (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  file_id        UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  stream_index   INTEGER NOT NULL,
  stream_type    stream_type NOT NULL,
  codec          TEXT NULL,
  profile        TEXT NULL,
  level          TEXT NULL,
  width          INTEGER NULL,
  height         INTEGER NULL,
  bit_depth      INTEGER NULL,
  color_transfer TEXT NULL,
  channels       INTEGER NULL,
  sample_rate    INTEGER NULL,
  bitrate_bps    BIGINT NULL,
  frame_rate     REAL NULL,
  language       TEXT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  is_forced      BOOLEAN NOT NULL DEFAULT FALSE
);

COMMENT ON COLUMN media_streams.color_transfer IS
  'Transfer characteristic string (e.g. smpte2084, arib-std-b67) used to '
  'detect HDR10 / HLG / Dolby Vision for the playback plan engine.';

CREATE INDEX media_streams_file_id_idx ON media_streams (file_id);

-- ============================================================================
-- progress
-- ============================================================================

CREATE TABLE progress (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  position_ms   BIGINT NOT NULL DEFAULT 0,
  state         watch_state NOT NULL DEFAULT 'unplayed',
  play_count    INTEGER NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

COMMENT ON TABLE progress IS
  'UPSERT-only writes make this concurrent-write-safe by construction '
  '(no read-modify-write race on the position counter).';

CREATE INDEX progress_continue_watching_idx
  ON progress (user_id, state, updated_at_ms DESC)
  INCLUDE (item_id, position_ms);

-- ============================================================================
-- playback_sessions
-- ============================================================================

CREATE TABLE playback_sessions (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  file_id        UUID NULL REFERENCES media_files(id) ON DELETE SET NULL,
  plan           JSONB NULL,
  engine_version TEXT NULL,
  started_at_ms  BIGINT NOT NULL,
  ended_at_ms    BIGINT NULL
);

COMMENT ON COLUMN playback_sessions.user_id IS
  'ON DELETE CASCADE: session rows are per-user audit data; deleting the '
  'user (account erasure) removes their playback history with them, '
  'consistent with the rest of the user-owned rows in this schema.';

COMMENT ON COLUMN playback_sessions.device_id IS
  'ON DELETE SET NULL: a revoked/removed device must not invalidate a '
  'historical session record used for audit; the session simply loses its '
  'device attribution.';

COMMENT ON COLUMN playback_sessions.file_id IS
  'ON DELETE SET NULL (deliberate choice over RESTRICT): media_files rows '
  'are pruned by the scanner (renames, deletes, the 72h missing-file grace '
  'window in D16). A playback_sessions row is an audit/analytics record, '
  'not a referential-integrity-critical row — it must survive the file '
  'disappearing rather than block the file''s deletion (RESTRICT) or be '
  'destroyed with it (CASCADE, which would silently erase audit history).';

CREATE INDEX playback_sessions_user_id_idx ON playback_sessions (user_id);
CREATE INDEX playback_sessions_device_id_idx ON playback_sessions (device_id);
CREATE INDEX playback_sessions_file_id_idx ON playback_sessions (file_id);

-- ============================================================================
-- events (outbox)
-- ============================================================================

CREATE TABLE events (
  id              UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  type            TEXT NOT NULL,
  ts_ms           BIGINT NOT NULL,
  actor_user_id   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at_ms BIGINT NULL
);

COMMENT ON COLUMN events.actor_user_id IS
  'ON DELETE SET NULL: the event stays in the outbox (historical/audit) '
  'even if the acting user account is later deleted; only the attribution '
  'is cleared.';

CREATE INDEX events_ts_ms_brin_idx ON events USING BRIN (ts_ms);
CREATE INDEX events_type_idx ON events (type);
CREATE INDEX events_unprocessed_idx ON events (processed_at_ms) WHERE processed_at_ms IS NULL;

-- ============================================================================
-- jobs — queue-agnostic ledger (no JSONB payload; see D-note below)
-- ============================================================================
-- Not in the JSONB whitelist (docs/PLAN.md §6.2 / CLAUDE.md #3): jobs uses
-- typed columns only, mirroring queue-driver state for the admin UI.

CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  type             TEXT NOT NULL,
  status           job_status NOT NULL DEFAULT 'queued',
  priority         INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NULL,
  subject_item_id  UUID NULL REFERENCES catalog_items(id) ON DELETE SET NULL,
  created_at_ms    BIGINT NOT NULL,
  updated_at_ms    BIGINT NOT NULL,
  started_at_ms    BIGINT NULL,
  finished_at_ms   BIGINT NULL
);

COMMENT ON COLUMN jobs.subject_item_id IS
  'ON DELETE SET NULL: the job ledger row (audit/history for the admin UI) '
  'outlives the catalog item it was about.';

CREATE INDEX jobs_status_priority_idx ON jobs (status, priority, created_at_ms);
CREATE INDEX jobs_subject_item_id_idx ON jobs (subject_item_id);

-- ============================================================================
-- images — managed image cache index
-- ============================================================================

CREATE TABLE images (
  id            UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  kind          image_kind NOT NULL,
  source        image_source NOT NULL,
  width         INTEGER NULL,
  height        INTEGER NULL,
  blurhash      TEXT NULL,
  file_path     TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE (entity_type, entity_id, kind, width)
);

COMMENT ON TABLE images IS
  'entity_type/entity_id is a deliberately polymorphic reference (catalog '
  'items today; people/tags potentially later) — no FK, enforced at the '
  'application layer. The image-serving endpoint must resolve entity_type '
  'to the owning row and check its content_class before serving, per the '
  'metadata-isolation rule in §6.4.';

CREATE INDEX images_entity_idx ON images (entity_type, entity_id, kind);

-- ============================================================================
-- schema_migrations — bookkeeping table for scripts/migrate.mjs
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename      TEXT PRIMARY KEY,
  checksum      TEXT NOT NULL,
  applied_at_ms BIGINT NOT NULL
);

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

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0003_media_files_version_label
--
-- Additive-only (mirrors 0002's discipline): no column drops, no type
-- narrowing, no rewriting of prior migrations.
--
-- Adds media_files.version_label (deliverable A, "Multi-version/editions"):
-- when the scanner parses two files in the SAME library that resolve to the
-- same catalog item (same title+year for a movie, same season+episode for
-- an episode, etc. — see apps/worker/src/scan/scanner.ts's find-or-create
-- logic), both media_files rows point at the SAME catalog_items row instead
-- of creating a duplicate item, and this column distinguishes them for
-- display: an edition string from the movie parser ("Director's Cut", "4K")
-- or a multi-part label ("part 1", "part 2") for cd1/cd2-style rips. NULL
-- for the common case of exactly one file per item.

ALTER TABLE media_files ADD COLUMN version_label TEXT NULL;

COMMENT ON COLUMN media_files.version_label IS
  'Distinguishes multiple media_files rows that share the same catalog item '
  '(multi-version/editions and multi-part files, docs/PLAN.md §8.1): an '
  'edition string ("Director''s Cut", "4K") or a part label ("part 1", '
  '"part 2"). NULL when the item has exactly one file.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- ============================================================================
-- Loombre migration 0004 — images unique key treats NULL width as a value
-- ============================================================================
-- The images unique key (entity_type, entity_id, kind, width) uses width NULL
-- for the stored original (variants carry real widths). Under SQL's default
-- NULLS DISTINCT semantics two "original" rows for the same entity/kind never
-- conflict, so upsertImage's ON CONFLICT silently inserts a duplicate original
-- on every re-run of an image job. NULLS NOT DISTINCT (Postgres 15+) makes the
-- original a real upsert target; ON CONFLICT (…) matches the rebuilt index.

ALTER TABLE images
  DROP CONSTRAINT images_entity_type_entity_id_kind_width_key;

ALTER TABLE images
  ADD CONSTRAINT images_entity_type_entity_id_kind_width_key
  UNIQUE NULLS NOT DISTINCT (entity_type, entity_id, kind, width);

-- SPDX-License-Identifier: AGPL-3.0-only
-- ============================================================================
-- Loombre migration 0005 — images.dominant_color (P2.11, slot per P2.15)
-- ============================================================================
-- Expand step (docs/PLAN.md §4.2: expand -> migrate -> contract). Adds the
-- column only; the one-time backfill of existing rows is a worker job
-- (apps/worker/src/image/backfill-consumer.ts), not part of this migration
-- — CLAUDE.md invariant 6 (long-running work goes through the job queue,
-- nothing does bulk work inline) applies to a library-wide image rescan
-- exactly as it does to any other CPU/IO-heavy sweep.
--
-- Format: '#rrggbb' lowercase hex, extracted worker-side from the decoded
-- original at image-ingest time (never on a request path, never
-- client-side) via sharp's histogram-derived dominant colour (see
-- apps/worker/src/image/variant-job.ts's computeDominantColor). NULL means
-- "not yet computed" (pre-migration rows awaiting backfill). The backfill
-- consumer additionally uses '' (empty string) as a distinct sentinel for
-- "computed, but the source file was missing/unreadable — permanently
-- skipped, never retried"; the read path (packages/db/src/query/
-- catalog-detail.ts) treats both NULL and '' as a null dominantColor.
-- Nothing enforces the '#rrggbb' shape at the DB layer (TEXT, matching
-- blurhash's own convention on this table) — the worker is the only writer
-- (CLAUDE.md invariant 4/8 style: this column is never client-writable).

ALTER TABLE images ADD COLUMN dominant_color TEXT NULL;

COMMENT ON COLUMN images.dominant_color IS
  'Hex ''#rrggbb'' dominant colour extracted worker-side at ingest '
  '(sharp stats().dominant), alongside blurhash. NULL = not yet computed '
  '(pre-migration row pending the one-time backfill job). Empty string '
  '('''') = computed-but-unavailable sentinel (source file missing/unreadable '
  'at backfill time) — distinct from NULL so the backfill never retries it. '
  'Both NULL and '''' read back as a null dominantColor at the query layer.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0006_playback_sessions
--
-- Additive-only (mirrors 0002/0003/0004's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md P2.14 audit mismatch: the contract's PlaybackSession schema
-- already exposes status/errorCode, and Progress already exposes
-- durationMs, but neither had a backing column. Migration slot per P2.15
-- (0005 is reserved for images.dominant_color on a concurrent lane; this
-- lane's slot is 0006 regardless of landing order).

CREATE TYPE playback_session_status AS ENUM ('created', 'active', 'ended', 'failed');

ALTER TABLE playback_sessions ADD COLUMN status playback_session_status NOT NULL DEFAULT 'created';
ALTER TABLE playback_sessions ADD COLUMN error_code TEXT NULL;
ALTER TABLE playback_sessions ADD COLUMN updated_at_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE playback_sessions ADD COLUMN last_heartbeat_ms BIGINT NULL;

-- Backfill for any pre-existing rows (none expected pre-Phase-2, but an
-- additive migration must never leave a NOT NULL column's real value
-- hidden behind a placeholder DEFAULT) then drop the temporary default so
-- every future insert must supply it explicitly, mirroring every other
-- `_ms` column in this schema (e.g. progress.updated_at_ms).
UPDATE playback_sessions SET updated_at_ms = started_at_ms WHERE updated_at_ms = 0;
ALTER TABLE playback_sessions ALTER COLUMN updated_at_ms DROP DEFAULT;

COMMENT ON COLUMN playback_sessions.status IS
  'Session lifecycle state (docs/PLAYBACK.md §9). Phase 2 (direct-play only) '
  'only ever sets created/active/ended/failed; the contract''s wider '
  'PlaybackSessionStatus enum (+starting/suspended/seeking) is reserved for '
  'the Phase 3 HLS session state machine and intentionally not a value this '
  'column''s type admits yet.';

COMMENT ON COLUMN playback_sessions.error_code IS
  'Set when status = ''failed'' (e.g. the heartbeat-timeout sweeper, '
  'docs/PLAYBACK.md §9). NULL otherwise.';

COMMENT ON COLUMN playback_sessions.updated_at_ms IS
  'Bumped on every state transition (heartbeat, end/fail) — separate from '
  'started_at_ms, which never changes after creation.';

COMMENT ON COLUMN playback_sessions.last_heartbeat_ms IS
  'Set by PUT /progress/{itemId} when the request body carries this '
  'session''s id (P2.14/P2.18 heartbeat). NULL until the first heartbeat; '
  'the sweeper falls back to started_at_ms when NULL (docs/PLAYBACK.md §9, '
  '15-minute no-heartbeat cutoff).';

CREATE INDEX playback_sessions_active_idx ON playback_sessions (status)
  WHERE status IN ('created', 'active');

ALTER TABLE progress ADD COLUMN duration_ms BIGINT NULL;

COMMENT ON COLUMN progress.duration_ms IS
  'Snapshot of the played file''s duration at the time of the last '
  'progress write (contract Progress.durationMs) — client-supplied via '
  'ProgressUpdate, not independently probed by this table.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0007_playback_progress_marker
--
-- Additive-only (mirrors 0002/0003/0004/0006's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- STATE.md P2.8/deliverable-E (websocket-presence lane): the heartbeat path
-- (PUT /progress/{itemId} with a sessionId, docs/PLAYBACK.md §9) must emit
-- `playback.progress` AT MOST ONCE PER 30s PER SESSION (plan §6.3 — "never
-- row-per-tick"), but heartbeats themselves can arrive far more often than
-- that. `last_heartbeat_ms` is unsuitable as the throttle marker because it
-- is overwritten on EVERY heartbeat call regardless of whether an event was
-- emitted — comparing consecutive heartbeats' deltas would never
-- accumulate to the 30s threshold if the client heartbeats more frequently
-- than that. A dedicated marker, updated ONLY when a `playback.progress`
-- event is actually written, is required.

ALTER TABLE playback_sessions ADD COLUMN last_progress_event_at_ms BIGINT NULL;

COMMENT ON COLUMN playback_sessions.last_progress_event_at_ms IS
  'Set to the heartbeat''s nowMs whenever heartbeatPlaybackSession actually '
  'emits a playback.progress outbox event (packages/db/src/query/'
  'playback-sessions.ts) — NOT bumped on every heartbeat, only on ones that '
  'clear the >=30s-since-last-emission throttle. NULL until the first '
  'progress event for this session.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0008_search_trgm_indexes
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- Gap-closure lane / perf exit-gate finding: searchCatalog
-- (packages/db/src/query/search.ts) breached the enforced p95 <=100ms
-- budget at the 50k-item seed (measured 147-159ms) — the person/tag
-- ILIKE '%q%' substring matches (item_people->people.name,
-- item_tags->tags.name) had no supporting index, so Postgres fell back to
-- a per-outer-row correlated-subquery scan (search.ts's own header already
-- flagged this as a documented Phase-1-scale tradeoff).
--
-- pg_trgm's GIN trigram index accelerates arbitrary substring ILIKE
-- matches (unlike a plain btree, which only helps prefix matches). Both
-- people.name and tags.name are CITEXT, not TEXT — CITEXT defines its OWN
-- `~~*`/`~~` (ILIKE/LIKE) operators distinct from the plain-text ones the
-- pg_trgm opclass registers strategies for, so an index built directly on
-- the citext column (`GIN (name gin_trgm_ops)`) is silently never chosen
-- by the planner for a `name ILIKE ...` query (verified empirically
-- against a 50k-row table: CREATE INDEX succeeds via citext's implicit
-- assignment cast to text, but EXPLAIN keeps choosing Seq Scan regardless
-- of table size). The fix is an EXPRESSION index on the explicit `::text`
-- cast, paired with search.ts casting the same way in its WHERE clause
-- (`people.name::text ILIKE ...` / `tags.name::text ILIKE ...`) so the
-- query's operator is the plain-text `~~*` the opclass actually supports.
-- Verified: Bitmap Index Scan, ~0.9ms vs ~14ms Seq Scan at 50k rows.
--
-- Phase-4 packaging note: `CREATE EXTENSION pg_trgm` requires the
-- extension to be present in the target Postgres install (bundled with
-- every mainstream distribution's contrib/postgresql-contrib package,
-- same tier as citext which 0001_init.sql already requires) — the
-- embedded-Postgres bundling decision (D1) must include contrib
-- extensions, not just core, when Phase 4 packages a zero-config install.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX people_name_trgm_idx ON people USING GIN ((name::text) gin_trgm_ops);
CREATE INDEX tags_name_trgm_idx ON tags USING GIN ((name::text) gin_trgm_ops);

COMMENT ON INDEX people_name_trgm_idx IS
  'Backs searchCatalog''s person-name ILIKE substring match '
  '(packages/db/src/query/search.ts) — expression index on name::text, '
  'see migration header for why a plain (name) index on this CITEXT '
  'column would never be chosen by the planner.';

COMMENT ON INDEX tags_name_trgm_idx IS
  'Backs searchCatalog''s tag-name ILIKE substring match '
  '(packages/db/src/query/search.ts) — same CITEXT/expression-index '
  'reasoning as people_name_trgm_idx.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0009_browse_keyset_indexes.sql
--
-- Covering indexes for listCatalogItems' keyset pagination (plan §6.2:
-- "every list-endpoint access path has a covering index reviewed at PR
-- time" — the sort/order params landed in the gap-closure pass without
-- these, caught by the ENFORCING perf-t0 CI job's first run: browse p95
-- 209.8ms > 100ms budget @ 50k items on the ubuntu runner).
--
-- EXPLAIN before this migration: the planner picks
-- catalog_items_library_type_idx (library_id, item_type), then FILTERS
-- AND SORTS the library's entire row set ("Rows Removed by Filter:
-- 50000") on EVERY page request. With these composite indexes the scan
-- streams already-ordered rows and stops at LIMIT.
--
-- Only the two NOT-NULL sorts are covered here ('added' — the default
-- browse path the perf budget measures — and 'title'). The nullable
-- 'rating'/'year' sorts use order-dependent COALESCE-sentinel
-- expressions (see catalog-detail.ts sortKeyExpr) that would need four
-- expression indexes or a query redesign — logged as Open in STATE.md,
-- not silently skipped.
--
-- PARTIALLY REVERSED (LD-12, migrations/0042_restricted_browse_rating_
-- sort_indexes.sql): this decision's "rating" half is landed for the
-- restricted zone's sort=rating (packages/db/src/query/
-- restricted-browse.ts) — narrower than what this migration declined
-- (restricted-zone-only, rating-only, 2 direction-specific expression
-- indexes rather than the 4 a rating+year general-catalog fix would need)
-- and measured (238.7ms -> 7.4ms, 33k fixture) before landing. The "one
-- index does not cover both directions" reasoning above is still
-- correct — 0042 answers it with two indexes, one per direction, rather
-- than redesigning it away. 'year' (general catalog) and the restricted
-- zone's own sort=date/sort=duration remain open exactly as this
-- migration and STATE.md's S10 residue note describe; see 0042's header
-- for why those specifically stay unindexed.

CREATE INDEX catalog_items_library_type_added_keyset_idx
  ON catalog_items (library_id, item_type, added_at_ms DESC, id DESC);

COMMENT ON INDEX catalog_items_library_type_added_keyset_idx IS
  'Keyset browse, default sort=added: listCatalogItems orders by '
  '(added_at_ms, id) within a library_id + item_type prefix '
  '(packages/db/src/query/catalog-detail.ts). DESC matches the default '
  'order so the scan streams without a sort node.';

CREATE INDEX catalog_items_library_type_title_keyset_idx
  ON catalog_items (library_id, item_type, sort_title, id);

COMMENT ON INDEX catalog_items_library_type_title_keyset_idx IS
  'Keyset browse, sort=title: same shape for the (sort_title, id) '
  'keyset. ASC index serves both directions (backward scan for desc).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0010_media_files_mtime_ms
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- STATE.md P3.10: the scanner's incremental fast path (apps/worker/src/
-- scan/scanner.ts's processOneFile) short-circuited an existing path match
-- as "unchanged" whenever path+size matched, because media_files had no
-- mtime column to compare (see the now-superseded comment this migration's
-- companion worker change replaces). A same-byte-size in-place edit (e.g.
-- an in-place mux/remux that preserves the exact file length) was therefore
-- never re-hashed or re-probed — a false-negative "unchanged" that would
-- persist until the file's size happened to change. `mtime_ms` closes that
-- gap: the scanner now also compares the filesystem's mtime, so a same-size
-- edit (which always bumps mtime) falls through to the hash path instead of
-- being silently skipped.
--
-- ALSO NULL for a second, unrelated reason: it doubles as a legacy marker.
-- Every media_files row that existed before this column landed has
-- mtime_ms = NULL (no ALTER TABLE backfill — there is no historical mtime
-- to backfill from), and the scanner treats a NULL as "not yet observed
-- since this column landed" rather than "unchanged", forcing exactly one
-- re-hash per legacy row to establish a baseline going forward.

ALTER TABLE media_files ADD COLUMN mtime_ms BIGINT NULL;

COMMENT ON COLUMN media_files.mtime_ms IS
  'Filesystem mtime (stat().mtimeMs), truncated to an integer millisecond '
  'count, as observed at the file''s last successful hash or probe '
  '(apps/worker/src/scan/scanner.ts). Compared alongside size_bytes in the '
  'incremental fast path: a path+size match with a matching mtime_ms is '
  'unchanged; a path+size match with a differing or NULL mtime_ms falls '
  'through to re-hash. NULL means either a legacy row that predates this '
  'column (not yet observed since it landed — the scanner re-hashes once '
  'to establish a baseline) or a row whose file has never been '
  'hashed/probed.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0011_hw_capability_snapshots
--
-- Additive-only (mirrors 0002/.../0010's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- docs/PLAYBACK.md §8.1/§2.5, Phase 3 §11 step 5: persistence for the
-- hardware capability self-test probe's `VerifiedCapabilities` snapshot
-- (apps/worker/src/hwcaps/**). Two tables:
--
--   hw_capability_snapshots — one row per (platform, probe run). Carries the
--   invalidation keys (ffmpeg_build_hash, gpu_fingerprint) and `is_current`,
--   the flag the engine/worker actually reads by. `platform` is the Node.js
--   `os.platform()` string ('darwin'|'linux'|'win32') — CHECK-constrained
--   below rather than a bare unchecked TEXT, matching the values
--   apps/worker/src/hwcaps/platforms.ts's candidatesForPlatform() switches
--   on. `gpu_fingerprint` defaults to '' (best-effort — see that module's
--   fingerprint.ts header): invalidation then keys on ffmpeg_build_hash
--   alone when a GPU fingerprint command loops back with a failure.
--
--   hw_capability_backends — one row per backend entry in that snapshot's
--   §2.5 `backends` array, with an explicit `position` column preserving
--   array order (the engine's Stage G consumes platform-candidate order,
--   docs/PLAYBACK.md §8.2/§8.3 — this is NOT an incidental ordering, it is
--   load-bearing and must round-trip through storage exactly).
--
-- Column typing note (interpretation, reported per this step's
-- instructions): the orchestrator's binding spec names `backend`/`decode`/
-- `encode`/`tone_map` as TEXT/TEXT[] rather than native PG enum types. This
-- migration keeps those literal types (a TEXT[] of a custom enum type is
-- markedly more awkward to work with from Kysely/node-pg than a checked
-- TEXT[]) but adds CHECK constraints enumerating the exact closed value
-- sets docs/PLAYBACK.md §2.5 defines, so CLAUDE.md invariant 3's "real
-- columns/FKs/enums" spirit is honored via CHECK rather than CREATE TYPE
-- for these four columns specifically — every other enum-shaped column in
-- this schema (item_type, content_class, ...) still uses a native enum,
-- unaffected by this migration.
--
-- Exactly one `is_current = true` row per platform is enforced two ways:
-- the app-level writer (packages/db/src/internal/hwcaps.ts) flips the prior
-- current row false and inserts the new one in the SAME transaction, and a
-- partial unique index below makes the invariant a DB-level guarantee too
-- (defense in depth, not just a hopeful transaction).

CREATE TABLE hw_capability_snapshots (
  id                 UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  ffmpeg_build_hash  TEXT NOT NULL,
  gpu_fingerprint    TEXT NOT NULL DEFAULT '',
  platform           TEXT NOT NULL
    CHECK (platform IN ('darwin', 'linux', 'win32')),
  verified_at_ms     BIGINT NOT NULL,
  is_current         BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE hw_capability_snapshots IS
  'One row per hardware-capability self-test run (docs/PLAYBACK.md §8.1). '
  'ffmpeg_build_hash + gpu_fingerprint are the invalidation keys (STATE.md '
  'P3.5): a worker boot whose CURRENT resolved ffmpeg/GPU fingerprint '
  'differs from the is_current row for its platform enqueues a fresh '
  '''hwprobe'' job. gpu_fingerprint may be '''' (best-effort per-platform '
  'command failed) — invalidation then keys on ffmpeg_build_hash alone.';

-- Defense in depth: at most one current snapshot per platform, enforced by
-- Postgres itself and not merely by the writer's transaction discipline.
CREATE UNIQUE INDEX hw_capability_snapshots_one_current_per_platform
  ON hw_capability_snapshots (platform)
  WHERE is_current;

CREATE INDEX hw_capability_snapshots_platform_current_idx
  ON hw_capability_snapshots (platform, is_current);

CREATE TABLE hw_capability_backends (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  snapshot_id    UUID NOT NULL REFERENCES hw_capability_snapshots (id) ON DELETE CASCADE,
  position       INT NOT NULL,
  backend        TEXT NOT NULL
    CHECK (backend IN ('videotoolbox', 'qsv', 'vaapi', 'nvenc', 'amf', 'd3d11va', 'software')),
  decode         TEXT[] NOT NULL
    CHECK (decode <@ ARRAY['h264', 'hevc', 'av1', 'vp9', 'mpeg2', 'vc1', 'mpeg4', 'unknown']::text[]),
  encode         TEXT[] NOT NULL
    CHECK (encode <@ ARRAY['h264', 'hevc', 'av1']::text[]),
  tone_map       TEXT[] NOT NULL
    CHECK (tone_map <@ ARRAY['opencl', 'vulkan', 'videotoolbox', 'cuda', 'none']::text[]),
  verified_at_ms BIGINT NOT NULL,
  UNIQUE (snapshot_id, position)
);

COMMENT ON TABLE hw_capability_backends IS
  'One row per backend entry in a hw_capability_snapshots row''s §2.5 '
  '`VerifiedCapabilities.backends` array. `position` is the array index '
  '(platform-candidate order, docs/PLAYBACK.md §8.2/§8.3) — load-bearing, '
  'not incidental: the engine''s Stage G tries backends in exactly this '
  'order and depends on the platform''s software fallback sorting last.';

CREATE INDEX hw_capability_backends_snapshot_id_idx
  ON hw_capability_backends (snapshot_id);

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0012_transcode_sessions
--
-- Additive-only (mirrors 0002/.../0011's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- docs/PLAYBACK.md §9, Phase 3 §11 step 6a (worker-side transcode session
-- runtime). This migration is the shared substrate for BOTH lanes of step
-- 6: lane A (this one — apps/worker/src/transcode/**, the pipeline
-- supervisor) and lane B (apps/server, HTTP endpoints + admission, landing
-- after this one) drive the same rows.
--
-- ---------------------------------------------------------------------------
-- EXISTING-COLUMN AUDIT (performed before writing this file, reported per
-- this step's instructions):
--   - id/user_id/device_id/file_id/plan/engine_version/started_at_ms/
--     ended_at_ms: migrations/0001_init.sql. `plan` JSONB already exists —
--     P2.4's "verify the column exists" is CONFIRMED, no action needed. The
--     stored plan is Phase 2's `{decision:'direct-play', ...}` shape today;
--     lane B's session-create path is what will start storing a REAL
--     PlaybackPlan there. See this migration's trailing comment block for a
--     documented ADDITIONAL requirement this lane places on that JSONB
--     payload (a `selection` sidecar key) — no schema change needed for
--     that, JSONB already whitelisted for serialized plans (CLAUDE.md
--     invariant 3), just a payload-shape contract lane B must honor.
--   - status/error_code/updated_at_ms/last_heartbeat_ms:
--     migrations/0006_playback_sessions.sql. The `playback_session_status`
--     enum there is Phase-2-narrow (created/active/ended/failed) BY
--     COMMENT, explicitly reserving the contract's wider
--     {starting,suspended,seeking} for this phase — this migration adds
--     exactly those three, in the SAME order the contract's
--     PlaybackSessionStatus enum lists them (packages/contract/openapi.yaml:
--     created, starting, active, suspended, seeking, ended, failed).
--   - last_progress_event_at_ms: migrations/0007 — unrelated throttle
--     marker for the heartbeat->event path, untouched here.
--   - Audit CONCLUSION (the delta this migration adds): nothing above
--     covers (a) where the session's ffmpeg pipeline runs on disk, (b) the
--     server<->worker control channel's THREE signal columns (requested
--     segment, seek target, and the worker's own produced-segment
--     observability counter), (c) discontinuity bookkeeping for the served
--     playlist, (d) which of the two possible causes put a session into
--     'suspended' (server heartbeat-staleness vs worker throttle), (e)
--     failure diagnostics (stderr tail). All seven are net-new columns
--     below. Every one is NULLable (or DEFAULTed to an inert value) with NO
--     backfill needed — direct-play sessions (Phase 2's whole session
--     population) never touch any of them, so there is no pre-existing row
--     whose "real value" would otherwise hide behind a placeholder.
--
-- ---------------------------------------------------------------------------
-- OWNERSHIP (the worker<->server seam this migration encodes — see also the
-- verbatim module-header contract in apps/worker/src/transcode/index.ts (module header)
-- for the full write-path narrative; this comment is the SQL-level summary):
--
--   staging_dir            worker-written (set once, at session start)
--   requested_segment      server-written (Lane B; throttle input)
--   produced_segment       worker-written (throttle input + first-segment
--                          observability for Lane B's blocking playlist GET)
--   seek_target_ms         server-written (Lane B, on an outside-produced-
--                          range seek); worker NULLS it in the SAME
--                          transaction that bumps discontinuity_count and
--                          begins the restart — "consumed" atomically, never
--                          left dangling for a second restart to re-trigger
--   discontinuity_count    worker-written (incremented exactly once per
--                          seek-restart, in the seek-consuming transaction)
--   suspended_by_throttle  worker-written (true exactly while `status =
--                          'suspended'` for THIS session's OWN segment-ahead
--                          throttle decision; false — including while
--                          `status = 'suspended'` for a heartbeat-staleness
--                          cause the (future) extended sweeper writes — see
--                          the disambiguation note below)
--   stderr_tail            worker-written (only on a worker-detected ffmpeg
--                          failure; last 4 KB ring, docs/PLAYBACK.md §9)
--
--   `status = 'suspended'` has TWO possible causes sharing one enum value
--   (the contract's PlaybackSessionStatus has no room for a second axis):
--   this session's own segment-ahead throttle (worker-authored,
--   suspended_by_throttle = true) OR a stale-heartbeat suspend the extended
--   sweeper will write (server-authored, suspended_by_throttle = false).
--   `suspended_by_throttle` is precisely that disambiguator, and it is what
--   lets the worker's poll loop reconcile the two independent causes
--   correctly on resume (see apps/worker/src/transcode/throttle.ts's header
--   for the exact reconciliation table) without a second status-like
--   column.

ALTER TYPE playback_session_status ADD VALUE 'starting' AFTER 'created';
ALTER TYPE playback_session_status ADD VALUE 'suspended' AFTER 'active';
ALTER TYPE playback_session_status ADD VALUE 'seeking' AFTER 'suspended';

ALTER TABLE playback_sessions ADD COLUMN staging_dir TEXT NULL;
ALTER TABLE playback_sessions ADD COLUMN requested_segment INT NULL;
ALTER TABLE playback_sessions ADD COLUMN produced_segment INT NULL;
ALTER TABLE playback_sessions ADD COLUMN seek_target_ms BIGINT NULL;
ALTER TABLE playback_sessions ADD COLUMN discontinuity_count INT NOT NULL DEFAULT 0;
ALTER TABLE playback_sessions ADD COLUMN suspended_by_throttle BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE playback_sessions ADD COLUMN stderr_tail TEXT NULL;

COMMENT ON COLUMN playback_sessions.staging_dir IS
  'Absolute path of this session''s private working directory under the '
  'LOOMBRE_TRANSCODE_DIR staging root (apps/worker/src/transcode/staging.ts), '
  'e.g. "<root>/<sessionId>". NULL until the worker''s "starting" transition '
  'creates it; NULL forever for direct-play sessions. Deleted (guarded: '
  'refuses to remove anything outside the staging root) on end/fail.';

COMMENT ON COLUMN playback_sessions.requested_segment IS
  'Server-written (Lane B): the highest HLS segment index the client has '
  'actually requested so far (0-based, matching the {START_SEG} numbering '
  'space). Worker throttle input (docs/PLAYBACK.md §9) — NULL is treated '
  'as 0 (no request yet) by the worker''s throttle math, never as '
  '"unbounded ahead is fine".';

COMMENT ON COLUMN playback_sessions.produced_segment IS
  'Worker-written: the highest HLS segment index this session''s CURRENT '
  'ffmpeg run has finished writing (0-based, matching {START_SEG} — the '
  'index is already globally continuous across seek-restarts because '
  '{START_SEG} continues the numbering, so no run-relative offset is '
  'needed). NULL means no segment has been produced yet since the last '
  '(re)start — Lane B''s first-playlist-request block polls for this '
  'flipping non-NULL as the "init + first segment produced" observable '
  '(docs/PLAYBACK.md §9), rather than touching the filesystem itself.';

COMMENT ON COLUMN playback_sessions.seek_target_ms IS
  'Server-written (Lane B): set when a client requests a playhead position '
  'outside this session''s currently-produced segment range. The worker '
  'consumes it (reads + sets back to NULL) in the SAME transaction that '
  'starts the seek-restart (discontinuity_count += 1) — so a seek target '
  'is atomically "claimed" exactly once, never double-restarted by two '
  'poll ticks racing. Precision: milliseconds in, {SEEK_SECONDS} out is '
  'this value / 1000 (seconds, up to millisecond precision passed straight '
  'through to ffmpeg''s -ss, e.g. 12345 -> "12.345").';

COMMENT ON COLUMN playback_sessions.discontinuity_count IS
  'Worker-written: number of seek-restarts this session has undergone. '
  'Bumped exactly once per restart in the seek_target_ms-consuming '
  'transaction. Lane B''s served-playlist reader can use this purely as a '
  'diagnostic counter; the actual #EXT-X-DISCONTINUITY tags live in the '
  'worker-maintained media.m3u8 wrapper file on disk (docs/PLAYBACK.md §9 — '
  'see apps/worker/src/transcode/playlist.ts), not reconstructed from this '
  'number.';

COMMENT ON COLUMN playback_sessions.suspended_by_throttle IS
  'Worker-written: true exactly while `status = ''suspended''` is THIS '
  'session''s own segment-ahead throttle decision (docs/PLAYBACK.md §9 — '
  'ahead > 10 segments suspends, ahead <= 5 resumes); false at every other '
  'time, INCLUDING while `status = ''suspended''` for a heartbeat-staleness '
  'cause a future extended sweeper may write. Disambiguates the two causes '
  'that share the one `suspended` status value — see this migration''s '
  'header comment.';

COMMENT ON COLUMN playback_sessions.stderr_tail IS
  'Worker-written: the last 4 KB (ring buffer) of this session''s ffmpeg '
  'stderr, captured only when the pipeline exits non-zero for a reason the '
  'worker did not itself cause (docs/PLAYBACK.md §9 audit requirement). '
  'NULL for every session that never failed, and for direct-play sessions.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0013_server_settings
--
-- Additive-only (mirrors 0002/.../0012's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md Addendum A (post-Phase-4), decision A4: persistence for the
-- admin-configurable settings registry (packages/shared/src/
-- settings-registry.ts). One row per REGISTRY KEY, never one row per
-- setting "category" or a single blob row — this is what lets a single
-- key be read/written/audited independently and lets an unrecognized
-- leftover row be detected without parsing anything.
--
-- `value JSONB NOT NULL` — every setting's value, whatever shape its own
-- zod schema declares (boolean/number/string/array/object). Addendum
-- decision AD5: this column joins the JSONB whitelist CLAUDE.md invariant 3
-- names (ffprobe output, event payloads, serialized plans, item_attributes
-- values, device capability profiles, user settings prefs) as its 7th
-- entry — CLAUDE.md is updated in this same lane's commit.
--
-- `updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL` — NULL
-- (not a FK violation) if the acting admin's account is later deleted,
-- matching `events.actor_user_id`'s exact same ON DELETE SET NULL
-- convention (migrations/0001_init.sql) — an audit trail must survive the
-- actor's own account being removed.
--
-- Deliberately NO `content_class`/restricted-content columns and NO
-- ViewerContext-guarded read path (packages/db/src/query/settings.ts's own
-- header): server settings are instance facts, not viewer-scoped catalog
-- data, the same P1.14 precedent identity.ts's users/user_settings/
-- devices tables already establish. Authorization (admin-only) is enforced
-- at the apps/server API layer, re-verified live against `users.is_admin`
-- on every mutation (A10) rather than trusted from a cached role.
--
-- Only registry keys are ever meant to be written here (enforced by the
-- SERVICE layer, apps/server/src/settings/ — this table has no CHECK
-- constraint enumerating valid keys, deliberately: the registry is a
-- TypeScript source of truth that evolves without a migration every time a
-- setting is added, and a stray row for a since-removed/renamed key must
-- be READABLE so it can be reported, never silently un-selectable).

CREATE TABLE server_settings (
  key            TEXT PRIMARY KEY,
  value          JSONB NOT NULL,
  updated_at_ms  BIGINT NOT NULL,
  updated_by     UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE server_settings IS
  'Addendum A (STATE.md, admin-configurable server settings): one row per '
  'packages/shared/src/settings-registry.ts key with a DB-persisted value. '
  'Absence of a row for a known key is normal and means "use the registry '
  'default" (or the env-pinned value, which always outranks this table '
  'regardless of what is stored here) — see settings-resolve.ts''s '
  'resolveEffectiveSettings for the full env > database > default '
  'precedence. A row for a key NOT in the current registry (renamed, '
  'removed, or a typo from manual SQL) is preserved as-is, never dropped, '
  'and reported at boot (A4) rather than silently ignored.';

COMMENT ON COLUMN server_settings.value IS
  'JSONB — shape is whatever the matching registry entry''s zod schema '
  'declares (boolean/number/string/array/object). CLAUDE.md invariant 3 '
  'JSONB whitelist entry 7 (AD5).';

COMMENT ON COLUMN server_settings.updated_by IS
  'The admin user who last wrote this row, re-verified live (A10) at '
  'mutation time — NULL if that account has since been deleted.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0014_plugins
--
-- Additive-only (mirrors 0002/.../0013's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Loombre Plugin Protocol (LPP) v1, Lane W2 (packages/plugin-protocol/spec/
-- lpp-v1.md is the FROZEN wire contract this table's rows back). Real
-- columns/FKs/enums for everything with independent read/write/audit needs
-- (CLAUDE.md invariant 3); JSONB reserved for exactly two fields that are
-- genuinely opaque blobs: the plugin's manifest snapshot (a third-party
-- document Loombre only ever stores/forwards, never queries a field out of)
-- and its non-secret config values (shape is whatever THAT plugin's own
-- configSchema declares, unknowable at migration-authoring time — the same
-- reasoning migrations/0013_server_settings.sql's `value` column already
-- established for server_settings). CLAUDE.md invariant 3's JSONB whitelist
-- grows from 7 to 9 entries (plugins.manifest, plugins.config) in this
-- lane's commit alongside this migration, per the mission's LD3.
--
-- Ownership split (LD1/LD2/LD3): the delivery-signing HMAC secret and every
-- `configSchema` field marked `secret: true` live ONLY in the keyring
-- (packages/secrets), under `plugin-hmac-<pluginId>` and
-- `plugin-<pluginId>-<fieldName>` respectively — NEVER a column here, NEVER
-- in `config` JSONB, NEVER in an event payload. This table's `config` JSONB
-- holds only the NON-secret configSchema field values.
--
-- `granted_capability_types TEXT[]` — LD6's "caller supplies the GRANTED
-- subset (... capability set <= declared)": the admin may register a plugin
-- with fewer capability TYPES enabled than its manifest declares (e.g. a
-- plugin offering both metadata-provider and event-subscriber, approved for
-- metadata-provider only). A real, independently-queryable column rather
-- than a JSONB blob, per CLAUDE.md invariant 3 — it drives the C5 scoping
-- seam (apps/server/src/plugins/scope.ts) and W3/W4's own capability-gating
-- checks and must be a first-class filterable value, not something buried in
-- `manifest` (which the mission itself is careful to keep OUT of every
-- event payload — see plugin_event_grants below and event-schemas/plugin.*
-- for why a real column matters there too).
--
-- `content_class` (reusing the EXISTING `content_class` enum type, per this
-- lane's mission text) is the plugin's own AGGREGATE scope: 'restricted' iff
-- any GRANTED capability's manifest-declared `contentClass` is 'restricted',
-- else 'general' — computed by the registration/re-approval service (never
-- by a trigger here; unlike catalog_items/libraries, a plugin has no owning
-- parent row to derive this from). Drives
-- apps/server/src/plugins/scope.ts's assertPluginAttachAllowed /
-- pluginMayReceiveRestricted, mirroring apps/worker/src/metadata/
-- registry.ts's assertScope semantics for metadata providers verbatim (a
-- restricted-scoped plugin never attaches to/receives general-only data;
-- the reverse is fine).
--
-- Health/breaker columns (LD7/LD8): ONE aggregate `health_state` per plugin
-- (not per-capability — see apps/server/src/plugins/plugin-health.service.ts
-- header for how the envelope check and this lane's OWN per-capability
-- static checks fold into this single column; W4's operational
-- event-delivery health is a separate, later concern layered on the same
-- substrate). `consecutive_failures` is the DURABLE breaker counter driving
-- LD8's "5 consecutive failures -> auto-disable" — distinct from
-- packages/plugin-host's in-memory circuit-breaker state machine, which is a
-- per-process fast-path gate over the SAME failure signal, not a second
-- source of truth (see packages/plugin-host/src/breaker.ts's header).
--
-- `disabled_reason` is TEXT + CHECK, not a Postgres enum: it is a small,
-- LPP-specific closed set ('admin' | 'breaker' | 'scope-change', LD4) with
-- no other table ever needing it — mirrors migrations/0011's
-- hw_capability_backends.backend/decode/encode/tone_map precedent
-- ("CHECK-constrained, not native enums") for the same "closed set local to
-- one table" reasoning, rather than growing the shared enum-type namespace
-- for a set this narrow.
--
-- `lan_allowlist TEXT[]` — LD5's SSRF-guard escape hatch: exact hostnames
-- (or IP literals) this plugin's own base_url/delivery/config-declared
-- targets are permitted to resolve to even when they land in a
-- private/loopback/link-local range. Explicit hosts only (no CIDR/wildcard
-- parsing here or in packages/plugin-host — an admin opts a plugin INTO a
-- specific LAN address, never a whole subnet blindly).
--
-- `base_url` is UNIQUE: registering the same plugin endpoint twice would
-- otherwise silently produce two independent rows racing each other's
-- health/breaker state for what is, from the plugin's own perspective, one
-- HTTP service — the registration service's job is re-approval /
-- re-registration against the EXISTING row, never a duplicate insert.
--
-- `approved_at_ms` is NOT NULL, grouped with created_at_ms/updated_at_ms
-- (all three BIGINT epoch ms, per this lane's mission text): LD6's
-- registration flow ends with "row committed enabled with granted scope" in
-- one step — there is no separate "pending approval" row state in LPP v1 —
-- so approval always happens at insert time (initial registration) or at an
-- explicit re-approval call after a scope-change auto-disable; it is never
-- absent for a row that exists at all.

CREATE TYPE plugin_health_state AS ENUM ('unknown', 'healthy', 'unhealthy');

CREATE TABLE plugins (
  id                        UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  name                      TEXT NOT NULL,
  base_url                  TEXT NOT NULL,
  version                   TEXT NOT NULL,
  protocol_version          INT NOT NULL,
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  content_class             content_class NOT NULL DEFAULT 'general',
  granted_capability_types  TEXT[] NOT NULL DEFAULT '{}',
  health_state              plugin_health_state NOT NULL DEFAULT 'unknown',
  consecutive_failures      INT NOT NULL DEFAULT 0,
  last_health_check_ms      BIGINT NULL,
  last_ok_ms                BIGINT NULL,
  disabled_reason           TEXT NULL,
  lan_allowlist             TEXT[] NOT NULL DEFAULT '{}',
  manifest                  JSONB NOT NULL,
  config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms             BIGINT NOT NULL,
  updated_at_ms             BIGINT NOT NULL,
  approved_at_ms            BIGINT NOT NULL,
  CONSTRAINT plugins_base_url_unique UNIQUE (base_url),
  CONSTRAINT plugins_disabled_reason_valid CHECK (
    disabled_reason IS NULL OR disabled_reason IN ('admin', 'breaker', 'scope-change')
  ),
  CONSTRAINT plugins_disabled_reason_consistency CHECK (
    (enabled = true AND disabled_reason IS NULL) OR (enabled = false)
  )
);

COMMENT ON TABLE plugins IS
  'Loombre Plugin Protocol (LPP) v1 registry (packages/plugin-protocol/spec/'
  'lpp-v1.md) — one row per registered out-of-process plugin (C1: a plugin '
  'is always a separate HTTP service, never in-process code). Written only '
  'via packages/db/src/query/plugins.ts''s transactional emit-helpers '
  '(apps/server/src/plugins/*.service.ts is the sole caller) — every state '
  'change lands with its matching plugin.* outbox event in the SAME '
  'transaction (docs/PLAN.md §4.3), the same discipline '
  'upsertServerSettingAndEmit established for server_settings.';

COMMENT ON COLUMN plugins.base_url IS
  'The plugin''s HTTP(S) origin (scheme + host + optional port, no path) — '
  'SSRF-guarded at every use (packages/plugin-host''s hardenedFetch, LD5). '
  'UNIQUE: re-registering the same endpoint updates/re-approves the '
  'existing row rather than creating a duplicate.';

COMMENT ON COLUMN plugins.version IS
  'The PLUGIN''s own version string from its manifest (LPP''s `version` '
  'field) — distinct from protocol_version.';

COMMENT ON COLUMN plugins.protocol_version IS
  'The LPP protocol version this plugin speaks (manifest `protocolVersion` '
  '— packages/plugin-protocol''s LPP_PROTOCOL_VERSION today). Registration '
  'rejects any other value (C2) before a row is ever written, so this is '
  'always the one supported value in practice; stored anyway so a future '
  'LPP v2 host can tell v1 rows apart without re-fetching every manifest.';

COMMENT ON COLUMN plugins.content_class IS
  'This plugin''s AGGREGATE content-class scope, computed by the '
  'registration/re-approval service (never a trigger — a plugin has no '
  'owning parent row): ''restricted'' iff any GRANTED capability''s '
  'manifest-declared contentClass is ''restricted'', else ''general''. '
  'Drives apps/server/src/plugins/scope.ts''s assertPluginAttachAllowed / '
  'pluginMayReceiveRestricted (mirrors apps/worker/src/metadata/'
  'registry.ts''s assertScope semantics verbatim).';

COMMENT ON COLUMN plugins.granted_capability_types IS
  'The subset of this plugin''s manifest-declared capability `type` values '
  '(LPP capabilities/index.ts CAPABILITY_TYPES: ''metadata-provider'' | '
  '''event-subscriber'') an admin has actually approved for use — LD6''s '
  '"capability set <= declared". A real column (not buried in `manifest` '
  'JSONB) because it is independently queried/filtered by every capability '
  'integration (W3/W4) and by the C5 scoping seam.';

COMMENT ON COLUMN plugins.health_state IS
  'ONE aggregate health value per plugin (LD7) — not per-capability. '
  '''unknown'' until the first health check completes. Transitions emit '
  'plugin.health-changed exactly on CHANGE (apps/server/src/plugins/'
  'plugin-health.service.ts), never on every check.';

COMMENT ON COLUMN plugins.consecutive_failures IS
  'DURABLE breaker counter (LD8): incremented on every failed/timed-out '
  'callPlugin outcome, reset to 0 on any success. Reaching '
  'packages/plugin-host''s exported LPP_BREAKER_FAILURE_THRESHOLD (5) '
  'auto-disables the plugin (enabled=false, disabled_reason=''breaker'') '
  'in the SAME transaction that records the crossing failure. Distinct '
  'from packages/plugin-host''s in-memory circuit-breaker state machine, '
  'which gates individual outbound calls per-process using this same '
  'failure signal but is never itself the durable count.';

COMMENT ON COLUMN plugins.last_health_check_ms IS
  'Epoch ms of the most recent health check attempt, regardless of '
  'outcome. NULL until the first check ever runs.';

COMMENT ON COLUMN plugins.last_ok_ms IS
  'Epoch ms of the most recent health check that succeeded. NULL if none '
  'ever has.';

COMMENT ON COLUMN plugins.disabled_reason IS
  'NULL while enabled=true; one of ''admin'' | ''breaker'' | '
  '''scope-change'' (LD4/LD8) while enabled=false — matches every '
  'plugin.disabled event payload''s `reason` field exactly. CHECK-'
  'constrained TEXT rather than a Postgres enum (mirrors migrations/'
  '0011_hw_capability_snapshots.sql''s backend/decode/encode/tone_map '
  'precedent): this closed set is local to this one table.';

COMMENT ON COLUMN plugins.lan_allowlist IS
  'Explicit hostnames/IP literals (LD5) this plugin is permitted to target '
  '(base_url, event-subscriber delivery endpoint, any config-declared URL '
  'a future capability resolves) even when they land in a private/'
  'loopback/link-local address range that packages/plugin-host''s '
  'hardenedFetch would otherwise reject. No CIDR/wildcard matching — exact '
  'string match only, an admin opts a plugin into a SPECIFIC address, '
  'never a subnet.';

COMMENT ON COLUMN plugins.manifest IS
  'Verbatim snapshot of the plugin''s GET /lpp/manifest response as fetched '
  'at last successful registration/re-approval/refresh — CLAUDE.md '
  'invariant 3 JSONB whitelist entry 8. Opaque to SQL (never queried field-'
  'by-field); the source of truth for capability re-diffing on re-fetch '
  '(LD6). NEVER placed in an event payload verbatim (LD4) — events carry '
  'only pluginId/name + specific old/new fields.';

COMMENT ON COLUMN plugins.config IS
  'Non-secret configSchema field values only (LD1) — CLAUDE.md invariant 3 '
  'JSONB whitelist entry 9. Every `secret: true` field lives in the '
  'keyring instead (`plugin-<pluginId>-<fieldName>`), never here.';

COMMENT ON COLUMN plugins.approved_at_ms IS
  'Epoch ms this row was last (re-)approved — set at initial registration '
  'and again by the re-approval service method after a scope-change '
  'auto-disable (LD6). NOT NULL: LPP v1 has no "pending approval" row '
  'state, approval always happens in the same transaction a row is '
  'inserted or re-approved.';

CREATE INDEX plugins_enabled_idx ON plugins (enabled);

CREATE TABLE plugin_event_grants (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  plugin_id      UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  granted_at_ms  BIGINT NOT NULL,
  CONSTRAINT plugin_event_grants_unique UNIQUE (plugin_id, event_type)
);

COMMENT ON TABLE plugin_event_grants IS
  'LD6''s "event grants <= requested": one row per outbox event `type` '
  '(packages/contract/event-schemas envelope enum) an admin has granted an '
  'event-subscriber-capability plugin, always a subset of that capability''s '
  'manifest-declared `eventTypes` request. ON DELETE CASCADE — removing a '
  'plugin removes its grants, no orphaned rows. Real rows, not a JSONB '
  'array on `plugins`, per CLAUDE.md invariant 4/property: grants are '
  'independently queried per event type by the outbox delivery path (W4).';

COMMENT ON COLUMN plugin_event_grants.event_type IS
  'One packages/contract/event-schemas envelope `type` enum value — '
  'validated against that taxonomy at grant time by the registration '
  'service (LD6), never re-validated by a DB constraint (the taxonomy is a '
  'TypeScript source of truth that evolves without a migration, the same '
  'reasoning migrations/0013_server_settings.sql''s header gives for not '
  'CHECK-constraining server_settings.key).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0015_library_provider_chains
--
-- Additive-only (mirrors 0002/.../0014's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Loombre Plugin Protocol (LPP) v1, Lane W3 (LD10/LD12, locked at W1
-- landing — see STATE.md). Per-library metadata-provider chains: an
-- ordered list of provider "slots" a library resolves its metadata
-- provider fallback chain through at metadata-job time, each slot either a
-- BUILT-IN provider (packages/db has no knowledge of the built-in provider
-- registry — apps/worker/src/metadata/registry.ts owns that; `builtin_name`
-- is validated against it at resolution time, never here) or a registered
-- LPP plugin (`plugin_id` FK into migrations/0014_plugins.sql's `plugins`
-- table).
--
-- ABSENT ROWS for a library is the documented default: apps/worker's
-- metadata consumer falls back to the legacy hardcoded PROVIDER_CHAIN per
-- media kind verbatim (behavior-neutrality by construction — an untouched
-- library resolves the IDENTICAL chain it always has). This table is never
-- pre-populated for existing libraries by this migration.
--
-- No `media_kind` column: unlike the legacy PROVIDER_CHAIN (one array PER
-- media kind, shared across every library), a chain here is scoped to ONE
-- library, and a library already has exactly one `media_kind`
-- (migrations/0001_init.sql) — a library-scoped chain inherently serves
-- only that one kind, so there is nothing to key on.
--
-- C5 STRICT scoping (apps/server/src/plugins/scope.ts's tightened rule —
-- see that file's header for the full "restricted-scoped plugin => never
-- attaches outside a restricted target; general-scoped plugin => never
-- receives restricted data through ANY capability" statement): a `plugin`
-- slot's plugin.content_class must EQUAL the owning library's
-- content_class exactly. Enforced at WRITE time by
-- packages/db/src/query/library-provider-chains.ts's replaceLibraryProviderChain
-- (a real, independently-testable application-level check reading both
-- rows inside the same transaction — not expressible as a single-table
-- CHECK constraint, since it depends on the referenced plugins/libraries
-- rows' own columns) and re-checked at chain-RESOLUTION time and again at
-- LPP-adapter-construction time by apps/worker (defense in depth per the
-- mission's explicit "even under misconfiguration" requirement — three
-- independent layers, not one).
--
-- `plugin_id` is `ON DELETE CASCADE` (a lane decision, not spelled out
-- character-for-character by the locked schema text but the only sane
-- choice available): `provider_kind = 'plugin'` rows always carry a
-- non-null `plugin_id` (the XOR check below), so `ON DELETE SET NULL`
-- would leave a row violating that CHECK the instant its plugin is
-- removed. CASCADE instead — removing a plugin quietly drops it from
-- every chain that referenced it (a gap in `position`, not renumbered;
-- resolution reads `ORDER BY position ASC` and does not require
-- contiguous values) rather than blocking `removePluginAndEmit` or leaving
-- an orphaned/inconsistent row behind.

CREATE TYPE library_provider_kind AS ENUM ('builtin', 'plugin');

CREATE TABLE library_provider_entries (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id     UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  position       INT NOT NULL,
  provider_kind  library_provider_kind NOT NULL,
  builtin_name   TEXT NULL,
  plugin_id      UUID NULL REFERENCES plugins(id) ON DELETE CASCADE,
  CONSTRAINT library_provider_entries_position_unique UNIQUE (library_id, position),
  CONSTRAINT library_provider_entries_kind_xor CHECK (
    (provider_kind = 'builtin' AND builtin_name IS NOT NULL AND plugin_id IS NULL) OR
    (provider_kind = 'plugin' AND plugin_id IS NOT NULL AND builtin_name IS NULL)
  )
);

COMMENT ON TABLE library_provider_entries IS
  'LPP v1 (Lane W3) per-library metadata-provider chain — one row per '
  'ordered slot. ABSENT rows for a library is the documented default: '
  'apps/worker''s metadata consumer falls back to the legacy hardcoded '
  'PROVIDER_CHAIN per media kind verbatim (behavior-neutrality by '
  'construction). Written only via '
  'packages/db/src/query/library-provider-chains.ts''s '
  'replaceLibraryProviderChain, which enforces the C5 STRICT '
  'content-class-equality rule at write time (see this migration''s header).';

COMMENT ON COLUMN library_provider_entries.position IS
  'Zero-based order within this library''s chain — resolution reads '
  '`ORDER BY position ASC`. UNIQUE per (library_id, position); gaps are '
  'legal (e.g. after a referenced plugin is removed via the CASCADE FK '
  'below) and never require renumbering the remaining rows.';

COMMENT ON COLUMN library_provider_entries.provider_kind IS
  'Which of the two slot kinds this row is — drives the XOR check below '
  'and which of builtin_name/plugin_id apps/worker''s chain-resolution '
  'reads to resolve this slot into an actual MetadataProvider.';

COMMENT ON COLUMN library_provider_entries.builtin_name IS
  'A built-in ProviderRegistry name (apps/worker/src/metadata/registry.ts '
  '— e.g. ''tmdb''/''tvdb''/''musicbrainz''), NOT NULL iff '
  'provider_kind=''builtin''. Unconstrained TEXT (no CHECK against a '
  'closed set): the built-in provider set is a TypeScript source of '
  'truth apps/worker owns, the same reasoning migrations/'
  '0013_server_settings.sql''s header gives for not CHECK-constraining '
  'server_settings.key. A name with nothing registered under it at '
  'resolution time is simply skipped (mirrors apps/worker/src/metadata/'
  'consumer.ts''s existing PROVIDER_CHAIN doc comment).';

COMMENT ON COLUMN library_provider_entries.plugin_id IS
  'FK into migrations/0014_plugins.sql''s plugins table, NOT NULL iff '
  'provider_kind=''plugin''. ON DELETE CASCADE — see this migration''s '
  'header for why SET NULL is not viable here (the XOR check would '
  'reject the resulting row) and why CASCADE (quietly drop the slot) is '
  'preferred over blocking plugin removal.';

CREATE INDEX library_provider_entries_plugin_id_idx ON library_provider_entries (plugin_id);

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0016_plugin_delivery_cursors
--
-- Additive-only (mirrors 0002/.../0015's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Loombre Plugin Protocol (LPP) v1, Lane W4 (LD13, locked at W1 landing —
-- see STATE.md), event-subscriber capability. Depends on migration 0014
-- (Lane W2: `plugins` incl. content_class/health_state/consecutive_failures/
-- lan_allowlist columns + `plugin_event_grants`) — this file only ever
-- REFERENCES plugins(id) and ADDs columns to it, never redefines it.
-- Apply-order relative to 0015 (Lane W3) is irrelevant per LD12: both
-- depend only on 0014.
--
-- ---------------------------------------------------------------------------
-- plugin_delivery_cursors — one row per plugin with the event-subscriber
-- capability, tracking exactly where the outbox-fanout delivery loop
-- (apps/worker/src/plugin-delivery/**) left off for that plugin, plus the
-- running delivery stats a future admin panel (W5b's delivery-stats panel,
-- per STATE.md's LPP lane burn-up) reads.
--
-- Real columns only (CLAUDE.md invariant 3 — no JSONB here; every field is
-- an id, a count, or an epoch-millisecond timestamp, none of which are on
-- the JSONB whitelist and none of which need to be).
--
-- `plugin_id` is BOTH the primary key and the only foreign key on this
-- table: exactly one cursor row per plugin (a plugin either has a delivery
-- position or it doesn't yet — never more than one), ON DELETE CASCADE so
-- removing a plugin (packages/db/src/query/plugins.ts's removePluginAndEmit)
-- cannot leave an orphaned cursor row behind.
--
-- `cursor_event_id` is deliberately NOT a foreign key to events(id): events
-- has no pruning/retention mechanism today, but this column must not become
-- a hard dependency on one never existing — a future events-retention sweep
-- must be free to delete old outbox rows without also being blocked by (or
-- needing to CASCADE into) a plugin's delivery bookkeeping. Comparisons
-- against it are always `events.id > cursor_event_id`, which works
-- identically whether the referenced id still has a live events row or not
-- (docs/PLAN.md's UUIDv7 keyset-cursor convention, packages/db/src/query/
-- events.ts's header). NULL means "never delivered a batch to this plugin
-- yet" (or the plugin's cursor was reset) — the delivery loop treats a NULL
-- cursor as "everything from the beginning of the retention window matches".
--
-- `last_attempt_ms` / `last_success_ms` are separate columns (not one
-- "last delivery" timestamp) so the delivery loop and a future health panel
-- can both compute "how long has this plugin been failing delivery" (now -
-- last_success_ms, while last_attempt_ms keeps advancing) without losing
-- either signal — collapsing them into one column would make a plugin that
-- is failing every attempt indistinguishable from one that simply has
-- nothing new to deliver.
--
-- `consecutive_failures` here is DELIBERATELY SEPARATE from
-- `plugins.consecutive_failures` (migrations/0014_plugins.sql): this
-- column drives ONLY the delivery loop's own per-plugin backoff pacing
-- (apps/worker/src/plugin-delivery/backoff.ts) and counts every non-2xx
-- delivery outcome (including an ordinary HTTP error response a
-- misbehaving plugin returns); `plugins.consecutive_failures` is the
-- DURABLE, cross-capability breaker-trip counter LD8 defines, written only
-- at the exact call whose failure trips @loombre/plugin-host's
-- PluginCircuitBreaker (timeout/network-error outcomes only — see that
-- package's call-plugin.ts header), the SAME "capability call failures
-- feed the shared breaker counter, but ordinary per-call bookkeeping stays
-- local to the capability" split Lane W3's apps/worker/src/metadata/
-- plugin-provider.ts already established for the metadata-provider
-- capability (that file's header: "ORDINARY non-tripping failures update
-- only the in-process breaker's own counters, never plugins.
-- consecutive_failures").
--
-- `delivered_batches` / `delivered_events` are monotonic lifetime counters
-- (never reset, never decremented) — the delivery-stats surface a future
-- admin panel (W5b) reads directly; `delivered_events` is always >=
-- `delivered_batches` since a batch always carries at least one event
-- (@loombre/plugin-protocol's LppEventBatchSchema: `events` is `min(1)`).
--
-- `gap_reported_through_ms` is the high-water mark of gap reporting (see
-- apps/worker/src/plugin-delivery/delivery-loop.ts): the epoch-ms boundary
-- through which a retention-window gap has already been REPORTED to this
-- plugin in a delivered batch's `gapReport` field. NULL means no gap has
-- ever been reported. This column exists purely to make gap reporting
-- idempotent — it is never used to decide whether to serve events, only
-- whether an already-told gap needs telling again.
-- ---------------------------------------------------------------------------

CREATE TABLE plugin_delivery_cursors (
  plugin_id                UUID PRIMARY KEY REFERENCES plugins(id) ON DELETE CASCADE,
  cursor_event_id          UUID NULL,
  last_attempt_ms          BIGINT NULL,
  last_success_ms          BIGINT NULL,
  consecutive_failures     INT NOT NULL DEFAULT 0,
  delivered_batches        BIGINT NOT NULL DEFAULT 0,
  delivered_events         BIGINT NOT NULL DEFAULT 0,
  gap_reported_through_ms  BIGINT NULL
);

COMMENT ON TABLE plugin_delivery_cursors IS
  'One row per plugin with the event-subscriber capability (LPP v1, Lane '
  'W4): the outbox-fanout delivery loop''s per-plugin resume position plus '
  'lifetime delivery stats. A plugin with no row here has never been '
  'through the delivery loop at all (distinct from a NULL cursor_event_id '
  'on an existing row, which means "has a row, delivered nothing yet" — '
  'both are treated identically by the loop, the row is created lazily on '
  'first delivery attempt).';

COMMENT ON COLUMN plugin_delivery_cursors.cursor_event_id IS
  'The events.id (UUIDv7) of the last event successfully included in a '
  '2xx-acknowledged batch for this plugin — advanced ONLY together with '
  'delivered_batches/delivered_events/last_success_ms in the same '
  'transaction (packages/db/src/query/plugins-delivery.ts), never '
  'speculatively. NULL = never delivered. Not a foreign key to events(id) '
  '— see this migration''s header.';

COMMENT ON COLUMN plugin_delivery_cursors.last_attempt_ms IS
  'Epoch ms of the most recent delivery attempt for this plugin, success '
  'or failure. Used by the delivery loop''s backoff pacing to decide '
  'whether enough time has elapsed since the last attempt to retry.';

COMMENT ON COLUMN plugin_delivery_cursors.last_success_ms IS
  'Epoch ms of the most recent 2xx-acknowledged batch. Unlike '
  'last_attempt_ms, this does NOT advance on failure — the gap between the '
  'two is exactly "how long has this plugin been unreachable/failing".';

COMMENT ON COLUMN plugin_delivery_cursors.consecutive_failures IS
  'Count of consecutive non-2xx delivery outcomes since the last success, '
  'reset to 0 on every success. Drives exponential backoff pacing '
  '(apps/worker/src/plugin-delivery/backoff.ts) — DELIBERATELY SEPARATE '
  'from plugins.consecutive_failures (migrations/0014_plugins.sql), the '
  'durable cross-capability breaker-trip counter — see this migration''s '
  'header.';

COMMENT ON COLUMN plugin_delivery_cursors.delivered_batches IS
  'Lifetime count of batches this plugin has 2xx-acknowledged. Monotonic, '
  'never reset — part of the delivery-stats surface a future admin panel '
  '(W5b) reads.';

COMMENT ON COLUMN plugin_delivery_cursors.delivered_events IS
  'Lifetime count of individual events this plugin has 2xx-acknowledged '
  '(the sum of every acknowledged batch''s events.length). Monotonic, '
  'never reset. Always >= delivered_batches, since LppEventBatchSchema''s '
  '`events` array is min(1).';

COMMENT ON COLUMN plugin_delivery_cursors.gap_reported_through_ms IS
  'High-water mark (epoch ms) through which a retention-window gap has '
  'already been reported to this plugin in a delivered batch''s '
  '`gapReport` field (LPP_DELIVERY_RETENTION_WINDOW_MS, apps/worker/src/'
  'plugin-delivery/delivery-loop.ts). NULL = no gap has ever been '
  'reported. Purely an idempotency watermark — never consulted to decide '
  'which events to serve, only whether an already-reported gap needs '
  're-reporting.';

-- ---------------------------------------------------------------------------
-- plugins: pseudonymization posture (default ON — LPP v1 mission §3.2:
-- "user-data minimization — pseudonymous actor ids by DEFAULT, per-plugin
-- toggle for real identity"). Additive ALTERs only.
-- ---------------------------------------------------------------------------

ALTER TABLE plugins ADD COLUMN pseudonymize_actor_ids BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE plugins ADD COLUMN pseudonym_salt TEXT NULL;

COMMENT ON COLUMN plugins.pseudonymize_actor_ids IS
  'Default TRUE (LPP v1 mission §3.2): when true, every user-id-bearing '
  'payload field the actor-field map (apps/worker/src/plugin-delivery/'
  'actor-field-map.ts) names for that event''s type is replaced with a '
  'per-(plugin,user) stable pseudonym (hex hmac-sha256(pseudonym_salt, '
  'realUserId)) before signing and delivery. When false, real user ids '
  'pass through unchanged. Toggled by the admin Plugins surface (W5b, per '
  'STATE.md''s LPP lane burn-up) — this column is only read, never '
  'written, by the delivery loop itself.';

COMMENT ON COLUMN plugins.pseudonym_salt IS
  'Random 32-byte value, hex-encoded, minted LAZILY on this plugin''s '
  'first delivery attempt (packages/db/src/query/plugins-delivery.ts''s '
  'ensurePseudonymSalt — read-or-mint inside the same transaction as the '
  'attempt, so two racing delivery ticks can never mint two different '
  'salts for one plugin). NULL until then. Distinct per plugin by '
  'construction, which is what makes pseudonyms cross-plugin unlinkable: '
  'the same real user id hashes to a DIFFERENT pseudonym for every plugin '
  'that has ever received an event about them. Never exposed outside this '
  'table — not logged, not included in any delivered payload, not the '
  'same secret as plugin-hmac-<pluginId> (LD9''s delivery-signing secret, '
  'keyring-only) — this is a DB-persisted value by design, since it is not '
  'a credential, only a hashing input.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0017_watchlists
--
-- Phosphor retheme + responsive rebuild, Wave 2 lane L3 (Watchlist + Person
-- routes) — design/phosphor/README.md's Watchlist screen + "Your Watchlist"
-- Home rail + detail-screen toggle, and the README's State management
-- section ("Shared client state: watchlist (id -> bool) ... must sync
-- across devices via the events socket").
--
-- Real columns only (CLAUDE.md invariant 3 — no JSONB): user_id FK, item_id
-- FK, added_at_ms. Mirrors migrations/0001_init.sql's `progress` table
-- EXACTLY (composite PRIMARY KEY (user_id, item_id) IS the "UNIQUE pair"
-- requirement — a user can only have one watchlist row per item, adding an
-- already-present item is an idempotent no-op via ON CONFLICT DO NOTHING,
-- see packages/db/src/query/watchlist.ts) — no separate surrogate id, no
-- separate UNIQUE constraint needed on top of the PK.
--
-- Guard posture (docs/PLAN.md §6.4): this table carries NO content_class of
-- its own (same as `progress`) — its only leak surface is "is the
-- referenced catalog_items row visible to ctx", enforced by
-- applyGuardToJoined(ctx, 'watchlists.item_id') on every read, exactly like
-- progress.ts's getContinueWatching/listProgress. Writes (addToWatchlistAndEmit)
-- additionally gate on getItemById(ctx, itemId) first — see that function's
-- header for why this makes ADD of a zone title UNREACHABLE for an
-- uncleared viewer (the item is indistinguishable from nonexistent, same as
-- upsertProgress's precedent) — enforced server-side in the query layer,
-- not merely by the client hiding the toggle button.
CREATE TABLE watchlists (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  added_at_ms   BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

COMMENT ON TABLE watchlists IS
  'One row per (user, item) the user has saved to their watchlist '
  '(design/phosphor README.md Watchlist screen + Home "Your Watchlist" '
  'rail + detail-screen toggle). UPSERT-only writes (ON CONFLICT DO '
  'NOTHING on add) make this concurrent-write-safe by construction, same '
  'as progress''s header note. No content_class of its own — visibility is '
  'entirely a function of the referenced catalog_items row (see '
  'packages/db/src/query/watchlist.ts).';

COMMENT ON COLUMN watchlists.added_at_ms IS
  'Epoch ms the item was added — the ONLY ordering key for the watchlist '
  'list (newest-first), keyset-paginated on (added_at_ms, item_id) both '
  'DESC, mirroring progress.ts''s listProgress cursor shape exactly.';

CREATE INDEX watchlists_user_added_idx
  ON watchlists (user_id, added_at_ms DESC, item_id DESC);

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0018_stash_provider_core
--
-- Additive-only (mirrors 0002/.../0017's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface", kicked off 2026-08-01), Lane A
-- (provider core). Three tables, pre-assigned this migration number (K8,
-- to avoid parallel-lane collisions with Lane B's 0019/Lane C's 0020/Lane
-- E's 0021):
--
--   library_stash_connections — one row per library that has a Stash
--     SQLite database attached (S1: first-party, restricted-scoped
--     provider). Config (sqlite_path, admin enabled/disabled) plus the
--     LAST OBSERVED connection outcome (status/last_seen_schema_version/
--     timestamps) — apps/worker/src/stash/connect.ts (Lane A) writes the
--     status columns every time it attempts to open the Stash database;
--     apps/server's future admin surface (Lane D) writes sqlite_path/
--     enabled/path mappings.
--
--   library_path_mappings — S4's "per-library path-mapping table (Stash
--     path prefixes <-> Loombre mount view)". Shape imitates migrations/
--     0015_library_provider_chains.sql's library_provider_entries: an
--     ordered list of rows per library, `position` for admin display
--     order (packages/shared/src/stash-path-mapping.ts's matching
--     algorithm is LONGEST-PREFIX-WINS, independent of `position` —
--     position is stored ordering only, never matching precedence).
--
--   stash_scene_links — the matching backbone (S4): one row per Stash
--     scene EVER SEEN during an inventory/sync pass for a library,
--     regardless of whether it has been matched to a Loombre catalog
--     item. `item_id IS NULL` is the documented "unmatched, visible by
--     construction" state (S4's "unmatched Stash scenes AND unmatched
--     Loombre files land VISIBLY" — the Loombre-file half of that
--     visibility is a plain LEFT JOIN against media_files in the
--     preview query below, needing no schema of its own). K10: the
--     SERVER never opens the Stash SQLite file directly — this table is
--     what lets an admin "N of M matched" preview be pure SQL over
--     already-stored Stash facts (packages/db/src/query/stash-inventory.ts's
--     computePathMappingMatchPreview) rather than a live SQLite read.

-- ============================================================================
-- library_stash_connections
-- ============================================================================

CREATE TYPE stash_connection_status AS ENUM (
  'never_connected',
  'ok',
  'unsupported_schema',
  'unreachable'
);

CREATE TABLE library_stash_connections (
  id                       UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id               UUID NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE CASCADE,
  sqlite_path              TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  status                   stash_connection_status NOT NULL DEFAULT 'never_connected',
  status_detail            TEXT NULL,
  last_seen_schema_version INT NULL,
  last_connected_at_ms     BIGINT NULL,
  last_checked_at_ms       BIGINT NULL,
  created_at_ms            BIGINT NOT NULL,
  updated_at_ms            BIGINT NOT NULL
);

COMMENT ON TABLE library_stash_connections IS
  'One row per library with a Stash SQLite database attached (S1). '
  'UNIQUE(library_id) enforces "one per library" (K8) — a library either '
  'has no Stash connection configured (no row) or exactly one. Config '
  '(sqlite_path/enabled) is admin-written; the status columns are '
  'written by apps/worker/src/stash/connect.ts (Lane A) every time it '
  'attempts to open this library''s Stash database — this table is the '
  'durable record of the LAST OBSERVED outcome, not a live probe.';

COMMENT ON COLUMN library_stash_connections.sqlite_path IS
  'Filesystem path to the Stash SQLite database file, as seen from the '
  'WORKER process (the server never opens this file directly — K10). '
  'No CHECK on existence/readability here — that is verified empirically '
  'at connect time, not at config-write time (the path may reference a '
  'not-yet-mounted volume).';

COMMENT ON COLUMN library_stash_connections.enabled IS
  'Admin intent: whether this connection should be used at all (attach/ '
  'detach without deleting the row, preserving sqlite_path + path '
  'mappings). Independent of `status` — an admin can leave a connection '
  'enabled while its last observed status is ''unreachable'' (a mount '
  'that will come back), or disable a connection that is currently ''ok'' '
  '(a deliberate pause).';

COMMENT ON COLUMN library_stash_connections.status IS
  'The LAST OBSERVED outcome of opening this Stash database (S2/S3): '
  '''never_connected'' (the default — configured but never attempted, or '
  'a fresh row), ''ok'' (opened, schema version within the supported '
  'range), ''unsupported_schema'' (S3 — schema version outside the '
  'pinned supported range; the provider disables itself and '
  'status_detail carries the exact admin notice), ''unreachable'' (S2 — '
  'every open attempt, including the WAL-locked retry and snapshot-copy '
  'fallback, failed — e.g. the path does not exist, the volume is '
  'unmounted, or the file remained locked past the retry budget).';

COMMENT ON COLUMN library_stash_connections.status_detail IS
  'Human-readable detail for the current `status` — for '
  '''unsupported_schema'' this is the EXACT S3 notice string ("Stash '
  'schema vNN unsupported; supported: X-Y"), mirrored verbatim into the '
  '`stash.provider.disabled` event payload''s `notice` field (K12). NULL '
  'for ''ok''/''never_connected''.';

COMMENT ON COLUMN library_stash_connections.last_seen_schema_version IS
  'The Stash `schema_migrations` version observed at the most recent '
  'connect attempt, regardless of whether it was in the supported range '
  '— kept even when `status = ''unsupported_schema''` so the admin '
  'notice and this row agree on which version was seen.';

-- ============================================================================
-- library_path_mappings
-- ============================================================================

CREATE TABLE library_path_mappings (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id     UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  stash_prefix   TEXT NOT NULL,
  loombre_prefix TEXT NOT NULL,
  position       INT NOT NULL,
  CONSTRAINT library_path_mappings_position_unique UNIQUE (library_id, position)
);

COMMENT ON TABLE library_path_mappings IS
  'S4 per-library path-mapping table: Stash path prefixes <-> Loombre '
  'mount view. Shape imitates migrations/0015_library_provider_chains.sql''s '
  'library_provider_entries (UNIQUE(library_id, position), gaps legal, '
  'never renumbered). Matching itself (packages/shared/src/'
  'stash-path-mapping.ts''s rewriteStashPath) is LONGEST-PREFIX-WINS over '
  'ALL of a library''s mappings, not position-ordered precedence — '
  '`position` here is admin DISPLAY order only.';

COMMENT ON COLUMN library_path_mappings.stash_prefix IS
  'Path prefix as Stash reports it (e.g. Stash running on a different '
  'host/container that sees the same media at a different mount point). '
  'Compared case-sensitively, segment-boundary-matched — see '
  'stash-path-mapping.ts''s header for the exact matching rules.';

COMMENT ON COLUMN library_path_mappings.loombre_prefix IS
  'The equivalent prefix under Loombre''s own mount view — the rewritten '
  'path (stash_prefix replaced by this) is what gets matched against '
  'media_files.path (S4 primary match).';

-- ============================================================================
-- stash_scene_links
-- ============================================================================

CREATE TABLE stash_scene_links (
  id                  UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id          UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  stash_scene_id      TEXT NOT NULL,
  stash_path          TEXT NOT NULL,
  stash_oshash        TEXT NULL,
  stash_size_bytes    BIGINT NULL,
  stash_updated_at_ms BIGINT NULL,
  item_id             UUID NULL REFERENCES catalog_items(id) ON DELETE SET NULL,
  matched_by          TEXT NULL CHECK (matched_by IN ('path', 'oshash')),
  stale               BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at_ms   BIGINT NOT NULL,
  CONSTRAINT stash_scene_links_library_scene_unique UNIQUE (library_id, stash_scene_id)
);

COMMENT ON TABLE stash_scene_links IS
  'The S4 matching backbone: one row per Stash scene EVER SEEN by an '
  'inventory/sync pass for a library (K10) — populated by apps/worker''s '
  'Stash adapter, never by a live server-side SQLite read. '
  '`item_id IS NULL` is the documented "unmatched, visible by '
  'construction" state (S4) — this table is never pruned down to only '
  'matched rows, so an admin can always see every Stash scene the '
  'inventory pass found, matched or not. UNIQUE(library_id, '
  'stash_scene_id): a Stash scene id is only unique within the one '
  'SQLite database a library is attached to, never globally.';

COMMENT ON COLUMN stash_scene_links.stash_scene_id IS
  'Stash''s own scene identifier, stored as TEXT (mirrors '
  'provider_ids.external_id''s "provider''s own id, as a string" '
  'convention — apps/worker/src/metadata/providers/stash.ts addresses a '
  'ProviderRef.externalId as "<libraryId>:<stashSceneId>", see that '
  'file''s header) — never assumed numeric, in case a future Stash '
  'schema version changes its id representation.';

COMMENT ON COLUMN stash_scene_links.stash_path IS
  'The Stash-reported file path for this scene, UNMAPPED (raw, as Stash '
  'itself stores it) — computePathMappingMatchPreview (packages/db/src/'
  'query/stash-inventory.ts) applies a library''s current path mappings '
  'to this value at query time, so changing a mapping never requires '
  're-running the inventory pass before the preview reflects it.';

COMMENT ON COLUMN stash_scene_links.stash_oshash IS
  'Stash''s 64KB head/tail oshash for the scene''s primary file, when '
  'Stash has one on record. NULL is common and not an error — S4''s '
  'secondary match only computes Loombre''s own oshash LAZILY, for '
  'candidates that fail the primary path-mapped match, so a row is '
  'never required to carry this to be useful.';

COMMENT ON COLUMN stash_scene_links.item_id IS
  'The matched Loombre catalog item, or NULL when unmatched. '
  'ON DELETE SET NULL (not CASCADE): deleting a catalog item must not '
  'delete Stash''s knowledge that the scene exists — it reverts to '
  'unmatched (visible again) rather than disappearing, so a rescan/'
  'rematch can re-attach it without a fresh inventory pass.';

COMMENT ON COLUMN stash_scene_links.matched_by IS
  'Which S4 tier produced the current `item_id` match — ''path'' '
  '(primary: path-mapped Stash path equals a media_files.path exactly) '
  'or ''oshash'' (secondary: size + oshash fallback for candidates the '
  'path tier missed). NULL when `item_id IS NULL`.';

COMMENT ON COLUMN stash_scene_links.stale IS
  'S8 (Lane C): set TRUE when a later sync no longer sees this scene in '
  'Stash (a Stash-side deletion) — the row and its match are KEPT '
  '(never destructive, provenance-flagged, admin-filterable) rather than '
  'deleted. Lane A creates the column; Lane C''s sync engine is the only '
  'writer that ever sets it TRUE.';

-- ============================================================================
-- indexes (index law: land WITH the tables/queries that need them)
-- ============================================================================

-- computePathMappingMatchPreview (packages/db/src/query/stash-inventory.ts)
-- and the future admin "unmatched scenes" panel both filter
-- stash_scene_links by library_id first, then either read stash_path (to
-- rewrite + compare against media_files.path) or filter on item_id IS
-- NULL — the UNIQUE(library_id, stash_scene_id) constraint above already
-- gives an index usable for the plain library_id-prefixed lookups, so no
-- separate library_id-only index is added (would be redundant with the
-- unique constraint's own index, which already leads with library_id).

-- Reverse lookup (catalog item -> its linked Stash scene, e.g. for a
-- per-item refresh or an admin "unlink" action) — partial, since most
-- catalog items are never Stash-linked and a full index would waste space
-- indexing millions of general-library NULLs at the owner's 33k+ scale
-- (STATE.md S10).
CREATE INDEX stash_scene_links_item_id_idx ON stash_scene_links (item_id) WHERE item_id IS NOT NULL;

-- The "N of M matched" preview's other join key: for a given library, list
-- every UNMATCHED scene's stash_path to rewrite+compare (K10). Partial on
-- item_id IS NULL for the same reason as above — this is the exact set
-- computePathMappingMatchPreview scans, so the partial index covers its
-- full working set instead of the whole table.
CREATE INDEX stash_scene_links_unmatched_idx ON stash_scene_links (library_id) WHERE item_id IS NULL;

COMMENT ON INDEX stash_scene_links_item_id_idx IS
  'Partial (item_id IS NOT NULL): reverse item -> scene lookup, e.g. a '
  'per-item metadata refresh resolving which stash_scene_links row backs '
  'an already-matched catalog item. Most rows at scale are unmatched or '
  'belong to non-restricted libraries, so a full index would be mostly '
  'NULLs.';

COMMENT ON INDEX stash_scene_links_unmatched_idx IS
  'Partial (item_id IS NULL): the exact working set of '
  'computePathMappingMatchPreview''s "unmatched" half and the future '
  'admin unmatched-scenes panel (S4''s "visible by construction" '
  'requirement) — scoped by library_id, EXPLAIN-verified in '
  'packages/db/test/stash-inventory.spec.ts to avoid a sequential scan '
  'at the owner''s 33k-scene scale (S10).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0019_restricted_editorial_schema
--
-- Additive-only (mirrors 0002/.../0018's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations. The one constraint
-- REPLACEMENT below (item_tags_kind_check) strictly WIDENS an enum-like
-- CHECK — every previously-legal row stays legal — which is the same
-- additive spirit as 0004's unique-constraint replacement.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface"), shared editorial schema —
-- authored by the ORCHESTRATOR (not a lane) because Lanes B (mapping),
-- C (sync), and D (zone surface) all build against these shapes in
-- parallel worktrees; landing the DDL first removes every cross-lane
-- schema dependency (STATE.md K8 as amended). Rulings implemented here:
--
--   K2  — tags gain an entity-level `kind` (general | genre | studio):
--         studios are first-class VIA the tags mechanism (S6), no new
--         entity table; the EDGE-level item_tags.kind CHECK widens to
--         admit 'studio' edges.
--   S5  — tags gain `parent_tag_id`: Stash preserves tag hierarchy as a
--         parent link; we keep exactly that (a single optional parent),
--         not a new hierarchy table.
--   K1  — movie_details gains `premiere_at_ms`: scenes are item_type
--         'movie' rows and no premiere-date column existed for
--         movie-shaped items (catalog_items.year stays the denormalized
--         year, as for every movie).
--   K3  — person_attributes: the S5 performer metadata (aliases,
--         birthdate, country, measurements) has no home — item_attributes
--         FKs catalog_items and people carry only name + content_class.
--         Mirrors item_attributes exactly (namespaced sandbox, core code
--         never reads it, JSONB values whitelisted BY ANALOGY to plan
--         §6.3's item_attributes entry — flagged Open for owner sign-off
--         in STATE.md).
--   K9  — chapter_markers: Stash scene markers become chapters. The
--         mission brief said "seconds"; house law (CLAUDE.md invariant 5,
--         milliseconds everywhere) wins — `start_ms`, converted at map
--         time. Content-agnostic table: `source` is CHECK-constrained to
--         the writers that actually exist ('stash' today), widened
--         additively when another producer appears.
--   K15 — library_stash_connections gains `genre_tag_names`: S6's
--         admin-configurable "which Stash tags map to genre vs general".
--         NULL = the documented default heuristic (Lane B's mapper owns
--         and documents it); a non-NULL array is an explicit admin list.

-- ============================================================================
-- tags: entity-level kind + hierarchy parent (K2, S5/S6)
-- ============================================================================

ALTER TABLE tags
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'
    CONSTRAINT tags_kind_check CHECK (kind IN ('general', 'genre', 'studio'));

ALTER TABLE tags
  ADD COLUMN parent_tag_id UUID NULL REFERENCES tags(id) ON DELETE SET NULL;

COMMENT ON COLUMN tags.kind IS
  'Entity-level kind (K2/S6): ''general'' (default — every pre-existing '
  'row), ''genre'', or ''studio''. Studios are first-class VIA tags: a '
  'studio is a kind=studio tag with its logo in `images` (entity_type '
  '''tag''), so studio browse/filter is tag-filtering the ViewerContext '
  'guard already scopes — deliberately NOT a new entity table. Distinct '
  'from item_tags.kind, which classifies one EDGE (how a tag applies to '
  'one item); this column classifies the tag itself (what kind of thing '
  'it names). The pair is deliberately redundant for genre/studio edges '
  '(a kind=studio tag attaches via kind=studio edges) — the edge kind '
  'keeps per-item queries index-local, the entity kind gives '
  'studio/genre PAGES a direct scan without a join through item_tags.';

COMMENT ON COLUMN tags.parent_tag_id IS
  'S5: Stash tag hierarchy, preserved as a single optional parent link '
  '(exactly what Stash''s schema provides — parent/child tag relations). '
  'ON DELETE SET NULL: deleting a parent orphans children back to roots, '
  'never cascades a subtree away. NULL for every non-Stash tag today; '
  'general metadata providers do not write it.';

-- Studio/genre pages scan tags by kind directly (Lane D's zone queries);
-- partial because the overwhelming majority of rows are kind='general'
-- and a full index would be mostly the default value.
CREATE INDEX tags_kind_idx ON tags (kind, content_class) WHERE kind <> 'general';

COMMENT ON INDEX tags_kind_idx IS
  'Partial (kind <> ''general''): the studios/genres working set for the '
  'restricted zone''s studio rails/pages and genre filters (S9). '
  'content_class second so the guard''s class filter stays in the index '
  'condition. Kind=''general'' rows (the vast majority) are deliberately '
  'unindexed — nothing queries "all general tags by kind".';

-- Child lookup for hierarchy display; partial for the same
-- mostly-NULL reason as stash_scene_links'' partial indexes (0018).
CREATE INDEX tags_parent_tag_id_idx ON tags (parent_tag_id) WHERE parent_tag_id IS NOT NULL;

-- ============================================================================
-- item_tags: admit 'studio' edges (K2)
-- ============================================================================

ALTER TABLE item_tags DROP CONSTRAINT item_tags_kind_check;
ALTER TABLE item_tags
  ADD CONSTRAINT item_tags_kind_check CHECK (kind IN ('genre', 'tag', 'studio'));

COMMENT ON COLUMN item_tags.kind IS
  'Edge-level classification of how this tag applies to this item: '
  '''genre'' (provider genres), ''tag'' (free-form tags), ''studio'' '
  '(K2 — the item''s studio attribution; the referenced tag row carries '
  'tags.kind=''studio''). Widened from (genre|tag) by migration 0019 — '
  'strictly additive, every pre-0019 row remains legal.';

-- ============================================================================
-- movie_details: editorial premiere date (K1)
-- ============================================================================

ALTER TABLE movie_details ADD COLUMN premiere_at_ms BIGINT NULL;

COMMENT ON COLUMN movie_details.premiere_at_ms IS
  'Editorial premiere/release date, epoch ms (K1). For Stash-synced '
  'scenes this is Stash''s scene `date` (S5 — Stash is authoritative for '
  'EDITORIAL facts); catalog_items.year stays the denormalized year '
  'derived from it, exactly as year is handled for every other movie '
  'source. NULL for the many items whose sources carry no full date — '
  'consumers fall back to catalog_items.year.';

-- ============================================================================
-- person_attributes (K3)
-- ============================================================================

CREATE TABLE person_attributes (
  id        UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     JSONB NOT NULL,
  UNIQUE (person_id, namespace, key)
);

COMMENT ON TABLE person_attributes IS
  'Person-scoped twin of item_attributes (K3): a namespaced extension '
  'sandbox for facts about a PERSON that the typed people schema does '
  'not model (S5: performer aliases, birthdate, country, measurements '
  'under the stash: namespace). Same law as item_attributes: core code '
  'never reads this table — only the namespaced feature that owns a '
  'namespace does. JSONB `value` is a whitelist extension BY ANALOGY to '
  'plan §6.3''s item_attributes entry, flagged Open for owner sign-off '
  'in STATE.md. The person''s content_class (on people) already scopes '
  'guard visibility — attributes ride the person, so no class column '
  'here.';

-- ============================================================================
-- chapter_markers (K9/S7)
-- ============================================================================

CREATE TABLE chapter_markers (
  id       UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id  UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('stash'))
);

COMMENT ON TABLE chapter_markers IS
  'Chapter markers for an item''s timeline (S7): Stash scene markers '
  'today (source=''stash'', written wholesale-replace per sync by Lane '
  'B''s mapper), rendered as player chapter ticks + a chapter list and '
  'deep-linkable start offsets. Content-agnostic on purpose — a future '
  'general-content chapter producer widens the source CHECK additively. '
  'start_ms not seconds: K9, CLAUDE.md invariant 5 (Stash''s REAL '
  'seconds are converted at map time). No uniqueness on (item_id, '
  'start_ms): two markers at the same offset are legal in Stash and '
  'preserved verbatim.';

-- The player + scene-detail read path: all markers for one item, ordered
-- by offset — the composite makes that an index-only ordered scan.
CREATE INDEX chapter_markers_item_start_idx ON chapter_markers (item_id, start_ms);

COMMENT ON INDEX chapter_markers_item_start_idx IS
  'The one read path (S7): GET chapters for an item, ordered by '
  'start_ms. Guard visibility rides the owning item (applyGuardToJoined '
  'on item_id), same pattern as item_tags/item_people.';

-- ============================================================================
-- library_stash_connections: genre mapping config (K15/S6)
-- ============================================================================

ALTER TABLE library_stash_connections ADD COLUMN genre_tag_names TEXT[] NULL;

COMMENT ON COLUMN library_stash_connections.genre_tag_names IS
  'S6/K15: which Stash tag names map to Loombre genre (kind=genre) '
  'rather than general tags. NULL = the default heuristic (owned + '
  'documented by the Stash mapper in apps/worker/src/stash/) — an '
  'explicit admin-saved array replaces the heuristic wholesale. Names, '
  'not ids: Stash tag ids are meaningless outside one SQLite file, and '
  'admins reason in names.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0020_stash_sync_reports
--
-- Additive-only (mirrors 0002/.../0019's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface"), Lane C (sync engine, S8/K14).
-- Pre-assigned this migration number (K8 amended: A=0018, B=0019, C=0020,
-- E=0021). Two tables:
--
--   stash_sync_reports — one row per `stash-sync` job RUN (not per scene):
--   library_id/job_id/mode/status plus the five S8 counts
--   (matched/updated/unmatched/stale/skipped) and started/finished
--   timestamps. This is the admin-visible sync-report ARTIFACT (K14's
--   GET /admin/libraries/{id}/stash-sync-report reads the latest row per
--   library) — counts are a point-in-time SNAPSHOT recorded when the run
--   finished (or failed), same posture as scan.completed's own
--   itemsAdded/Updated/Removed. Deliberately does NOT duplicate the
--   unmatched/stale SCENE LISTS: those are computed LIVE from
--   stash_scene_links (item_id IS NULL / stale = TRUE — Lane A's table,
--   K10) at read time, via the new partial indexes below, so the report
--   table never goes stale relative to the live link table between syncs
--   (e.g. an admin fixing a path mapping and re-previewing without a full
--   resync).
--
--   stash_sync_checkpoints — resumable progress for an in-flight
--   `stash-sync` job (deliverable 2: "a full 33k sync survives worker
--   death and resumes without redoing completed work"). Mirrors
--   migrations/0002_phase1_catalog.sql's scan_checkpoints table SHAPE and
--   MECHANISM exactly (job_id PRIMARY KEY, same-job-id-on-retry: pg-boss
--   redispatches a failed job under the SAME job.id — see
--   packages/jobs/src/queue.ts's work() batch handler, `attempts =
--   job.retryCount + 1` — so a checkpoint keyed by job_id survives a
--   retry) but is its OWN table rather than a reuse of scan_checkpoints:
--   that table's columns (last_processed_path/files_seen/files_processed)
--   are scanner-specific by name and by its own COMMENT ("the scanner
--   reads ... to resume a crashed or restarted job") — reusing it here
--   would mean storing a Stash scene id in a column literally named
--   "path" and a scene count in a column literally named "files_seen",
--   which is exactly the kind of column-semantics drift CLAUDE.md
--   invariant 3 ("real columns... never JSONB-as-a-junk-drawer") argues
--   against in spirit. apps/worker/src/stash/sync-consumer.ts's own
--   header records this choice (vs. the image-backfill self-requeue-
--   cursor pattern) and why: `stash-sync` is registered LONG_RUNNING
--   (packages/jobs/src/types.ts, 23h expire) with retryLimit 2 — ONE job
--   holds its handler promise for the WHOLE run and pg-boss itself
--   retries it under the same id, exactly matching 'scan''s shape, not
--   image-backfill's BOUNDED short-batch-per-job-id shape.

-- ============================================================================
-- stash_sync_reports
-- ============================================================================

CREATE TYPE stash_sync_mode AS ENUM ('full', 'incremental');

CREATE TYPE stash_sync_report_status AS ENUM ('running', 'succeeded', 'failed', 'partial');

CREATE TABLE stash_sync_reports (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id        UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  -- Not a FK to jobs(id), same posture as scan_checkpoints.job_id (this
  -- file's header) — the report row's lifecycle is independent of
  -- @loombre/jobs' own ledger row lifecycle.
  job_id            UUID NOT NULL,
  mode              stash_sync_mode NOT NULL,
  status            stash_sync_report_status NOT NULL DEFAULT 'running',
  matched_count     INT NOT NULL DEFAULT 0,
  updated_count     INT NOT NULL DEFAULT 0,
  unmatched_count   INT NOT NULL DEFAULT 0,
  stale_count       INT NOT NULL DEFAULT 0,
  skipped_count     INT NOT NULL DEFAULT 0,
  started_at_ms     BIGINT NOT NULL,
  finished_at_ms    BIGINT NULL
);

COMMENT ON TABLE stash_sync_reports IS
  'One row per stash-sync job RUN (S8) — counts + provenance, never the '
  'unmatched/stale SCENE LISTS themselves (those stay live queries over '
  'stash_scene_links, see this migration''s header). status starts '
  '''running'' at job start and is finalized to ''succeeded''/''failed''/ '
  '''partial'' in the SAME transaction that writes the paired '
  '`stash.sync.completed` event (K12) — a row is never left ''running'' '
  'forever except while a job is genuinely still in flight or has just '
  'crashed without reaching the terminal-failure hook yet.';

COMMENT ON COLUMN stash_sync_reports.job_id IS
  'The pg-boss job id this report row tracks (packages/jobs, meta.jobId) '
  '— NOT a foreign key (see this table''s own comment). Used to '
  'correlate a report row with its stash_sync_checkpoints row (same '
  'job_id) while the run is in flight.';

COMMENT ON COLUMN stash_sync_reports.status IS
  '''running'' from job start until a terminal write. ''succeeded'': '
  'the run completed with no unhandled error. ''partial'': the run '
  'completed but skipped_count > 0 for a reason short of a full failure '
  '(documented per-scene skip, e.g. a scene with no linked Stash file at '
  'all — never used to paper over a bug). ''failed'': the job exhausted '
  'its retries (apps/worker/src/stash/sync-consumer.ts''s onTerminalFailure '
  'hook, mirroring apps/worker/src/probe/terminal-failure-hook.ts''s '
  'precedent) — counts reflect whatever the checkpoint had recorded at '
  'that point, never fabricated to look complete.';

COMMENT ON COLUMN stash_sync_reports.matched_count IS
  'Scenes matched to a Loombre catalog item (S4, either tier) as of this '
  'run''s completion — a snapshot, not itself a live query.';

COMMENT ON COLUMN stash_sync_reports.updated_count IS
  'Matched scenes whose metadata actually CHANGED and were re-applied '
  'via the injected applyStashSceneMetadata (K11) this run — a matched-'
  'but-unchanged scene (incremental mode''s common case) does not '
  'increment this.';

COMMENT ON COLUMN stash_sync_reports.unmatched_count IS
  'Snapshot of stash_scene_links rows with item_id IS NULL for this '
  'library at run completion (S4 "visible by construction") — the live '
  'list itself is read fresh from stash_scene_links, this count is '
  'just this run''s own historical record of the same fact.';

COMMENT ON COLUMN stash_sync_reports.stale_count IS
  'Snapshot of stash_scene_links rows with stale = TRUE for this '
  'library at run completion (S8: scenes no longer seen in Stash, KEPT '
  'never deleted). A full sync recomputes staleness from scratch; an '
  'incremental sync only marks NEWLY-vanished scenes stale, so this '
  'count can include stale rows from a PRIOR run this one never '
  'revisited.';

COMMENT ON COLUMN stash_sync_reports.skipped_count IS
  'Scenes this run deliberately did not apply (e.g. matched-but-'
  'unchanged in incremental mode, or a scene apply the injected '
  'applyStashSceneMetadata reported as a documented no-op) — H3 '
  '"no-silent-anything": every scene this run looked at lands in exactly '
  'one of matched/updated/unmatched/stale/skipped, never uncounted.';

-- ============================================================================
-- stash_sync_checkpoints
-- ============================================================================

CREATE TABLE stash_sync_checkpoints (
  job_id                        UUID PRIMARY KEY,
  library_id                    UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  phase                         TEXT NOT NULL,
  last_processed_stash_scene_id TEXT NULL,
  scenes_seen                   INT NOT NULL DEFAULT 0,
  scenes_processed              INT NOT NULL DEFAULT 0,
  updated_at_ms                 BIGINT NOT NULL
);

COMMENT ON TABLE stash_sync_checkpoints IS
  'Resumable progress for an in-flight/crashed stash-sync job (deliverable '
  '2: a 33k-scene full sync survives a worker death and resumes without '
  'redoing completed work) — mirrors scan_checkpoints'' same-job-id-on- '
  'retry mechanism exactly (see this migration''s header for why this is '
  'a SEPARATE table rather than a reuse of scan_checkpoints itself). '
  '`phase` is one of ''inventory'' | ''matching'' | ''applying'' | '
  '''completed'' (apps/worker/src/stash/sync-consumer.ts''s own phase '
  'constants — not CHECK-constrained here, matching scan_checkpoints.phase''s '
  'own plain-TEXT precedent, since the checkpoint reader/writer is the '
  'sole owner of this column''s value set).';

COMMENT ON COLUMN stash_sync_checkpoints.last_processed_stash_scene_id IS
  'The last Stash scene id (ordered ASC, same ordering read-model.ts''s '
  'listSceneIds/listScenesForInventory already produce) this run fully '
  'processed through the apply phase — a resumed attempt re-walks from '
  'the beginning of its ordered scene list but SKIPS every scene up to '
  'and including this one, exactly mirroring scanner.ts''s '
  '`maybeCheckpoint`/resume-by-skip algorithm.';

-- ============================================================================
-- indexes (index law: land WITH the tables/queries that need them)
-- ============================================================================

-- getLatestStashSyncReport (packages/db/src/query/stash-sync-reports.ts,
-- K14): "the most recent report row for a library" — library_id-prefixed,
-- started_at_ms DESC so `ORDER BY started_at_ms DESC LIMIT 1` is a pure
-- index scan, never a sort over every historical row for a long-lived
-- library with many past sync runs.
CREATE INDEX stash_sync_reports_library_started_idx
  ON stash_sync_reports (library_id, started_at_ms DESC);

COMMENT ON INDEX stash_sync_reports_library_started_idx IS
  'getLatestStashSyncReport''s working set: library_id-prefixed, '
  'started_at_ms DESC, so the "latest report" read is an index-only '
  'walk instead of a sequential scan + sort over every historical run.';

-- The stash-sync onTerminalFailure hook (apps/worker/src/stash/
-- sync-consumer.ts) finds "the currently-running report row for this
-- library" from just {libraryId} (packages/jobs' onTerminalFailure hook
-- signature carries no jobId — see that file's header) — partial on
-- status = 'running' since that is always a small, transient set (at
-- most one row per library in normal operation, 'stash-sync' registers
-- concurrency:1) against a table that otherwise accumulates one row per
-- historical run.
CREATE INDEX stash_sync_reports_running_idx
  ON stash_sync_reports (library_id)
  WHERE status = 'running';

COMMENT ON INDEX stash_sync_reports_running_idx IS
  'Partial (status = ''running''): the terminal-failure hook''s '
  '"find the in-flight report for this library" lookup — small and '
  'transient by construction (stash-sync runs at queue concurrency:1), '
  'so this index stays tiny regardless of how many historical reports '
  'accumulate.';

-- K14's "live unmatched/stale list queries, keyset where lists can be
-- long" over Lane A''s stash_scene_links (migrations/0018). Composite
-- (library_id, stash_scene_id) partial indexes support the keyset
-- ordering (`WHERE library_id = $1 AND item_id IS NULL AND
-- stash_scene_id > $cursor ORDER BY stash_scene_id LIMIT $n`) as a pure
-- index range scan — 0018's own stash_scene_links_unmatched_idx
-- (library_id only, WHERE item_id IS NULL) already covers the plain
-- library_id filter but would still need a separate sort for the keyset
-- ORDER BY at the owner's 33k-scene scale; these are additive alongside
-- it (0018 is Lane A's migration, not edited here).
CREATE INDEX stash_scene_links_unmatched_keyset_idx
  ON stash_scene_links (library_id, stash_scene_id)
  WHERE item_id IS NULL;

CREATE INDEX stash_scene_links_stale_keyset_idx
  ON stash_scene_links (library_id, stash_scene_id)
  WHERE stale;

COMMENT ON INDEX stash_scene_links_unmatched_keyset_idx IS
  'K14''s live unmatched-scenes keyset list (packages/db/src/query/'
  'stash-sync-reports.ts''s listUnmatchedStashScenes): (library_id, '
  'stash_scene_id) WHERE item_id IS NULL supports the keyset '
  '`stash_scene_id > cursor ORDER BY stash_scene_id` range scan directly '
  '— proven against the 33k-scene synthetic fixture in '
  'packages/db/test/stash-sync-reports.spec.ts.';

COMMENT ON INDEX stash_scene_links_stale_keyset_idx IS
  'K14''s live stale-scenes keyset list (listStaleStashScenes): same '
  'shape as stash_scene_links_unmatched_keyset_idx, scoped to `stale` '
  '(S8) instead of `item_id IS NULL`.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0021_zone_scale_indexes.sql
--
-- STATE.md Stash run (S10, K8-amended: Lane E owns 0021). EVIDENCE-DRIVEN —
-- Lane D measured EXPLAIN (ANALYZE, BUFFERS) against a 33k-scene synthetic
-- restricted library ("Zone Scale 33k": 2000 performers, 150 studios, 40
-- genres, 95% probed files, 70% premiere dates) and wrote up seven findings
-- (reports/stash/explain-findings-0021.md). Lane E re-seeded the SAME
-- fixture shape fresh on its own database (scratchpad/lane-e/seed-zone-33k.mjs,
-- explain-zone.mjs — both Lane D originals, re-run verbatim), then went
-- further and EXPLAIN'd the REAL compiled Kysely SQL the query modules
-- themselves emit (not just the hand-flattened harness), because the
-- harness's `= ANY($n::uuid[])` approximation of restricted-browse.ts's
-- `.where('library_id', 'in', restrictedLibraryIds)` clause turned out to
-- matter a great deal — see finding 1 below.
--
-- Method note for future re-measurement: this migration's numbers were
-- taken with the viewer entitled to TWO restricted libraries (the seed
-- fixture's small "Restricted" library plus "Zone Scale 33k") — i.e.
-- restrictedLibraryIds.length === 2, not 1. This matters (see finding 1);
-- re-measuring with a single-restricted-library viewer will look even
-- better and should not be mistaken for a regression.
--
-- ============================================================================
-- Finding 1 (root cause of the majority of T0 breaches, LANDED): no index
-- lets restricted-browse.ts's default/title sorts stream in order.
-- ============================================================================
--
-- restricted-browse.ts's guard applies TWO independent `library_id`
-- predicates: applyGuard()'s `library_id = ANY(ctx.allowedLibraryIds)`
-- (every library the viewer can see at all) AND this file's own
-- `.where('library_id', 'in', restrictedLibraryIds)` (just the viewer's
-- ENTITLED restricted libraries). migration 0009 already has
-- (library_id, item_type, added_at_ms DESC, id DESC) for the general browse
-- path, and it looks like it should serve this query too — but it doesn't,
-- for a Postgres-specific reason worth recording so nobody "fixes" this by
-- re-adding a library_id-leading composite:
--
--   Postgres's planner will use a btree index to serve `col = ANY(array)`/
--   `col IN (...)`, but it only preserves the index's ORDER on trailing
--   columns when the leading predicate binds to EXACTLY ONE value (proven
--   empirically: `library_id = ANY(ARRAY[oneUuid])` and `library_id IN
--   (oneUuid)` both drive a plain ordered Index (Only) Scan feeding LIMIT
--   directly; `library_id IN (twoUuids)` on the SAME index instead plans a
--   Bitmap/plain Index Scan FOLLOWED BY an explicit Sort node, which forces
--   the two leftJoinLateral subqueries (primary file, primary video stream)
--   to evaluate for every matched row BEFORE the sort discards down to
--   LIMIT 50 — the actual 33,000-times-instead-of-~50-times cost D's
--   finding described). A library_id-LEADING index therefore only pays off
--   when a viewer is entitled to exactly one restricted library; with two
--   (this migration's measured case) it provides zero benefit over what
--   0009 already has.
--
--   The fix: DROP library_id from the index key entirely and rely on the
--   `WHERE item_type = 'movie'` partial predicate (a single, constant
--   equality — never multi-valued) to anchor the scan, leaving
--   `added_at_ms DESC, id DESC` as the only real key columns and
--   `library_id` as a cheap per-row Filter (same shape 0009's own
--   (item_type, sort_title) index already uses successfully for the
--   general catalog's title sort, which is why sort=title was NEVER in
--   D's breach list — proven, not assumed, below).
--
-- Measured (33k synthetic + seed's own small "Restricted" library, this
-- hardware, warm cache — T0 will be slower; two-restricted-library viewer):
--
--   | Path                                  | Before    | After    |
--   |----------------------------------------|-----------|----------|
--   | browse sort=added page 1               | 253-290ms | 11-33ms  |
--   | browse sort=added deep keyset (~pg100)  | 249-253ms | 7-9ms    |
--   | browse resolution=FHD (default sort)    | 212-231ms | 7-11ms   |
--   | browse sort=title                       | 8-13ms    | 8-11ms   |  (never breached — 0009 already sufficient, no new index needed)
--
-- resolution-band filtering (finding 5) is fixed as a direct side effect:
-- it rides the same default added-sort path finding 1 fixes, and needs no
-- index of its own.

CREATE INDEX catalog_items_added_movie_idx
  ON catalog_items (added_at_ms DESC, id DESC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_added_movie_idx IS
  'S10/finding 1: restricted-browse.ts default sort=added (incl. the deep '
  'keyset ROW-comparison seek and resolution-band filtering, which ride '
  'the same path) and restricted-home.ts''s recentlyAddedInZone rail. '
  'Deliberately WITHOUT library_id as a key column — see this migration''s '
  'header for why a library_id-leading composite only helps a viewer '
  'entitled to exactly ONE restricted library (Postgres does not preserve '
  'index order across a multi-value IN()/ANY() leading predicate); '
  'library_id is left as a cheap per-row Filter instead, the same shape '
  '0009''s (item_type, sort_title) index already uses. PARTIAL on '
  'item_type=''movie'' (K1 — a "scene" IS a movie-shaped row): the zone '
  'never browses anything else, and general-catalog browse already has '
  '0009''s own composite. Measured (33k synthetic, two-restricted-library '
  'viewer, this hardware, warm cache): sort=added page 1 253-290ms -> '
  '11-33ms; deep keyset (~page 100) 249-253ms -> 7-9ms; resolution=FHD '
  'filter 212-231ms -> 7-11ms (finding 5, no index of its own needed). '
  'sort=title was measured and found to ALREADY be within budget (8-13ms) '
  'via 0009''s existing (item_type, sort_title) index — no zone-specific '
  'title index was added; D''s original writeup grouped title with added '
  'as a preventive suggestion, re-measurement shows it was never actually '
  'breaching.';

-- ============================================================================
-- Finding 2 (missing-file guard subplans, LANDED as a targeted assist):
-- ============================================================================
--
-- Every guarded read re-checks "does this item have at least one non-
-- missing media_files row" (guard.ts's missingFileClauseSql, two
-- correlated EXISTS/NOT EXISTS subqueries). On restricted-browse.ts's own
-- LIMIT-50 page this is negligible (finding 1's fix already bounds it to
-- ~50 probes). It is NOT negligible on the two aggregate rails
-- (restricted-home.ts's getTopStudiosInZone/getTopPerformersInZone,
-- finding 7) and the pre-reshape performer list (finding 6): those visit
-- every item behind every zone credit/tag edge (~33,000 items) to compute
-- a count, so the SAME two subqueries run ~33,000 times each. Confirmed by
-- EXPLAIN they were ALREADY using media_files_item_id_idx in correlated
-- (per-row Index Scan) form rather than a flat hash-scan (i.e. finding 2's
-- "did it flip?" condition was already true) — but 33,000 index probes on
-- a NON-partial index still cost real buffer traffic. The partial index
-- below (matching exactly what finding 2 pre-authorized) turns the
-- `missing_since_ms IS NULL` half into an Index-Only-Scan with no
-- per-row heap fetch or Filter recheck.
--
-- Measured effect on getRestrictedZoneHome (dominated by the two count-DESC
-- rails, finding 7): 165-245ms -> 146-192ms — a real but PARTIAL
-- improvement; the aggregate floor itself (finding 7, below) remains.

CREATE INDEX media_files_not_missing_item_id_idx
  ON media_files (item_id)
  WHERE missing_since_ms IS NULL;

COMMENT ON INDEX media_files_not_missing_item_id_idx IS
  'S10/finding 2: the "has a non-missing file" half of guard.ts''s '
  'missingFileClauseSql, isolated as its own partial index so the '
  'aggregate zone rails (restricted-home.ts''s top-studios/top-performers, '
  'restricted-performers.ts pre-reshape) don''t pay a Filter/heap-fetch '
  'per probe on top of the correlated index lookup they already do. '
  'Confirmed via EXPLAIN this does NOT fully close the aggregate rails'' '
  'breach (finding 7 — an inherent count-DESC floor); it is a real, '
  'measured assist (getRestrictedZoneHome 165-245ms -> 146-192ms), landed '
  'because finding 2 explicitly pre-authorized it for exactly this '
  '"didn''t fully flip to a cheap correlated form" case.';

-- ============================================================================
-- Findings 3/4/5: judged on re-measured numbers, NOT landed here.
-- ============================================================================
--
-- sort=rating (COALESCE(catalog_items.community_rating, sentinel)) and
-- sort=date (COALESCE(movie_details.premiere_at_ms, sentinel), a satellite-
-- table column reached via LEFT JOIN) both STILL BREACH after finding 1
-- lands (re-measured: sort=date 210-269ms, sort=rating 209-238ms — finding
-- 1's lateral-materialization fix does not apply to them, because their
-- ORDER BY key isn''t on catalog_items_added_movie_idx; each sort needs its
-- OWN ordering-capable index). rating COULD be expression-indexed
-- (COALESCE lives on catalog_items itself, same table as the finding-1
-- fix); date cannot be, cleanly, at all (the COALESCE spans a LEFT JOINed
-- satellite table). Migration 0009''s own header already declined this
-- exact category of fix for the GENERAL catalog''s rating/year sorts
-- ("would need four expression indexes or a query redesign — logged as
-- Open in STATE.md, not silently skipped") for the same sentinel-direction
-- reason (order=asc and order=desc need DIFFERENT sentinel values, so one
-- index does not cover both directions). This migration follows that same,
-- already-established house convention rather than inventing an
-- asymmetric one-off for the zone: NOT landed, logged OPEN in Lane E''s
-- report for owner sign-off alongside 0009''s pre-existing gap.
--
-- sort=duration (finding 4) is a per-item LATERAL-computed key (the
-- "primary file" resolution rule has no column to index) and stays a
-- confirmed breach after finding 1 (211-263ms, unchanged — finding 1 never
-- touched this path). The only real fix is denormalizing a
-- catalog_items.primary_duration_ms column, which is a WRITER change
-- (scanner probe path + apply.ts) outside this additive-migration lane''s
-- scope and explicitly flagged in STATE.md as owner-sign-off territory.
-- NOT implemented; logged OPEN.

-- ============================================================================
-- Finding 6 (performers list GroupAggregate, FIXED via query reshape, no
-- new index): restricted-performers.ts now keyset-pages `people` directly
-- on (name, id) with an EXISTS check (index-backed via the pre-existing
-- item_people_person_id_idx/people_name_idx — no migration needed) and
-- batches the scene-count for only the <=limit people a page returns,
-- instead of a GroupAggregate over every role=''performer'' credit row.
-- Measured: listRestrictedPerformers 149-163ms -> 7-13ms. See
-- packages/db/src/query/restricted-performers.ts''s header for the full
-- design note; existing leak.spec.ts cases (12c) prove the reshape did not
-- change visibility semantics.
-- ============================================================================

-- ============================================================================
-- Finding 7 (home rails' top-N-by-count aggregates): accepted, NOT
-- index-fixable, assisted by finding 2's index above but still breaching.
-- ============================================================================
--
-- restricted-home.ts's getTopStudiosInZone/getTopPerformersInZone order by
-- COUNT(...) DESC — unlike finding 6's alphabetical list, there is no
-- cheaper dimension to keyset-page on: the top-N-by-count is not knowable
-- until every matching edge has been counted (an inherent GroupAggregate
-- floor; confirmed by EXPLAIN — no plan exists that answers "which 10
-- studios have the most scenes" without visiting every studio/scene edge).
-- getRestrictedZoneHome remains a residual T0 breach after finding 2's
-- assist (146-192ms, budget 100ms). Per D''s own writeup this is a real,
-- accepted tradeoff, not a gap: the rail is fetched once per zone-home
-- visit (not per scroll/page), and the only further lever is a
-- clearance-digest-keyed cache with a short TTL (the same cache-key
-- primitive src/query/clearance.ts already exists for) — an architecture
-- change beyond an additive-index migration''s scope. Logged OPEN in Lane
-- E''s report for owner sign-off, exactly as D''s finding anticipated.

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0022_stash_sync_report_snapshot
--
-- Additive-only (mirrors 0002/.../0021's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- FX4 fix wave (STATE.md FIX WAVE queue, 2026-08-01 docs-lane gap audit):
-- S2's snapshot-copy fallback (apps/worker/src/stash/adapter.ts's
-- StashConnection.readingFrom === 'snapshot' — the WAL-locked-past-retry-
-- budget path) is a real, observed fact about how a sync run read the
-- Stash database, but nothing durable ever recorded it: not the
-- stash.sync.completed event (additive optional field, same migration
-- session, packages/contract/event-schemas/stash.sync.completed.schema.json)
-- and not the admin-visible sync-report artifact. This migration adds the
-- durable half.
--
-- Nullable BOOLEAN, not NOT NULL DEFAULT false: `false` would be a
-- fabricated claim of "read from source" for every report row that
-- existed before this column did, and for a run finalized by
-- createStashSyncTerminalFailureHook (apps/worker/src/stash/
-- sync-consumer.ts), which never obtains a connection for the failed
-- attempt and genuinely does not know the answer (H3 "no-silent-anything"
-- — an unknown fact stays NULL, never a guessed default).

ALTER TABLE stash_sync_reports
  ADD COLUMN used_snapshot_fallback BOOLEAN NULL;

COMMENT ON COLUMN stash_sync_reports.used_snapshot_fallback IS
  'FX4 fix wave (S2): whether this run''s Stash connection had to fall '
  'back to a snapshot copy (apps/worker/src/stash/adapter.ts''s '
  'readingFrom = ''snapshot'', the WAL-locked-past-retry-budget path) '
  'rather than reading the source database file directly. Written once, '
  'at finalization (packages/db/src/query/stash-sync-reports.ts''s '
  'finishStashSyncReport), from the SAME connectToStashLibrary call the '
  'sync itself used. NULL means unknown — a report finalized by the '
  'onTerminalFailure hook (no access to the failed attempt''s '
  'connection) or a row written before this column existed — never a '
  'false claim of ''read from source''.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0023_user_invites
--
-- Additive-only (mirrors 0002/.../0022's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations. One exception that is
-- still additive in spirit — DROP NOT NULL below is a LOOSENING, never a
-- narrowing (M1).
--
-- "Optional mail transport + invitation & reset flows that work without
-- it" (STATE.md, kicked off 2026-08-01), Lane A: E2 (invitations) + E4/M1/M2
-- (optional email + real display_name storage). Pre-assigned this migration
-- number (M5, to avoid parallel-lane collisions with Lane B's 0024).
--
-- ============================================================================
-- users.email loosens to optional (M1)
-- ============================================================================
--
-- Reality check at kickoff: users.email was CITEXT NOT NULL UNIQUE
-- (0001_init.sql) and a live login identifier (getUserByEmail). E4's
-- "optional email" therefore reads onto this table as a LOOSENING, not a
-- new column: DROP NOT NULL only. CITEXT + UNIQUE are UNCHANGED — Postgres
-- treats NULLs as mutually distinct under a UNIQUE constraint (no
-- NULLS NOT DISTINCT clause here, deliberately), so any number of
-- email-less users may coexist without a conflict. Every insert/read path
-- that touches users.email is updated in this Lane A wave to treat the
-- column as nullable: createUserAdmin/createUserAdminAndEmit,
-- createFirstAdminIfEmpty/insertUserAndEmit (unchanged — FirstAdminRequest
-- keeps requiring email; first-boot bootstrap is out of scope for the
-- loosening), getUserByEmail (a `column = $literal` comparison already
-- never matches a NULL row — verified, no code change needed there, see
-- packages/db/src/query/identity.ts's getUserByEmail doc comment), login
-- (already resolves by username OR email; an email-less user simply always
-- authenticates by username — no code change needed), the data-freedom
-- export/import round trip, and the users seed data.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN users.email IS
  'Optional login identifier (E4/M1: an additive LOOSENING of the original '
  'CITEXT NOT NULL UNIQUE column, not a new one — CITEXT + UNIQUE are '
  'unchanged). NULL = no email on file; Postgres treats NULLs as mutually '
  'distinct under the UNIQUE constraint, so any number of email-less users '
  'may coexist. A user with no email logs in by username only.';

-- ============================================================================
-- users.display_name — a real column at last (M2, the H1 bug class)
-- ============================================================================
--
-- packages/contract/openapi.yaml's User.displayName has been declared since
-- before this migration, and the web profile form / AddUserSheet have
-- always SUBMITTED it — but no column existed to persist it, so the value
-- was silently discarded while the UI reported "Saved" (the H1 bug class,
-- STATE.md). packages/db/src/query/admin.ts's module header documented
-- this gap explicitly; this migration closes it.

ALTER TABLE users ADD COLUMN display_name TEXT NULL;

COMMENT ON COLUMN users.display_name IS
  'Free-form display name (M2), settable by the user (PATCH /users/me) or '
  'an admin (PATCH /users/{id}) and preset-able at invite creation '
  '(user_invites.display_name_preset below). NULL = unset; callers fall '
  'back to username for display.';

-- ============================================================================
-- user_invites (E2, M3 token posture, M4 no-role-no-restricted-grant)
-- ============================================================================

CREATE TABLE user_invites (
  id                   UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  token_hash           TEXT NOT NULL UNIQUE,
  created_by           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_ms        BIGINT NOT NULL,
  expires_at_ms        BIGINT NOT NULL,
  username_preset      CITEXT NULL,
  display_name_preset  TEXT NULL,
  email                CITEXT NULL,
  claimed_at_ms        BIGINT NULL,
  claimed_user_id      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at_ms        BIGINT NULL
);

COMMENT ON TABLE user_invites IS
  'E2: a one-time, expiring invite link an admin creates to provision a new '
  'user through a self-serve claim flow. `status` (pending/claimed/revoked/'
  'expired) is DERIVED at read time from claimed_at_ms/revoked_at_ms/'
  'expires_at_ms, never stored — see packages/db/src/query/invites.ts. No '
  'role/admin field exists anywhere on this table (M4): escalation via an '
  'intercepted invite link is impossible by construction, not by '
  'validation — grants are library_permissions rows only, via '
  'user_invite_grants below, and restricted-class libraries are rejected '
  'both at invite creation and re-checked at claim time (defense in '
  'depth).';

COMMENT ON COLUMN user_invites.token_hash IS
  'SHA-256 hex of the raw invite token (M3: the refresh-token posture '
  'EXACTLY — packages/db/src/query/identity.ts''s refresh_tokens.token_hash '
  'is the template, DB-equality lookup, no argon2id on an unauthenticated '
  'route). The raw token is returned exactly once, in POST /invites''s own '
  'response, and is never stored anywhere in plaintext.';

COMMENT ON COLUMN user_invites.created_by IS
  'The admin who created this invite (ON DELETE CASCADE, matching the '
  'house convention for every other NOT NULL users(id) FK — refresh_tokens.'
  'user_id, devices.user_id, library_permissions.user_id — rather than the '
  'nullable audit-actor convention events.actor_user_id/server_settings.'
  'updated_by use, since this column is NOT NULL by design, M5 brief).';

COMMENT ON COLUMN user_invites.username_preset IS
  'Admin-set username suggestion. When present it is AUTHORITATIVE at '
  'claim time (preset wins over anything the claiming client submits) — '
  'see claimInviteAndEmit''s username-resolution order.';

COMMENT ON COLUMN user_invites.email IS
  'Send-to address AND claim-time email preset (E2 body.email). The '
  'claiming client''s own submitted email, when present, wins over this '
  'preset (defaults-to-invite-email semantics, distinct from '
  'username_preset''s preset-always-wins rule) — see the claim endpoint.';

COMMENT ON COLUMN user_invites.claimed_user_id IS
  'The user row this invite produced, once claimed. ON DELETE SET NULL '
  '(not CASCADE): deleting the claimed user later must not erase the fact '
  'that this invite WAS claimed (claimed_at_ms stays set) — only the '
  'specific-user link is severed, mirroring events.actor_user_id''s own '
  'ON DELETE SET NULL rationale for the same reason.';

COMMENT ON COLUMN user_invites.revoked_at_ms IS
  'Admin-initiated revocation timestamp (DELETE /invites/{id}). Revoking '
  'an already-claimed or already-revoked invite is rejected (404, see the '
  'revokeInvite endpoint) rather than silently no-opping — revoking a '
  'claimed invite has no invite-side effect (the user already exists), so '
  'the 404 signals "nothing left to revoke" honestly.';

-- ============================================================================
-- user_invite_grants (real FKs, no JSONB — CLAUDE.md invariant 3)
-- ============================================================================

CREATE TABLE user_invite_grants (
  invite_id  UUID NOT NULL REFERENCES user_invites(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (invite_id, library_id)
);

COMMENT ON TABLE user_invite_grants IS
  'The library_permissions rows a successful claim will create (M4: '
  'general-class libraries only — rejected at invite creation for any '
  'restricted-class library id, and RE-CHECKED at claim time in case a '
  'library''s content_class changed after the invite was created).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0024_password_recovery
--
-- Additive-only (mirrors 0002/.../0023's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Optional mail transport + invitation & reset flows" (E3/M5/M14/
-- M15), Lane B. Two tiers of password recovery:
--
--   (a) admin/CLI-driven (E3a, M14): `users.must_change_password` — set
--       whenever an admin (HTTP `POST /users/{id}/reset-password`) or the
--       server-local `loombre admin reset-password <username>` CLI (H2
--       pattern) issues a temporary password; cleared the moment the user
--       sets a real one (PATCH /users/me, same transaction as the
--       password write — apps/server/src/catalog/users.controller.ts).
--       Enforced server-side (not advisory) by a guard extending
--       apps/server/src/gateway/auth.guard.ts's chain: a flagged user's
--       Bearer token authorizes only auth login/refresh/logout,
--       GET /users/me, and PATCH /users/me until the flag clears.
--
--   (b) self-service, email tier (E3b/M15): `password_reset_tokens` —
--       mirrors invite tokens' posture (M3: same "hashed opaque token,
--       looked up by DB equality on the hash" shape as refresh_tokens, NOT
--       argon2id — no CPU-heavy hashing on the unauthenticated
--       `POST /auth/forgot-password` / `POST /auth/reset-password` routes,
--       DoS posture). `token_hash` is `sha256(randomBytes(32))` hex,
--       computed server-side (apps/server/src/session/reset-token.ts);
--       single-use enforced by the atomic
--       `UPDATE ... WHERE used_at_ms IS NULL AND expires_at_ms > $now`
--       pattern used-tokens/invites both share. `used_at_ms` doubles as
--       "invalidated" when a fresh token is issued for the same user (a
--       previous unused row is marked used at issuance time, not deleted —
--       H3 no-silent-anything, the row stays visible/auditable) — there is
--       deliberately no separate "revoked_at_ms" column, since "used" and
--       "superseded-by-a-newer-request" both mean exactly one thing to the
--       consume query: this row can never satisfy the WHERE clause again.

ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.must_change_password IS
  'Set by an admin/CLI-issued temporary-password reset (E3a/M14); cleared '
  'in the same transaction as the next successful PATCH /users/me '
  'password change. Enforced server-side by apps/server/src/gateway/'
  'auth.guard.ts''s guard chain — a flagged user''s Bearer token '
  'authorizes only auth login/refresh/logout, GET /users/me, and '
  'PATCH /users/me until this clears.';

CREATE TABLE password_reset_tokens (
  id            UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  used_at_ms    BIGINT NULL
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

COMMENT ON TABLE password_reset_tokens IS
  'Self-service password-reset tokens (E3b/M15) — POST /auth/forgot-password '
  'mints (identifier resolves to a real account with an email on file, mail '
  'tier active) and invalidates the user''s prior unused rows in the same '
  'transaction; POST /auth/reset-password atomically consumes '
  '(token_hash match, used_at_ms IS NULL, expires_at_ms > now) in one '
  'UPDATE, so a race between two concurrent consumes yields exactly one '
  'winner. 30-minute expiry (M15). token_hash is sha256(base64url random '
  '32 bytes) hex, never the plaintext token — same posture as '
  'refresh_tokens.token_hash (M3).';

COMMENT ON COLUMN password_reset_tokens.used_at_ms IS
  'Set either when this token is actually consumed by '
  'POST /auth/reset-password, OR when a newer token is issued for the same '
  'user before this one was ever used (invalidation-by-supersession) — '
  'both cases mean the same thing to the atomic consume query: this row '
  'can never succeed the WHERE clause again. NULL = still live.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0025_email_collision_notice_ledger
--
-- Additive-only (mirrors 0002/.../0024's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Current-password re-auth on self-changes + the email-collision
-- signal" (F5/G7): the per-address 24h rate-limit window for the
-- email-in-use security notice (claimInviteAndEmit / updateUserSelf both
-- silently drop a colliding email — E8, actor-visible behavior unchanged —
-- and this ledger is what stops that silent drop from also becoming a
-- harassment vector: "the signal must not become a harassment vector...
-- max 1 notice per address per 24h", F5).
--
-- A DB table, not an in-memory KeyedRateLimiter, for two reasons
-- (G7-recorded): (1) the in-memory limiter is per-process/restart-reset —
-- unsuitable for a 24h window that must survive a routine server restart;
-- (2) @loombre/jobs exposes no pg-boss singleton/dedup surface this could
-- otherwise ride on. One row per address ever notified; `last_notice_at_ms`
-- is overwritten (never a growing history) on every successful window
-- claim — a bounded table, not an append-only log.
--
-- CITEXT (matches users.email's own case-insensitive-unique posture,
-- 0001_init.sql) — "example@x.com" and "Example@X.com" must claim the SAME
-- window, since they are the SAME address users.email itself would already
-- treat as one row.

CREATE TABLE email_collision_notice_ledger (
  email              CITEXT PRIMARY KEY,
  last_notice_at_ms  BIGINT NOT NULL
);

COMMENT ON TABLE email_collision_notice_ledger IS
  'G7: per-address 24h rate-limit window for the email-in-use security '
  'notice (F5). One row per address ever notified; last_notice_at_ms is '
  'overwritten on every successful window claim via the atomic '
  'INSERT ... ON CONFLICT ... WHERE ... RETURNING claim (packages/db/src/'
  'query/email-collision-notice.ts) — never read/written any other way, so '
  'this table carries no FK to users(id) (an address here need not belong '
  'to any account by the time it is read back, and the claim is keyed on '
  'the address itself, not a user id).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0026_password_changed_epoch
--
-- Additive-only (mirrors 0002/.../0025's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- R-F7 (opus adversarial review, fix wave — STATE.md "Current-password
-- re-auth on self-changes + the email-collision signal"): F3's self-
-- service password change revokes every OTHER device's REFRESH token, but
-- access tokens are self-contained JWTs — a revoked device's access token
-- kept full API access for up to ACCESS_TOKEN_TTL_MS (15 minutes) after
-- the change, which made the web copy "Other devices have been signed
-- out." false for that whole window. This column is the credentials-
-- changed epoch that closes it: apps/server/src/gateway/auth.guard.ts's
-- verifyAndAttach rejects an access token whose `iat` claim is strictly
-- before this value, so a revoked device's still-unexpired access token
-- actually loses access instead of merely losing its refresh token.
--
-- NULL = password never changed since this column existed (every
-- pre-migration row) — no epoch to enforce, every still-valid access
-- token passes. Set to the change's own `nowMs` in EVERY path that
-- changes a password: packages/db/src/query/admin.ts's updateUserSelf
-- (self-service, PATCH /users/me), src/query/identity.ts's
-- resetUserPasswordAndEmit (admin/CLI temporary-password reset), and
-- src/query/password-reset.ts's resetPasswordViaTokenAndEmit (self-service
-- email-tier token reset) — the same three call sites that already set
-- `password_hash` on a password change, so no fourth path can miss it.

ALTER TABLE users
  ADD COLUMN password_changed_at_ms BIGINT NULL;

COMMENT ON COLUMN users.password_changed_at_ms IS
  'R-F7: credentials-changed epoch. NULL = password never changed since '
  'this column existed. apps/server/src/gateway/auth.guard.ts rejects an '
  'access token whose iat claim is strictly before this value — the fix '
  'for a revoked device''s access token otherwise keeping full API access '
  'until its own 15-minute expiry, independent of any refresh-token '
  'revocation. Set in the same statement as password_hash by every '
  'password-change path (self-service, admin/CLI reset, token-based '
  'self-service reset).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0027_stash_blobs_path
--
-- Additive-only. Filesystem blob-store support for Stash cover/portrait/logo
-- ingest (owner-approved enhancement, 2026-08-04).
--
-- Stash has two "Blobs Storage" modes: Database (bytes in blobs.blob — read
-- straight from the SQLite file) or Filesystem (blobs.blob is NULL and the
-- bytes live in a checksum-sharded directory tree, root/<c0:2>/<c2:4>/
-- <checksum>). The owner's real 43k-scene library uses Filesystem mode — all
-- 53,394 of its blob rows carry a NULL blob column — so art cannot be read
-- from the DB copy alone. This column records the on-disk blob directory so
-- apps/worker/src/stash/blob-store.ts can resolve those bytes.
--
-- NULL (the default, and every pre-existing row) = DB-only behavior, exactly
-- as before: art comes only from blobs.blob, and a Filesystem-mode Stash
-- simply syncs no covers. A non-NULL path opts into the filesystem fallback.
-- The path is as seen from the WORKER process (same trust/mount posture as
-- sqlite_path — the server never opens it, K10); no existence CHECK here,
-- because the mount may be absent at config-write time and a missing blob is
-- a non-fatal per-item shortfall, not a config error.

ALTER TABLE library_stash_connections ADD COLUMN stash_blobs_path TEXT NULL;

COMMENT ON COLUMN library_stash_connections.stash_blobs_path IS
  'Filesystem path to Stash''s on-disk blob store, when Stash uses '
  'Filesystem (not Database) blob storage. NULL = DB-only art (blobs.blob); '
  'a non-NULL path lets apps/worker/src/stash/blob-store.ts resolve '
  'cover/portrait/logo bytes from root/<checksum[0:2]>/<checksum[2:4]>/'
  '<checksum> (Stash''s own sharding, pkg/sqlite/blob/fs.go). Worker-side '
  'path (the server never opens it, K10); unvalidated at write time — a '
  'missing blob is a non-fatal per-item shortfall, surfaced in sync counts.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0028_system_notices
--
-- Additive-only (mirrors 0001/.../0027's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Admin broadcast notifications: restart warnings, maintenance, custom
-- notices" (STATE.md, kicked off 2026-08-04), Lane A (server side). N1
-- (locked decision): a single additive `system_notices` table — ONE active
-- notice at a time in v1, composing a new one REPLACES the active one
-- (packages/db/src/query/notices.ts's publishNoticeAndEmit does the
-- cancel-then-insert in one transaction; no stacking, no queue). NG4/NG8
-- (orchestrator recon adjudications) resolve this migration's one
-- ambiguity and its audit posture — both cited inline below.

-- ============================================================================
-- notice_severity — real PG enum (house style: item_type/content_class/
-- watch_state/stash_sync_report_status/... all use CREATE TYPE for a closed
-- SCALAR value set; migrations/0011_hw_capability_snapshots.sql's TEXT[]
-- CHECK columns are the documented exception for ARRAY-typed columns only,
-- which does not apply here).
-- ============================================================================

CREATE TYPE notice_severity AS ENUM ('info', 'warning', 'critical');

-- ============================================================================
-- system_notices
-- ============================================================================

CREATE TABLE system_notices (
  id               UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  message          TEXT NOT NULL CHECK (char_length(message) <= 500),
  severity         notice_severity NOT NULL,
  effective_at_ms  BIGINT NULL,
  expires_at_ms    BIGINT NULL,
  created_by       UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms    BIGINT NOT NULL,
  cancelled_at_ms  BIGINT NULL,
  -- NG4: NULL expires_at_ms means "until cancelled", legal ONLY for
  -- 'critical' (N1's "critical until cancelled" — a far-future sentinel
  -- would be dishonest data). info/warning always carry a real
  -- expires_at_ms — info defaults to now+1h and warning REQUIRES a
  -- composer-set expiry (422 when absent), both enforced by the
  -- apps/server controller, not this CHECK; this CHECK only forbids the
  -- ONE combination that can never be correct at the storage layer.
  CHECK (severity = 'critical' OR expires_at_ms IS NOT NULL)
);

COMMENT ON TABLE system_notices IS
  'N1: an admin-broadcast notice shown to every user (info/warning/'
  'critical). ACTIVE is DERIVED, never stored (the same derive-dont-store '
  'rule packages/db/src/query/invites.ts establishes for invite status): '
  '`cancelled_at_ms IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > '
  'now)` -- see packages/db/src/query/notices.ts getActiveNotice/'
  'listNoticesAdmin. Only ONE notice is active at a time in v1: publishing '
  'a new one cancels whichever row is currently active in the SAME '
  'transaction as the insert (publishNoticeAndEmit) -- a notice channel '
  'that stacks becomes noise (N1). Audit IS the broadcast (NG8): publish/'
  'cancel each emit exactly one all-user outbox event (notice.published / '
  'notice.cancelled, packages/contract/event-schemas/) carrying the '
  'acting admin as the envelope actorUserId -- there is no separate '
  'admin-only audit event, and REPLACING the active notice emits ONLY '
  'notice.published for the new row, never a notice.cancelled for the '
  'superseded one (clients hold one notice and replace by design; a '
  'client that misses the supersession reconciles via GET /notices/'
  'active). History reads this table directly, not the events outbox.';

COMMENT ON COLUMN system_notices.message IS
  'Plain text only, no markup in v1 (N1) -- capped at 500 chars by the '
  'CHECK above AND by the contract maxLength:500 (defense in depth); '
  'clients render it as plain text nodes only, never HTML (N6/NG10).';

COMMENT ON COLUMN system_notices.effective_at_ms IS
  'The countdown target ("restarting AT this time"), NULL when the '
  'notice carries no scheduled moment. Set from the publish request '
  'RELATIVE effectiveInMs, anchored to the SERVER own clock at publish '
  'time (NG5: "durations in, absolutes out" -- compose-time clock skew '
  'is impossible by construction). The notice system never itself '
  'restarts anything -- this is communication only (N4).';

COMMENT ON COLUMN system_notices.expires_at_ms IS
  'When this notice stops being active, absolute ms. NULL = "until '
  'cancelled", legal ONLY for severity=''critical'' -- see this table CHECK '
  'and NG4. Derived from the publish request RELATIVE expiresInMs the '
  'same way effective_at_ms is (NG5); severity-specific defaults (info '
  'absent -> now+3_600_000; warning absent -> 422) are applied by the '
  'apps/server controller before the insert, not by this column.';

COMMENT ON COLUMN system_notices.created_by IS
  'The admin who published this notice. ON DELETE SET NULL (audit-actor '
  'column pattern -- events.actor_user_id/server_settings.updated_by '
  'precedent, NOT user_invites.created_by ON DELETE CASCADE): deleting '
  'an admin later must not erase notice history, only sever the '
  'specific-user link (NG8). NOT NULL is enforced by the query layer at '
  'insert time (packages/db/src/query/notices.ts publishNoticeAndEmit), '
  'not by a SQL constraint here -- matching server_settings.updated_by '
  'own nullable-column-but-app-enforced-not-null posture for the '
  'identical audit-actor reason.';

COMMENT ON COLUMN system_notices.cancelled_at_ms IS
  'Set by an explicit admin cancel (POST /system/notices/{id}/cancel) '
  'OR implicitly by a later publish superseding this row (both go '
  'through packages/db/src/query/notices.ts). NULL = never cancelled; '
  'combined with expires_at_ms this is the ACTIVE predicate this '
  'table own COMMENT documents.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0029_remote_wireguard_state
--
-- Additive-only (mirrors 0001/.../0028's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Loombre Remote — embedded WireGuard + three-path wizard + reachability
-- proof + posture card" (STATE.md, kicked off 2026-08-04), lane WG1.
-- DRIFT DECISION #2 (orchestrator, logged at the exit gate): renumbered
-- ahead of WG2's device_kind/wg_peers migration (now 0030) because WG1
-- needs persistent state before any peer bookkeeping exists. Scope is
-- deliberately minimal, per the drift decision's own wording: "server
-- public key, enabled, enabled-at; private key keyring-only" — nothing
-- else. listen_port/subnet/endpointHost are NOT duplicated here: they are
-- already the `remote.*` settings-registry keys (Wave-0 freeze,
-- packages/shared/src/settings-registry.ts), and duplicating an
-- effective-settings value into a state table is exactly the kind of drift
-- the settings registry already exists to prevent.

-- ============================================================================
-- remote_wireguard_state — single-row table (house pattern: a BOOLEAN
-- primary key CHECK'd to TRUE is the standard PostgreSQL idiom for "at
-- most one row can ever exist", enforced by the primary key's own
-- uniqueness rather than application discipline alone). No row exists
-- until the first enable (packages/db/src/query/remote-wireguard.ts
-- upserts it) — "no row" and "row with enabled=false" are both legal
-- readings of "not enabled"; the query layer's getRemoteWireguardState
-- treats an absent row as the all-false default rather than requiring a
-- migration-time seed (no other migration in this repo seeds data, see
-- this table's own COMMENT for the full reasoning).
-- ============================================================================

CREATE TABLE remote_wireguard_state (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  server_public_key  TEXT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at_ms      BIGINT NULL,
  updated_at_ms      BIGINT NOT NULL
);

COMMENT ON TABLE remote_wireguard_state IS
  'WG1 (STATE.md "Loombre Remote", R1/R2/R9): single-row admin state for '
  'the embedded userspace WireGuard subsystem. The PRIVATE key lives ONLY '
  'in the keyring (packages/secrets storeSecret, {value,setAtMs} envelope '
  'precedent) -- this table NEVER carries a private key, by construction '
  '(R9 no-secrets rule extends past event payloads to storage here too). '
  'id is a singleton-enforcing BOOLEAN PK (CHECK(id) forbids id=false '
  'rows, PK uniqueness forbids a second id=true row) -- the standard '
  'Postgres idiom for a table that must never hold more than one row. No '
  'row exists until RemoteWireguardService.enable() first upserts one; '
  'getRemoteWireguardState treats a missing row as the all-disabled '
  'default (packages/db/src/query/remote-wireguard.ts), so this table is '
  'never migration-seeded.';

COMMENT ON COLUMN remote_wireguard_state.server_public_key IS
  'Standard WireGuard base64 public key (44 chars) -- generated fresh on '
  'every enable() (a new server keypair each time Remote is turned on, '
  'never reused across disable/enable cycles). NULL only before the first '
  'ever enable.';

COMMENT ON COLUMN remote_wireguard_state.enabled IS
  'Mirrors RemoteWireguardStatus.enabled (packages/contract/openapi.yaml): '
  '"a server keypair exists and enrollment is possible" -- distinct from '
  'whether the in-process listener is ACTUALLY live right now (that is '
  'runtime-only fact from packages/wg-native WgStatus, never persisted, '
  'since a process restart always starts the listener fresh from this '
  'row on boot-resume).';

COMMENT ON COLUMN remote_wireguard_state.enabled_at_ms IS
  'Set on every successful enable(), untouched by disable() (an audit '
  'fact: "when was this last turned on", not "is it on now" -- that is '
  'the enabled column). NULL only before the first ever enable.';

COMMENT ON COLUMN remote_wireguard_state.updated_at_ms IS
  'Bumped on every enable()/disable() -- the generic last-write timestamp '
  '(server_settings.updated_by-adjacent pattern), independent of '
  'enabled_at_ms which specifically means "last enabled".';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0030_wg_peers
--
-- Additive-only (mirrors 0001/.../0029's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
-- reachability proof + posture card" (R2/R9/RG3/RG9, lane WG2). Reserved
-- as 0030 by DRIFT DECISION #2 (orchestrator freeze) once WG1 took 0029 for
-- its own persisted state ahead of this lane's device_kind/wg_peers work.
--
-- Two pieces:
--   1. `device_kind` — real PG enum (house style: notice_severity/
--      remote_probe_path/item_type/... all use CREATE TYPE for a closed
--      SCALAR value set) + `devices.kind`, additive NOT NULL DEFAULT 'app'
--      column (RG3: every pre-existing device row is unambiguously an
--      'app' device — nothing in this codebase has ever enrolled a
--      WireGuard peer before this migration exists).
--   2. `wg_peers` — one row per enrolled Remote (WireGuard) device, R2's
--      "device gets a stable tunnel IP from a private /24" + R9's
--      "enrollment configs never persisted server-side post-delivery".
--      `device_id` IS the primary key (not a separate surrogate id): the
--      relationship is exactly 1:1 with `devices` (kind='remote'), so
--      making the FK itself the PK is the simplest correct way to express
--      "device_id FK unique" — the same singleton-shaped-relationship
--      instinct remote_wireguard_state's boolean-PK trick applies, just
--      via a real foreign key here instead of a CHECK'd boolean.
--      ON DELETE CASCADE: deleting the owning devices row (either
--      self-service DELETE /devices/{id} or the admin-scoped DELETE
--      /admin/remote/wireguard/devices/{id}, packages/db/src/query/
--      wg-peers.ts revokeRemoteWireguardDeviceAndEmit) atomically removes
--      this row too — there is no code path that deletes a wg_peers row
--      without also deleting its device, or vice versa.
--
-- R9, stated as plainly as the table itself can state it: THERE IS NO
-- PRIVATE-KEY COLUMN HERE, OR ANYWHERE ELSE IN THIS SCHEMA, FOR A PEER'S
-- OWN KEY. The peer keypair is generated server-side at enrollment
-- (packages/wg-native's generateWgKeyPair, apps/server/src/remote/
-- wireguard/remote-wireguard.controller.ts), the private half is embedded
-- ONCE into the one-time RemoteWireguardEnrollment API response's
-- configText, and is then gone — never written to this table, never
-- logged, never cached anywhere server-side. Only the PUBLIC key is
-- persisted (needed to re-add every enrolled peer to the live wg-native
-- instance on every boot-resume, remote-wireguard.service.ts's loadPeers).
--
-- last-handshake is deliberately NOT a column here (STATE.md's own mission
-- text: "last-handshake stays runtime-only from WgStatus") — it only ever
-- exists as a live fact inside the running wg-native instance's peer list
-- (packages/wg-native WgStatus.peers[].lastHandshakeMs), surfaced by
-- joining that runtime read against this table's rows
-- (listRemoteWireguardDevices), never stored here.

-- ============================================================================
-- device_kind
-- ============================================================================

CREATE TYPE device_kind AS ENUM ('app', 'remote');

ALTER TABLE devices
  ADD COLUMN kind device_kind NOT NULL DEFAULT 'app';

COMMENT ON COLUMN devices.kind IS
  'RG3: ''app'' (default — every device row created via the login-driven '
  'createDevice path, P1.14) or ''remote'' (created ONLY by the admin-'
  'initiated enrollRemoteWireguardDevice flow, packages/db/src/query/'
  'wg-peers.ts, never by login). A ''remote'' device always has exactly '
  'one corresponding wg_peers row (device_id is that table''s own primary '
  'key) — this column is the human/API-facing label; the wg_peers row''s '
  'mere existence is what every WireGuard-specific query actually joins '
  'on.';

-- ============================================================================
-- wg_peers — one row per enrolled Remote (WireGuard) device (R2/R9/RG9)
-- ============================================================================

CREATE TABLE wg_peers (
  device_id      UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL UNIQUE,
  tunnel_ip      TEXT NOT NULL UNIQUE,
  created_at_ms  BIGINT NOT NULL
);

COMMENT ON TABLE wg_peers IS
  'WG2 (STATE.md "Loombre Remote", R2/R9/RG3/RG9): one row per enrolled '
  'Remote (WireGuard) device -- 1:1 with devices(kind=''remote''), enforced '
  'by device_id being this table''s own primary key (not a separate '
  'surrogate id). NO PRIVATE KEY COLUMN, EVER (R9) -- see this migration''s '
  'own header for the full posture. last-handshake is NOT a column here '
  '(runtime-only fact from packages/wg-native WgStatus, joined in at read '
  'time by listRemoteWireguardDevices, never persisted).';

COMMENT ON COLUMN wg_peers.device_id IS
  'The owning devices row (kind=''remote''). Primary key AND the unique FK '
  'this migration''s own header describes -- one peer per device, no '
  'separate surrogate id needed. ON DELETE CASCADE: deleting the device '
  'deletes this row atomically, in the SAME statement, so there is no '
  'window where one exists without the other.';

COMMENT ON COLUMN wg_peers.public_key IS
  'Standard WireGuard base64 public key (44 chars) -- generated server-side '
  'at enrollment (packages/wg-native generateWgKeyPair) alongside a '
  'private key that is embedded ONCE into the enrollment response''s '
  'configText and never reaches this table (R9). Needed to re-add this '
  'peer to the live wg-native instance on every boot-resume '
  '(remote-wireguard.service.ts loadPeers) and to remove it live on '
  'revocation (WgRemovePeer).';

COMMENT ON COLUMN wg_peers.tunnel_ip IS
  'This device''s stable address from the configured tunnel subnet (RG9: '
  '"server = .1, devices allocated lowest-free from .2-.254" for the /24 '
  'default, generalized to any REMOTE_SUBNET_SCHEMA-legal prefix by '
  'packages/shared/src/remote/subnet-allocation.ts). UNIQUE is the actual '
  'concurrency guard for allocation -- packages/db/src/query/wg-peers.ts '
  'allocateWgPeer reads the currently-used set, computes the lowest free '
  'candidate, and retries on a 23505 against THIS constraint (a race lost '
  'to a concurrent enrollment), never trusting its own read alone to be '
  'race-free.';

COMMENT ON COLUMN wg_peers.created_at_ms IS
  'Enrollment timestamp -- also the tiebreaker column for '
  'listRemoteWireguardDevices'' keyset pagination (paired with devices.id, '
  'the admin.ts listDevicesForUser convention).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0031_probe_tokens
--
-- Additive-only (mirrors 0001/.../0030's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
-- reachability proof + posture card" (R6/RG6, Lane P1). Drift decision #2
-- (orchestrator freeze, "Orchestrator freeze ground-truth + Batch-1
-- dispatch") reserved this number for P1 after WG1/WG2 took 0029/0030.
--
-- The one-time-token reachability proof (R6): the admin mints a probe
-- token bound to a specific expected public endpoint and remote-access
-- path; a phone ON CELLULAR (no prior credentials, RG6) visits
-- `https://<expectedEndpoint>/probe/<token>` to prove the path is
-- actually reachable from the outside. RG6's house pattern M3 EXACTLY:
-- `randomBytes(32).toString("base64url")` minted once by
-- apps/server/src/remote/remote-probes.controller.ts, SHA-256 hex hash
-- stored here, DB equality lookup (constant-time by construction — never
-- a string compare of a secret) — the SAME posture password_reset_tokens/
-- user_invites/refresh_tokens all share (see 0024_password_recovery.sql's
-- header). This module never sees a plaintext token, only its hash.

-- ============================================================================
-- remote_probe_path — real PG enum (house style: notice_severity/
-- device_kind/item_type/... all use CREATE TYPE for a closed SCALAR value
-- set). Deliberately narrower than the contract's RemotePathId (which adds
-- 'none' for the DERIVED "nothing enabled yet" state, RG15/wizard-state.ts's
-- own PathId comment) — a probe is always minted FOR one specific path's
-- setup flow; "prove path none is reachable" is not a legal request
-- (apps/server/src/remote/remote-probes.controller.ts 422s it before this
-- column is ever reached).
-- ============================================================================

CREATE TYPE remote_probe_path AS ENUM ('remote', 'tunnel', 'direct');

-- ============================================================================
-- probe_tokens
-- ============================================================================

CREATE TABLE probe_tokens (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  token_hash        TEXT NOT NULL UNIQUE,
  expected_endpoint TEXT NOT NULL,
  path              remote_probe_path NOT NULL,
  created_by        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms     BIGINT NOT NULL,
  expires_at_ms     BIGINT NOT NULL,
  arrived_at_ms     BIGINT NULL
);

COMMENT ON TABLE probe_tokens IS
  'R6/RG6: one-time reachability-proof tokens. token_hash lookup is the '
  'ONLY read path GET /probe/{token} (apps/server/src/remote/probe-page.'
  'controller.ts) ever uses — constant-time by construction (a DB equality '
  'lookup on a hash, never a string compare of a secret). Single-use, '
  'enforced by the SAME atomic ''UPDATE ... WHERE arrived_at_ms IS NULL '
  'AND expires_at_ms > $now RETURNING *'' compare-and-swap shape '
  'password_reset_tokens/user_invites both already rely on for exactly '
  'this race (packages/db/src/query/remote-probes.ts consumeProbeTokenAndEmit) '
  '— Postgres''s row-level locking on that single-row UPDATE is the ''row '
  'lock'' proving single-use under concurrent first-visits, no advisory '
  'lock needed (unlike system_notices'' multi-row supersede-then-insert, '
  'this is a compare-and-swap on ONE row). 15-minute expiry (R6) set by '
  'the controller at mint time, not this table.';

COMMENT ON COLUMN probe_tokens.token_hash IS
  'sha256(randomBytes(32).toString("base64url")) hex — RG6''s house pattern '
  'M3 EXACTLY, same posture as refresh_tokens.token_hash/'
  'password_reset_tokens.token_hash. The raw token is minted by '
  'apps/server/src/remote/remote-probes.controller.ts, appears ONCE in '
  'POST /admin/remote/probes''s 201 response (embedded in probeUrl/'
  'qrPayload), and is never persisted anywhere — this column is the only '
  'trace of it, and it cannot be reversed back to the plaintext.';

COMMENT ON COLUMN probe_tokens.expected_endpoint IS
  'The public endpoint (bare host[:port], no scheme) the proof is bound '
  'to — embedded verbatim into probeUrl as '
  '`https://<expected_endpoint>/probe/<token>`. Also fed to node:dns '
  '(apps/server/src/remote/remote-dns-resolver.service.ts) when a failed '
  'probe needs classifying (R5/RG11).';

COMMENT ON COLUMN probe_tokens.path IS
  'Which remote-access path (Remote/Tunnel/Direct) this probe is proving '
  '(P1 adjudication — see packages/contract/openapi.yaml''s '
  'CreateRemoteProbeRequest description). Threaded through to '
  'diagnoseReachability so the Tunnel-path connector-health short-circuit '
  '(the freeze''s own diagnosis note) only ever fires for path=''tunnel'', '
  'and so the per-path guidance mapping (packages/shared/src/remote/'
  'diagnosis-guidance.ts) can render path-specific copy once a probe '
  'never arrives.';

COMMENT ON COLUMN probe_tokens.created_by IS
  'The admin who minted this probe. ON DELETE SET NULL (audit-actor '
  'column pattern — events.actor_user_id/system_notices.created_by '
  'precedent): deleting an admin later must not erase probe history, only '
  'sever the specific-user link. NOT NULL is enforced by the query layer '
  'at insert time, matching every other nullable-but-app-enforced-not-null '
  'audit-actor column in this schema.';

COMMENT ON COLUMN probe_tokens.arrived_at_ms IS
  'NULL until GET /probe/{token} consumes this token from a real external '
  'request (probe.arrived, admin-only, no token in the payload — R9). '
  'Set exactly once — the atomic consume UPDATE''s WHERE clause '
  '(arrived_at_ms IS NULL) makes a second arrival for the same token '
  'impossible by construction, so this column doubles as the single-use '
  'flag: NULL = still live, non-NULL = spent. GET /admin/remote/probes/'
  '{id}''s poll status is DERIVED from this column plus expires_at_ms '
  '(packages/db/src/query/remote-probes.ts), never stored separately.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0032_remote_tunnel_state
--
-- Additive-only (mirrors 0001/.../0031's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Loombre Remote — embedded WireGuard + three-path wizard + reachability
-- proof + posture card" (STATE.md R4/R9/RG7, lane T1). Reserved for T1 at
-- the orchestrator's Batch-1 freeze ("DRIFT DECISION #2 ... 0032 = T1
-- (optional)"): single-row runtime state for the Tunnel path — WHICH
-- Cloudflare tunnel/DNS-route this instance currently owns, so a verified
-- teardown (R8) or a status/logs read can find them again after a process
-- restart. The admin's Cloudflare API token itself is NEVER stored here —
-- packages/secrets keyring only (R9), via apps/server/src/remote/tunnel/
-- tunnel-token.service.ts's {value, setAtMs} envelope (the A9/AD4 pattern
-- settings/provider-keys.service.ts and settings/mail-credentials.service.ts
-- both already carry). The per-tunnel CONNECTOR run credential Cloudflare
-- mints at provisioning time is likewise keyring-only (a second, distinct
-- keyring entry) — this table only ever holds NON-secret identifiers.
--
-- Single-row singleton table (`id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id
-- = 1)`): there is exactly one Tunnel-path configuration per instance (RG5/
-- RG15 — at most one remote-access path is active at a time, enforced by
-- each path's staged enable flow, not by this table). The seed row below
-- is inserted once, at migration time, and every subsequent write is an
-- UPDATE (packages/db/src/query/remote-tunnel.ts) — never a second INSERT,
-- which the CHECK constraint would reject outright if attempted.

CREATE TABLE remote_tunnel_state (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  hostname       TEXT NULL,
  tunnel_id      TEXT NULL,
  account_id     TEXT NULL,
  zone_id        TEXT NULL,
  dns_record_id  TEXT NULL,
  enabled_at_ms  BIGINT NULL,
  -- A disabled row never carries leftover provisioning identifiers — every
  -- write clears these together (packages/db/src/query/remote-tunnel.ts),
  -- so a stale tunnel_id can never survive past its own teardown and be
  -- read back as if it were still live.
  CHECK (enabled OR (hostname IS NULL AND tunnel_id IS NULL AND account_id IS NULL AND zone_id IS NULL AND dns_record_id IS NULL AND enabled_at_ms IS NULL))
);

INSERT INTO remote_tunnel_state (id) VALUES (1);

COMMENT ON TABLE remote_tunnel_state IS
  'R4/R9/RG7: singleton runtime state for the BYO-Cloudflare-token Tunnel '
  'path. enabled=false is the disabled/never-configured state (the seed '
  'row). Enabling populates hostname/tunnel_id/account_id/zone_id/'
  'dns_record_id/enabled_at_ms together in one transaction '
  '(packages/db/src/query/remote-tunnel.ts enableTunnelStateAndEmit); '
  'disabling clears all six together ONLY after the provider''s '
  'deprovisionTunnel/removeDnsRoute calls are independently verified to '
  'have succeeded (R8 "verified teardown" -- apps/server/src/remote/'
  'tunnel/remote-tunnel.service.ts orchestrates the provider calls BEFORE '
  'ever calling disableTunnelStateAndEmit, so a failed teardown leaves '
  'this row untouched and a retry has the same ids to work with, never '
  'orphaning a live Cloudflare tunnel with no local record of it).';

COMMENT ON COLUMN remote_tunnel_state.hostname IS
  'The public hostname routed through this tunnel (EnableRemoteTunnelRequest'
  '.hostname, packages/contract/openapi.yaml). NULL when disabled.';

COMMENT ON COLUMN remote_tunnel_state.tunnel_id IS
  'The Cloudflare cfd_tunnel id (TunnelProvider.provisionTunnel''s result) '
  '-- needed to delete the tunnel and to build the '
  '<tunnel_id>.cfargotunnel.com DNS target on teardown. Not a secret (it is '
  'itself PART of the public DNS record), but never useful outside this '
  'instance''s own teardown/status calls either, hence still private to '
  'this table rather than echoed on any read-facing DTO (RemoteTunnelStatus '
  'has no tunnelId field, RG15 frozen shape).';

COMMENT ON COLUMN remote_tunnel_state.account_id IS
  'The Cloudflare account id the stored API token resolved to '
  '(TunnelProvider.validateToken). Required on every subsequent '
  'account-scoped Cloudflare API call (cfd_tunnel create/delete, '
  'configuration PUT) -- resolved once at enable time rather than '
  're-derived from the token on every call.';

COMMENT ON COLUMN remote_tunnel_state.zone_id IS
  'The Cloudflare zone id the DNS CNAME route was created in (resolved '
  'from hostname''s registrable root domain at enable time) -- needed to '
  'delete the DNS record on teardown without a second zone lookup.';

COMMENT ON COLUMN remote_tunnel_state.dns_record_id IS
  'The Cloudflare DNS record id for the <hostname> CNAME -> '
  '<tunnel_id>.cfargotunnel.com route this instance created -- needed to '
  'remove exactly that record (and no other) on teardown.';

COMMENT ON COLUMN remote_tunnel_state.enabled_at_ms IS
  'When this Tunnel path was last enabled, ms. NULL when disabled. Mirrors '
  'remote.enabled''s envelope tsMs/payload enabledAtMs (packages/contract/'
  'event-schemas/remote.enabled.schema.json) -- the SAME value, not a '
  'derived one.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0033_scan_checkpoint_item_counters
--
-- Additive-only (mirrors 0002/.../0032's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Fix Wave 2 FW2-E / AUD-A2d-003 (low, opus V2 review): `scan_checkpoints`
-- (0002_phase1_catalog.sql) already carries `files_processed` across a
-- resumed scan attempt, with a comment explaining why — "files skipped
-- this run because they were already processed in a prior attempt still
-- count as processed." The scan.completed event's itemsAdded/itemsUpdated/
-- itemsRemoved counters never got the same treatment: they live only in
-- an in-memory `counters` object that starts at zero on every runScan()
-- call, so a job resumed after a crash (same job.id, pg-boss retry —
-- apps/worker/src/scan/scanner.ts) reports only the LAST attempt's own
-- work in the one scan.completed event an admin/the web UI ever sees.
--
-- These three columns are the same real-integer-column treatment as
-- files_seen/files_processed (no JSONB — invariant 3): the scanner reads
-- them back on resume to seed `counters`, and re-persists the running
-- total on every checkpoint write (apps/worker/src/scan/scanner.ts's
-- maybeCheckpoint + the final post-walk writeCheckpoint call), so the
-- terminal scan.completed reports the total across every attempt.

ALTER TABLE scan_checkpoints
  ADD COLUMN items_added   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN items_updated INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN items_removed INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN scan_checkpoints.items_added IS
  'Running itemsAdded total across every attempt of this job (FW2-E/'
  'AUD-A2d-003) — mirrors files_processed''s carry-over-on-resume '
  'semantics. Seeded into scan.completed''s payload on resume so the '
  'terminal event reports the sum, not just the last attempt''s own work.';

COMMENT ON COLUMN scan_checkpoints.items_updated IS
  'Running itemsUpdated total across every attempt of this job — see '
  'items_added''s comment.';

COMMENT ON COLUMN scan_checkpoints.items_removed IS
  'Running itemsRemoved total across every attempt of this job — see '
  'items_added''s comment. Note: itemsRemoved is only ever incremented in '
  '`full` mode''s post-walk missing-file sweep, which (unlike the '
  'per-file walk loop) always re-derives its result from the WHOLE '
  'current catalog on every attempt rather than resuming a partial pass — '
  'see scanner.ts''s runScan for why that sweep needs no resume logic of '
  'its own; this column still exists because its count still needs to '
  'accumulate into the same cross-attempt scan.completed total as the '
  'other two.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0034_device_access_revoked_epoch
--
-- Additive-only (mirrors 0002/.../0033's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- AUD-A7b-001 (audit fafa47f, Fix Wave 3 / FW3-D): the SAME bug class
-- 0026_password_changed_epoch.sql (R-F7) fixed for password changes,
-- extended to POST /auth/logout — the other revocation trigger that
-- leaves the DEVICE row (and therefore the session) alive: DELETE
-- /devices/{id} already deletes the row outright (both the plain and the
-- kind='remote' teardown paths), so an already-issued access token for a
-- deleted device is rejected for free the moment
-- apps/server/src/gateway/auth.guard.ts looks the device up and finds
-- nothing — no new column needed for that half. Logout is different: it
-- revokes the device's refresh tokens but deliberately keeps the device
-- row (the same device logs back in later and reuses it), so there is
-- nothing for a "row is gone" check to catch. This column is that
-- device's own credentials-changed epoch.
--
-- NULL = never logged out since this column existed (every pre-migration
-- row, and every device that has only ever been actively used) — no epoch
-- to enforce, every still-valid access token for that device passes.
-- Set to the logout's own `nowMs` by
-- apps/server/src/session/refresh-token.service.ts's logout() ONLY —
-- deliberately NOT by the login path's own revokeRefreshTokensForDevice
-- call (auth.controller.ts's device-reuse-on-login branch): that call and
-- the fresh access token minted moments later in the SAME request share
-- essentially the same `nowMs`, and auth.guard.ts's tie-break (ties
-- reject, same conservative rule 0026 uses) would make the login's own
-- brand-new token DOA in the common case where both land in the same
-- wall-clock second. Login revoking stale refresh tokens for a reused
-- device was never the bug AUD-A7b-001 reported — only the user-initiated
-- "sign out" actions were.

ALTER TABLE devices
  ADD COLUMN access_revoked_at_ms BIGINT NULL;

COMMENT ON COLUMN devices.access_revoked_at_ms IS
  'AUD-A7b-001: per-device credentials-changed epoch, the device-scoped '
  'sibling of users.password_changed_at_ms (migration 0026). NULL = this '
  'device has never been logged out since this column existed. Set only '
  'by POST /auth/logout (refresh-token.service.ts''s logout()) — DELETE '
  '/devices/{id} deletes the row instead, which apps/server/src/gateway/'
  'auth.guard.ts''s device-existence check already rejects on its own. '
  'auth.guard.ts rejects an access token whose iat claim is strictly '
  'before this value for its own deviceId claim.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0035_device_access_revoked_epoch_comment_fix
--
-- Comment-only (no schema change): corrects 0034's COMMENT ON COLUMN,
-- which shipped describing devices.access_revoked_at_ms as set "only by
-- POST /auth/logout". R4 (Fix Wave 3 second review, AUD-A7b-001 follow-up)
-- made that false: login ALSO stamps this column on device-row reuse
-- (packages/db/src/query/identity.ts's updateDeviceForLogin, via its
-- loginAccessEpochMs helper — nowMs floored to the second), because the
-- two logout-only alternatives already shipped and broke in opposite
-- directions — leaving a prior logout epoch in place DOA'd the fresh
-- login token (FW3-D), clearing it to NULL instead resurrected a stolen
-- pre-logout token (R1). 0034 itself is shipped and is not touched by
-- this migration (migration hygiene: never edit a shipped migration) —
-- this is a new, additive, comment-only correction on top of it, the same
-- discipline 0002/.../0034 already follow for schema changes, applied
-- here to metadata instead. See packages/db/src/types.ts's
-- DevicesTable.access_revoked_at_ms doc comment and
-- packages/db/src/query/identity.ts's updateDeviceForLogin/
-- loginAccessEpochMs doc comments for the full account; this migration
-- only brings the DB-resident COMMENT ON COLUMN (visible to anything
-- introspecting the live schema, e.g. `\d+ devices` in psql) back in line
-- with them.

COMMENT ON COLUMN devices.access_revoked_at_ms IS
  'AUD-A7b-001: per-device credentials-changed epoch, the device-scoped '
  'sibling of users.password_changed_at_ms (migration 0026). NULL = this '
  'device has never been revoked since this column existed. Stamped by '
  'TWO writers: POST /auth/logout (refresh-token.service.ts''s logout(), '
  'the logout''s own nowMs) AND login on device-row reuse '
  '(identity.ts''s updateDeviceForLogin, via loginAccessEpochMs, which '
  'floors nowMs to the second so the login''s own fresh token is never '
  'rejected by it — see migration 0035 and loginAccessEpochMs''s own doc '
  'comment for why both writers are required). DELETE /devices/{id} '
  'deletes the row instead of writing this column, which '
  'apps/server/src/gateway/auth.guard.ts''s device-existence check '
  'already rejects on its own. auth.guard.ts rejects an access token '
  'whose iat claim is strictly before this value for its own deviceId '
  'claim.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0036_admin_list_indexes.sql
--
-- Audit fafa47f Fix Wave 6 (lane FW6-F): closes AUD-A8b-001, AUD-A8b-002,
-- and AUD-V2-M3 (validated/V2.md). Two admin list endpoints shipped without
-- the covering index plan §6.2 requires ("every list-endpoint access path
-- has a covering index reviewed at PR time"), and two 0001/0002-era indexes
-- are strict column-prefixes of their own tables' UNIQUE constraint indexes.
--
-- Method note: numbers below were measured with EXPLAIN (ANALYZE, BUFFERS)
-- against a dedicated evidence database on the dev postgres:18 container
-- (schema = migrations 0001–0035, seed.mjs + seed-large.mjs's 50k movies,
-- plus 100k synthetic probe/image jobs rows and provider_ids rows marking
-- 80% of the movies matched — the "one jobs row per scanned file, never
-- pruned" growth profile AUD-A8b-001 documents). Warm cache, this hardware.
--
-- ============================================================================
-- AUD-A8b-001: GET /admin/jobs had NO supporting index — sequential scan +
-- sort on every page, on a table that grows one row per scanned/probed/
-- imaged file with no retention. The only audit finding that gets worse on
-- its own over time.
-- ============================================================================
--
-- listJobsAdmin (packages/db/src/query/admin.ts) is an UNFILTERED keyset
-- list ordered by (created_at_ms DESC, id DESC). Neither existing index
-- serves it: jobs_status_priority_idx leads with status (no status
-- predicate exists on this path) and jobs_pkey is (id). Measured @ 100k
-- jobs rows: page 1 was a Parallel Seq Scan + top-N heapsort, 1379 buffers,
-- 12.1ms -> with this index a plain ordered Index Scan, 6 buffers, 0.045ms
-- (planner-preferred, no enable_seqscan coaxing).
--
-- The same fix wave switches listJobsAdmin's cursor from the OR-form
-- keyset comparison to the ROW() form (catalog-detail.ts's established
-- pattern) — measured @ the ~row-50,000 cursor, the OR-form was applied as
-- a per-row Filter even WITH this index (50,001 rows removed by filter,
-- 918 buffers, 5.4ms); the ROW() form lands as an Index Cond b-tree seek
-- (4 buffers, 0.022ms, flat regardless of page depth).

CREATE INDEX jobs_created_at_keyset_idx ON jobs (created_at_ms DESC, id DESC);

COMMENT ON INDEX jobs_created_at_keyset_idx IS
  'AUD-A8b-001: keyset index for the unfiltered GET /admin/jobs ledger '
  'list (packages/db/src/query/admin.ts listJobsAdmin, also polled by the '
  'desktop IPC bridge''s listRecentJobs). Orders by (created_at_ms, id) '
  'with no leading filter column — jobs_status_priority_idx cannot serve '
  'this path because it leads with status. DESC matches the only order '
  'this query ever issues, so the scan streams without a sort node. '
  'Measured @ 100k rows: page 1 seq-scan+sort 12.1ms/1379 buffers -> '
  'index scan 0.045ms/6 buffers; deep-page ROW() cursor seek 0.022ms.';

-- ============================================================================
-- AUD-A8b-002: GET /admin/libraries/{id}/unmatched lost its keyset
-- index-order because item_type is a 4-value IN().
-- ============================================================================
--
-- listUnmatchedLibraryItemsForViewer filters one library to the four
-- enrichable item types (movie/series/artist/album) and orders by
-- (added_at_ms DESC, id DESC). 0021's header records the planner
-- limitation that bites here: a btree serves col IN (...) but only
-- preserves index ORDER on trailing columns when the multi-value predicate
-- binds EXACTLY ONE value. 0009's (library_id, item_type, added_at_ms,
-- id) composite therefore stops preserving order the moment item_type is
-- a 4-value IN(), and the plan grows an explicit Sort (measured @ 50k
-- items: an Incremental Sort over a content_class-index walk, 20.3ms,
-- 3425 buffers, with the true "unmatched" selectivity invisible to the
-- planner ahead of the NOT EXISTS).
--
-- The fix applies 0021's own remedy to this shape: take the multi-value
-- column OUT of the key columns and pin it in a partial predicate instead.
-- Unlike 0021's case, library_id CAN lead here — this endpoint is
-- per-library, so the leading predicate is always a single-value equality
-- (never the multi-value ANY() that made 0021 drop library_id). The four
-- enrichable types become the partial WHERE; (added_at_ms DESC, id DESC)
-- stay the only real order columns. Measured @ 50k items (10k unmatched):
-- the Sort node is GONE — an ordered Index Scan feeds the anti-join and
-- Limit directly, and the deep-page ROW() cursor (switched in admin.ts in
-- this same wave) is an Index Cond seek (0.073ms).
--
-- SYNC INVARIANT: the type list below mirrors ENRICHABLE_ITEM_TYPES in
-- packages/db/src/query/admin.ts (which itself mirrors the metadata
-- consumer's enrichable set). If a type is ever added there, this partial
-- predicate must be widened in a new migration or the planner will
-- silently fall back to sort-based plans for the wider IN() (predicate
-- implication fails, the index is simply not used — wrong plans, never
-- wrong rows).

CREATE INDEX catalog_items_library_added_enrichable_idx
  ON catalog_items (library_id, added_at_ms DESC, id DESC)
  WHERE item_type IN ('movie', 'series', 'artist', 'album');

COMMENT ON INDEX catalog_items_library_added_enrichable_idx IS
  'AUD-A8b-002: keyset index for GET /admin/libraries/{id}/unmatched '
  '(admin.ts listUnmatchedLibraryItemsForViewer, the Fix Match panel). '
  'PARTIAL on the four enrichable item types so the multi-value IN() '
  'lives in the predicate, not the key columns — Postgres only preserves '
  'index order past a multi-value IN() key column when it binds one value '
  '(0021''s documented limitation; here library_id leads legitimately '
  'because this per-library endpoint always binds it to exactly one '
  'value). MUST stay in sync with admin.ts ENRICHABLE_ITEM_TYPES — see '
  'migration 0036''s sync-invariant note. Measured @ 50k items/10k '
  'unmatched: Incremental Sort eliminated, ordered index scan feeds '
  'LIMIT directly; deep-page ROW() cursor seeks in 0.073ms.';

-- ============================================================================
-- AUD-V2-M3: two redundant indexes, each a strict column-prefix of its own
-- table's UNIQUE constraint index — pure write/storage overhead.
-- ============================================================================
--
-- A btree serves any query that filters on a prefix of its columns, so:
--   * images_entity_idx (entity_type, entity_id, kind) is fully subsumed
--     by the UNIQUE (entity_type, entity_id, kind, width) constraint index
--     from the same 0001 CREATE TABLE. Every real reader filters on
--     (entity_type, entity_id) only — verified across all six call sites
--     (packages/db/src/query/images.ts et al.), and EXPLAIN confirms the
--     lookup lands on images_entity_type_entity_id_kind_width_key with
--     both columns as Index Cond once the redundant index is gone.
--   * metadata_provenance_item_id_idx (item_id) is fully subsumed by
--     UNIQUE (item_id, field) from the same 0002 CREATE TABLE; the sole
--     reader (src/internal/provenance.ts) filters on item_id alone and is
--     served by metadata_provenance_item_id_field_key (EXPLAIN-confirmed).
-- Both tables are written by every scan/backfill; each drop removes one
-- whole btree's maintenance cost per write and returns its storage. No
-- behavior change — 0018's "index law" (land WITH the queries that need
-- them) applied retroactively to two pre-existing 0001/0002 indexes that
-- never had a query of their own.

DROP INDEX images_entity_idx;

DROP INDEX metadata_provenance_item_id_idx;

-- 0037: index for "newest ledger row of a given type" (W1/D-1 2026-08-07).
--
-- GET /admin/capabilities derives its three-state probe status from the
-- latest 'hwprobe' jobs row (packages/db/src/query/admin.ts
-- getLatestJobOfTypeAdmin: WHERE type = $1 ORDER BY created_at_ms DESC,
-- id DESC LIMIT 1). jobs has indexes on (status, priority, created_at_ms),
-- (created_at_ms DESC, id DESC) and subject_item_id — none lead with
-- `type`, so that lookup seq-scans the whole ledger (measured: parallel
-- seq scan at 200k rows), on an endpoint the setup wizard polls every 4s
-- and on exactly the install shape W1 is about. jobs is the
-- fastest-growing table in the schema (one probe row per media file);
-- this makes the lookup a direct b-tree seek.

CREATE INDEX jobs_type_created_at_keyset_idx
  ON jobs (type, created_at_ms DESC, id DESC);

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0038_media_streams_open_gop
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010's discipline): no
-- column drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified playback defect: HEVC sources encoded with open GOPs
-- (CRA keyframes + RASL leading pictures) cause full-frame white decode
-- smears in MSE playback for a few seconds after a seek-restart
-- stream-copy transcode run. @loombre/playback-engine (ENGINE_VERSION
-- 0.8.4, packages/playback-engine/src/types.ts's VideoStream.openGop)
-- consults this per-video-stream fact to decide whether a withSeek copy
-- run needs `-bsf:v filter_units=remove_types=8-9` (strips the RASL_N/
-- RASL_R leading-picture NAL units that decode into the smear) — see that
-- package's args/builder.ts.
--
-- NULL means "not yet probed for this fact" (video-only, mirrors 0002's
-- hdr/dv_profile/interlaced NULL convention) — distinct from `false`
-- ("probed and confirmed closed-GOP"). The probe pipeline
-- (apps/worker/src/probe) only ever positively detects `true`; every
-- other case (non-HEVC streams, a scan failure/timeout, or a legacy row
-- predating this column) stays `false`/NULL rather than guessing `true`
-- — packages/db/src/query/media-info.ts and src/internal/media-assembly.ts
-- map NULL -> false when assembling the docs/PLAYBACK.md §2.1 MediaInfo
-- shape (conservative: never strip GOP-boundary NALs unless positively
-- detected). apps/worker/src/probe/opengop-backfill-consumer.ts sweeps
-- pre-existing hevc rows still NULL; every non-hevc NULL row is bulk-set
-- false directly in SQL (no scan needed, since the engine only ever
-- consults this field for hevc video streams).

ALTER TABLE media_streams ADD COLUMN open_gop BOOLEAN NULL;

COMMENT ON COLUMN media_streams.open_gop IS
  'Video-only (docs/PLAYBACK.md §2.1 VideoStream.openGop / '
  '@loombre/playback-engine''s VideoStream.openGop). true = a bounded '
  'ffmpeg `trace_headers` NAL scan (apps/worker/src/probe) found a '
  'CRA_NUT/BLA keyframe as a non-first keyframe or a RASL_N/RASL_R leading '
  'picture — open-GOP HEVC, needs the seek-restart RASL-strip bitstream '
  'filter. false = confirmed closed-GOP (IDR-only) OR a non-HEVC stream '
  '(the engine never consults this field for non-hevc codecs). NULL = not '
  'yet probed for this fact (legacy row predating this column, or the scan '
  'failed/timed out — never guessed true). See migrations/0002_phase1_'
  'catalog.sql''s hdr/dv_profile/interlaced columns for the same '
  'video-only-NULL convention this mirrors.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0039_events_seq
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010/0038's discipline):
-- no column drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified ordering defect (packages/jobs/test/ledger-events.spec.ts
-- "'pg-upgrade' can also record a failed upgrade attempt" flaked once under
-- a parallel gate:full run: events came back ['queued','failed','active']
-- instead of ['queued','active','failed']).
--
-- Root cause: every read that orders the outbox by `events.id` (this
-- migration's sibling reads in packages/db/src/query/events.ts, and the
-- ledger-events spec's own inline helper) rests on the assumption, stated
-- explicitly in events.ts's header, that "UUIDv7's layout ... makes
-- Postgres's byte-wise UUID ordering equivalent to insertion-time order".
-- That assumption is FALSE within a tied millisecond: loombre_uuidv7()
-- (this file's schema.sql, `loombre_uuidv7()`) stamps bytes 0-5 from
-- clock_timestamp() truncated to the millisecond, but fills every
-- remaining bit (byte 6's low nibble, byte 7, byte 8's low 6 bits, bytes
-- 9-15 — the vast majority of the value) from bare `random()`, with NO
-- monotonic-counter fallback for same-millisecond collisions (RFC 9562
-- §6.2's "Method 1: Fixed-Length Dedicated Counter Bits" or "Method 3:
-- Replace Left-Most Random Bits with Increased Clock Precision" — neither
-- implemented here). Two events written back-to-back within the same
-- Postgres clock millisecond (routine under concurrent load: two awaited
-- local round-trips easily land inside 1ms) therefore tie on the ordered
-- byte prefix and fall back to comparing PURE RANDOM tail bytes — a coin
-- flip uncorrelated with which INSERT actually ran first. `ORDER BY id`
-- is consequently NOT a valid tie-break for emission order; it only LOOKS
-- valid because same-millisecond collisions are rare outside load.
--
-- Fix: `seq` is a BIGINT populated by Postgres's own per-column identity
-- sequence (nextval(), same primitive backing SERIAL/BIGSERIAL). Sequence
-- values are handed out synchronously, in the exact order nextval() is
-- invoked, with no two callers ever receiving the same value — this holds
-- regardless of clock resolution or transaction commit order, so for any
-- row INSERTed FROM THIS MIGRATION ONWARD, `seq` is a GUARANTEED total
-- order over insertion attempts, not merely a lower-probability-of-
-- collision one. For any caller that awaits each INSERT (commit included)
-- before issuing the next — every packages/jobs/src/ledger.ts
-- recordQueued/recordActive/recordCompleted/recordFailed transition,
-- called sequentially in the ledger-events spec — the second INSERT's
-- nextval() call happens strictly after the first's, so `seq` strictly
-- increases in exactly the emission order, with no possible tie.
--
-- Pre-existing rows (any database that already had an events table before
-- this migration ran) are NOT covered by that guarantee: `ADD COLUMN ...
-- GENERATED ALWAYS AS IDENTITY` is a volatile-default column addition, so
-- Postgres backfills every existing row's `seq` in one pass, in PHYSICAL
-- HEAP scan order — NOT insertion order. Those two orders provably diverge
-- here: events rows are UPDATEd after insertion by markEventsProcessed
-- (packages/db/src/query/events.ts, sets processed_at_ms once a batch has
-- been broadcast), and a Postgres UPDATE writes a new row version rather
-- than rewriting in place, so a row's heap position reflects its last
-- UPDATE, not its original INSERT. Pre-existing rows therefore get a `seq`
-- value that is arbitrary-but-unique relative to true insertion order —
-- fine as an opaque tie-break key (still never repeats, still totally
-- orders every row), but not a retroactive proof of when a pre-migration
-- row was actually written. Only rows inserted after this migration carry
-- the strong "matches insertion order" guarantee above.
--
-- Cost on upgrade: because the ADD COLUMN has a volatile default (identity
-- backfill, effectively DEFAULT nextval(...) evaluated per row), Postgres
-- cannot do the fast metadata-only add it does for a constant/NULL
-- default — this rewrites the ENTIRE table under an ACCESS EXCLUSIVE lock
-- (blocks all reads and writes on `events` for the duration). `events` has
-- no pruning/retention path (nothing ever DELETEs from it), so on any
-- install that has been running a while it is a strong candidate for the
-- largest table in the database, and this is a one-time, unavoidable-at-
-- this-migration cost on upgrade. Considered and rejected: splitting this
-- into the standard zero-downtime sequence (ADD COLUMN nullable, backfill
-- in batches, ADD ... NOT NULL, SET default, all as separate migrations)
-- — rejected for v0.9.0-rc: pre-1.0 installs are testers on small/disposable
-- databases where the extra migrations' complexity costs more than the
-- lock they'd avoid; revisit before a 1.0 release once install sizes are
-- real.
--
-- UNIQUE is redundant with identity-sequence semantics (values are never
-- reused) but stated explicitly rather than left implicit, and doubles as
-- the index the new `ORDER BY ... seq` read wants.
ALTER TABLE events ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;

COMMENT ON COLUMN events.seq IS
  'Postgres identity-sequence tie-break for outbox read ordering. Unlike '
  '`id` (UUIDv7 — time-ordered only to the millisecond; ties within a '
  'millisecond resolve on random bits, NOT insertion order — see this '
  'migration''s header), `seq` is assigned by a strictly-increasing '
  'per-column sequence at INSERT time, so ORDER BY seq is a real, gap-'
  'tolerant-but-never-tied total order over insertion order — for rows '
  'inserted AFTER this migration ran. Rows that pre-date this migration '
  'were backfilled in physical heap order (NOT insertion order: events '
  'rows are UPDATEd post-insert by markEventsProcessed, so heap order had '
  'already diverged from insertion order) — their seq values are unique '
  'and totally ordered relative to each other but arbitrary relative to '
  'when they were actually written. Not a replacement for `id` as primary '
  'key/cursor token (UUIDv7 stays opaque and unguessable for that role) — '
  'this column exists ONLY to give ordering reads a tie-break that cannot '
  'lie under load, for post-migration rows.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0040_plugin_delivery_cursor_seq
--
-- Additive-only (mirrors 0002/.../0038/0039's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified persisted-cursor skip hazard (opus-review LD wave,
-- Finding 1): packages/db/src/query/plugins-delivery.ts's
-- listCandidateEventsForDelivery read the outbox via `WHERE id > afterId
-- ORDER BY id ASC`, keyset-paginating on `events.id` against the SAME
-- persisted cursor (plugin_delivery_cursors.cursor_event_id) that
-- migrations/0039_events_seq.sql's header already proved is UNSAFE for
-- same-millisecond ordering: two events written in the same Postgres
-- clock millisecond tie on UUIDv7's time-ordered prefix and fall back to
-- comparing pure-random tail bits, uncorrelated with insertion order. For
-- 0039's ONE fixed reader (the websocket broadcaster) that "only" meant a
-- delivery-order hazard within a single already-connected tick. Here it is
-- worse: the cursor PERSISTS between ticks, so a same-millisecond sibling
-- event whose id happens to sort BEFORE the plugin's just-advanced cursor
-- is excluded by `id > afterId` on every subsequent tick FOREVER — a
-- silent, permanent skip, not a transient reordering — and
-- findOldestUnconsumedBeforeMs (this table's gap detector) does not catch
-- it: that function only flags events older than the retention window,
-- not same-millisecond siblings sitting right at the cursor's own advance
-- point, which is exactly where this hazard lives. That is a direct
-- violation of LPP v1 mission §3.2's "gaps reported, never skipped".
--
-- Fix: give plugin_delivery_cursors its own `events.seq` tie-break,
-- exactly the column 0039 minted for this purpose, and switch
-- listCandidateEventsForDelivery's keyset read to `WHERE seq > afterSeq
-- ORDER BY seq ASC` (packages/db/src/query/plugins-delivery.ts,
-- apps/worker/src/plugin-delivery/delivery-loop.ts). `seq` is a Postgres
-- identity-sequence value assigned synchronously at INSERT time with no
-- dependence on clock resolution, so same-millisecond siblings can never
-- tie and can never sort out of insertion order — see 0039's header for
-- the full mechanism.
--
-- KEPT, not dropped: cursor_event_id. Two production readers exist for
-- this table's cursor today (packages/db/src/query/events.ts's header,
-- updated by this same fix wave, documents both): the candidate-event read
-- this migration retargets at `seq`, AND findOldestUnconsumedBeforeMs's
-- gap detector, which stays keyed on `events.id > afterId` — gap detection
-- compares against `ts_ms < beforeMs` (the retention-window edge), a
-- comparison `seq` cannot help with (seq is an opaque insertion-order
-- counter with no relationship to wall-clock time), so converting IT to
-- `seq` would buy nothing while touching a second read path this finding
-- did not identify as broken. cursor_event_id also remains the
-- observability-facing value (a real, human-followable events.id) a
-- future admin delivery-stats panel (W5b) would show, where a bare `seq`
-- integer is meaningless outside this table. Every writer
-- (recordDeliverySuccess / advanceCursorPastFilteredEvents) now writes
-- BOTH columns together, in the same statement, so they can never
-- observably disagree about "how far did this plugin get" — the same
-- discipline plugins-delivery.ts's header already documents for
-- cursor_event_id vs. delivered_batches/delivered_events. This is the
-- lower-risk of the two options the review posed (keep-alongside vs.
-- drop): dropping cursor_event_id would require rewriting
-- findOldestUnconsumedBeforeMs's cursor semantics in the SAME migration
-- that fixes the listCandidateEventsForDelivery hazard, conflating two
-- independent changes and widening this migration's blast radius for no
-- corresponding benefit.
--
-- Backfill: `cursor_event_seq` is derived from the EXISTING
-- cursor_event_id via a subselect against `events.id`. This subselect is
-- guaranteed to resolve for every non-NULL cursor_event_id: `events` has
-- no pruning/retention mechanism (migrations/0016_plugin_delivery_
-- cursors.sql's header — "events has no pruning/retention path" — nothing
-- ever DELETEs an events row), so any id a cursor ever recorded is still
-- present. A cursor_event_id that is NULL (this plugin has never
-- successfully delivered a batch — migrations/0016's own "never
-- delivered" convention) backfills to a NULL cursor_event_seq, which
-- delivery-loop.ts treats identically to a fresh/never-delivered cursor
-- (afterSeq defaults to 0, the "from the beginning" value, the same way
-- baseAfterId already defaults to EPOCH_ZERO_BOUNDARY_UUID) — no separate
-- NULL-handling branch needed anywhere this column is read.
--
-- Cost on upgrade: `plugin_delivery_cursors` has at most one row per
-- installed plugin (migrations/0016's PRIMARY KEY), never a
-- high-cardinality table like `events` — this ADD COLUMN + UPDATE
-- backfill is cheap and bounded by installed-plugin count, unlike 0039's
-- table-rewrite cost on `events`.
ALTER TABLE plugin_delivery_cursors ADD COLUMN cursor_event_seq BIGINT NULL;

UPDATE plugin_delivery_cursors
SET cursor_event_seq = (SELECT seq FROM events WHERE events.id = plugin_delivery_cursors.cursor_event_id)
WHERE cursor_event_id IS NOT NULL;

COMMENT ON COLUMN plugin_delivery_cursors.cursor_event_seq IS
  'events.seq (migrations/0039_events_seq.sql) of the last event '
  'successfully included in a 2xx-acknowledged batch for this plugin — '
  'the value packages/db/src/query/plugins-delivery.ts''s '
  'listCandidateEventsForDelivery actually keysets the next read on '
  '(`WHERE seq > cursor_event_seq`), NOT cursor_event_id (see this '
  'migration''s header for why events.id is unsafe as a same-millisecond '
  'keyset tie-break). Always advanced together with cursor_event_id in '
  'the same statement — the two can never observably disagree about how '
  'far a plugin''s delivery cursor has advanced. NULL = never delivered '
  '(same convention as cursor_event_id) — a fresh cursor or one whose '
  'cursor_event_id backfilled to NULL because it had never recorded a '
  'success at migration time.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0041_playback_sessions_worker_process
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010/0038's discipline):
-- two nullable columns and one partial index. No column drops, no type
-- narrowing, no rewriting of prior migrations, no contract surface — these
-- columns are worker-internal bookkeeping and are never serialized into an
-- API response (packages/db/src/query/playback-sessions.ts's
-- PlaybackSessionRow deliberately does not carry them).
--
-- WHY. Every transcode run's ffmpeg is spawned `detached: true` on POSIX
-- (apps/worker/src/transcode/process.ts) so suspend/resume/terminate can
-- signal the whole process group. The price of that is that the child does
-- NOT die with its worker. A GRACEFUL shutdown now kills its children
-- explicitly (apps/worker/src/transcode/run-registry.ts), but a hard kill
-- — SIGKILL, an OOM kill, a power cut — runs no code at all, and the
-- surviving ffmpeg then encodes at full rate forever: nothing is left to
-- throttle it (docs/PLAYBACK.md §9's ahead>10 SIGSTOP needs a supervisor),
-- to seek it, or to end it. Its admission slot, meanwhile, is freed the
-- moment the server's heartbeat sweeper ends the session
-- (countActiveTranscodeSessions counts only non-terminal rows), so the
-- next viewer is admitted on top of it. On Tier-0 hardware (N100/4GB,
-- docs/PLAN.md §9) two of those is the whole machine.
--
-- The next worker boot is the only remaining place to clean that up, and
-- the database row is the only thing that survived the crash — so the pid
-- has to be ON the row. apps/worker/src/transcode/reaper.ts reads these
-- two columns at boot, verifies the pid is BOTH alive AND actually this
-- session's ffmpeg (pid + cmdline against staging_dir — pids are reused,
-- and SIGKILLing an unrelated process would be a worse bug than the one
-- being fixed), SIGKILLs the process group if so, and fails the session.

ALTER TABLE playback_sessions
  ADD COLUMN worker_pid            INTEGER NULL,
  ADD COLUMN worker_started_at_ms  BIGINT NULL;

COMMENT ON COLUMN playback_sessions.worker_pid IS
  'OS process id of the ffmpeg run currently supervising this session, '
  'written by apps/worker/src/transcode/runner.ts at every spawn (initial '
  'run and every seek-restart, so it always names the LIVE process). '
  'NULL for a direct-play session, for a session whose pipeline never '
  'started, and for every row predating this migration. Read only by the '
  'boot-time orphan reaper (apps/worker/src/transcode/reaper.ts) — never '
  'by a request path, never serialized into an API response. A pid alone '
  'is not proof of identity (pids are reused): the reaper additionally '
  'verifies the process''s command line contains this row''s staging_dir '
  'before it is willing to signal anything.';

COMMENT ON COLUMN playback_sessions.worker_started_at_ms IS
  'Start time (epoch ms) of the WORKER PROCESS that spawned worker_pid — '
  'the generation marker, not the ffmpeg''s own start time. The shipped '
  'topology is one worker per database (every installer + '
  'docker-compose.prod.yml; packages/db/src/query/worker-liveness.ts '
  'embeds the same assumption), so any non-terminal session whose '
  'worker_started_at_ms predates the CURRENTLY booting worker was '
  'orphaned by a dead predecessor — even if its ffmpeg is still running '
  'happily, because the supervisor that could throttle, seek, or end it '
  'is gone. Same generation-horizon reasoning as jobs-ledger '
  'reconciliation''s activeStaleBeforeMs (packages/db/src/internal/'
  'jobs.ts).';

-- The reaper''s boot query, and nothing else, reads these columns. It is a
-- narrow slice of a table that grows without bound (one row per playback
-- session, ever), so it gets a partial index rather than a sequential scan
-- on a Tier-0 box''s boot path. `status` is enumerated inline instead of
-- using NOT IN so the predicate stays trivially matchable by the planner.
CREATE INDEX playback_sessions_reapable_idx
  ON playback_sessions (worker_started_at_ms)
  WHERE worker_pid IS NOT NULL
    AND status IN ('created', 'starting', 'active', 'suspended', 'seeking');

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0042_restricted_browse_rating_sort_indexes
--
-- LD-12 (STATE.md, comparative-architecture-study implementation run):
-- restricted-browse.ts's sort=rating gets two per-direction partial
-- expression indexes on catalog_items — closing the S10 "sort=rating is
-- CHEAPLY fixable... deliberately not landed because it reverses a
-- recorded 0009 decision" residue with an owner yes.
--
-- REVERSES migrations/0009_browse_keyset_indexes.sql's decision, WITH the
-- reason recorded at that decision's own site (0009's header comment now
-- points here) as this ledger's own rule requires. 0009 declined
-- rating/year sorts together, reasoning "would need four expression
-- indexes or a query redesign" (2 columns x 2 directions) and logged it
-- Open rather than landing it. This migration lands the narrower half of
-- that declined set: sort=rating ONLY (not year, not duration — those
-- stay open, see restricted-browse.ts's own S10 comment), and ONLY for
-- the restricted zone's catalog_items WHERE item_type='movie' slice (not
-- the general catalog listCatalogItems path 0009 was actually measuring)
-- — 2 indexes, not 4, because this migration does not also cover 'year'.
-- The "one index does not cover both directions" reasoning 0009 (and
-- 0021 after it) cited is still correct; it is answered here with two
-- direction-specific expression indexes rather than redesigned away.
--
-- MEASURED (R2 audit, 33k fixture, two-restricted-library viewer, same
-- hardware/warm-cache conditions 0021's own table used — evidence
-- transcribed verbatim from restricted-browse.ts's own S10 comment, which
-- predates this migration):
--   sort=rating order=desc: 238.7ms -> 7.4ms
--   sort=rating order=asc:  253.1ms -> 7.5ms
--   deep keyset (~page 21): 7.7ms
--   index size: ~1.3 MB each
--
-- The sentinel (-1 for desc, 11 for asc — packages/db/src/query/
-- restricted-browse.ts's RATING_LOW_SENTINEL/RATING_HIGH_SENTINEL) reaches
-- Postgres as a bound PARAMETER, not a literal, which would normally
-- defeat expression-index matching. It does not here, because
-- node-postgres issues unnamed statements and Postgres therefore plans
-- each one with the parameter's actual value (a custom plan). Anything
-- that changes that (naming/preparing these statements, or a future
-- plan_cache_mode=force_generic_plan) would silently un-match the index —
-- a re-measurement belongs in the SAME change as any such switch.
--
-- sort=date and sort=duration remain open (S10, restricted-browse.ts's
-- own comment): date's COALESCE lives on a LEFT JOINed satellite
-- (movie_details) and the planner does not choose the equivalent index
-- from a catalog_items-driven scan (measured: index present, unused,
-- 240.2ms -> 238.2ms); duration needs a catalog_items.primary_duration_ms
-- denormalization (a writer change across probe + apply), out of an
-- index-only migration's scope.
CREATE INDEX catalog_items_restricted_rating_desc_keyset_idx
  ON catalog_items ((COALESCE(community_rating, -1)) DESC, id DESC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_restricted_rating_desc_keyset_idx IS
  'Restricted-zone browse, sort=rating order=desc (packages/db/src/'
  'query/restricted-browse.ts''s sortKeyExpr): 238.7ms -> 7.4ms measured '
  '(33k fixture, R2 audit) -- LD-12, reverses 0009''s declined-rating-'
  'sort decision for this narrower (restricted-zone-only, rating-only) '
  'case. NULL community_rating sorts last via the -1 sentinel, matching '
  'RATING_LOW_SENTINEL.';

CREATE INDEX catalog_items_restricted_rating_asc_keyset_idx
  ON catalog_items ((COALESCE(community_rating, 11)) ASC, id ASC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_restricted_rating_asc_keyset_idx IS
  'Restricted-zone browse, sort=rating order=asc: 253.1ms -> 7.5ms '
  'measured (33k fixture, R2 audit) -- LD-12, see the desc index''s '
  'comment for the full decision-reversal reasoning. NULL '
  'community_rating sorts last via the 11 sentinel, matching '
  'RATING_HIGH_SENTINEL (ratings are 0-10, so 11 is always highest).';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0043_transcode_runs
--
-- Additive-only (mirrors 0002/.../0041's discipline): one new table, no
-- column drops, no type narrowing, no rewriting of prior migrations, no
-- contract surface.
--
-- WHY. A transcode session is served as ONE playlist whose segment indices
-- are a single global counter (docs/PLAYBACK.md §9: a seek-restart's run
-- continues the previous run's numbering, `{START_SEG}` =
-- producedSegment+1). But each seek run is spawned with `-ss` and no
-- `-copyts`, so its OWN output timeline restarts at zero. The two facts
-- were never connected by anything durable, which made a whole class of
-- questions unanswerable for any run after the first:
--   "segment 57 is playing — what SOURCE position is that?"
-- Presentation time (what the player reports) and source time (what
-- progress, resume points and seek targets are expressed in) diverge by
-- exactly the run's source origin, and nothing recorded that origin.
--
-- Each row is one spawned run: the run index, the segment index it began
-- numbering at, and where it starts in SOURCE time (0 for run 0; the
-- consumed seek target for every restart). A server-side consumer maps a
-- served segment index to its owning run — the row with the greatest
-- start_segment <= that index — and reads the origin from it.
--
-- REAL COLUMNS, REAL FK, deliberately NOT JSONB: CLAUDE.md invariant 3
-- whitelists JSONB for ffprobe output, event payloads, serialized plans,
-- item_attributes values, device capability profiles, user settings prefs,
-- server_settings.value and plugin manifest/config. This is none of those
-- — it is queryable relational state with an owner, and it is read by an
-- index lookup on a hot path.
--
-- BACKWARD SEEKS ARE WHY OWNERSHIP FOLLOWS THE SEGMENT COUNTER, NOT THE
-- CLOCK: run 2 can have a source origin EARLIER than run 1's while its
-- segment numbering still moves forward. `start_segment` is therefore the
-- only monotonic key across a session's runs, and the lookup orders by it.

CREATE TABLE transcode_runs (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  session_id        UUID NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
  run_index         INTEGER NOT NULL,
  start_segment     INTEGER NOT NULL,
  source_origin_ms  BIGINT NOT NULL,
  created_at_ms     BIGINT NOT NULL,
  UNIQUE (session_id, run_index)
);

COMMENT ON TABLE transcode_runs IS
  'One row per ffmpeg run spawned for a transcode session (apps/worker/src/'
  'transcode/runner.ts), including run 0. Exists so a served segment index '
  'can be mapped back to a SOURCE-time position: segment numbering is '
  'global across a session''s runs while each seek run''s own output '
  'timeline restarts at zero. Worker-written, server-read; rows die with '
  'their session.';

COMMENT ON COLUMN transcode_runs.run_index IS
  'Zero-based, monotonic per session; matches the run''s staging '
  'subdirectory name (`run0`, `run1`, ...) and the run-relative URI prefix '
  'in the served playlist.';

COMMENT ON COLUMN transcode_runs.start_segment IS
  'The absolute segment index this run begins numbering at ({START_SEG}, '
  'docs/PLAYBACK.md §6): 0 for run 0, previous producedSegment+1 for each '
  'seek restart. The ONLY monotonic ordering key across a session''s runs — '
  'source_origin_ms is not monotonic, because a backward seek starts a '
  'later run at an earlier source position.';

COMMENT ON COLUMN transcode_runs.source_origin_ms IS
  'Where this run starts in the SOURCE timeline, milliseconds (CLAUDE.md '
  'invariant 5). 0 for run 0; the seek target the worker actually consumed '
  '(post-clamp) for a seek restart. Segment N''s source position is this '
  'value plus N''s offset within the owning run — the run''s own output '
  'timestamps start at zero, since runs are spawned with `-ss` and without '
  '`-copyts`.';

-- The one read this table exists for: "which run owns segment N for this
-- session?" — greatest start_segment <= N, scoped to one session. DESC
-- matches the ORDER BY ... LIMIT 1 the query uses, so it is a single index
-- step rather than a scan of the session's runs.
CREATE INDEX transcode_runs_session_start_segment_idx
  ON transcode_runs (session_id, start_segment DESC);

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0044_playback_rung_switch
--
-- Additive-only (mirrors 0002/.../0043's discipline): three new nullable
-- columns, no drops, no type narrowing, no rewriting of prior migrations.
--
-- WHY (docs/PLAYBACK.md §9.1, Wave C2 — LD-6 governed by LD-16). The master
-- playlist advertises every rung of the session's stored plan, and a client
-- ABR switch surfaces to the server as a GET whose path names a DIFFERENT
-- rung (`v{K}/media.m3u8`, `v{K}/runN/sNNNNNN.m4s`). LD-16 forbids that
-- starting a second pipeline: "every quality rung is a separate workload
-- governed by the existing admission capacity limit; a quality change HANDS
-- THE EXISTING SLOT from one rung to another — it never starts an
-- additional unrestricted transcode."
--
-- Handing the slot over is a restart of the one live pipeline with
-- different rung args, so it needs exactly the same shape of control
-- channel a seek already has (migration 0012): a server-written REQUEST
-- column the worker consumes, plus a worker-written fact about what is
-- actually running. Those are `pending_rung_index` and `active_rung_index`.
-- `transcode_runs.ladder_rung_index` records which rung each spawned run
-- encoded, so a session's run history says not just WHERE each run started
-- but WHAT quality it was producing.
--
-- WRITE-OWNERSHIP SPLIT (the same seam contract 0012's header states, with
-- no new channel — apps/server writes rows and columns, apps/worker reads
-- and answers; there is no IPC between them):
--   active_rung_index    worker-written at EVERY spawn (run 0 records the
--                        plan's own top rung; a handoff records the rung it
--                        just handed the slot to). Server-read.
--   pending_rung_index   server-written (requestRungSwitch), worker-consumed
--                        under compare-and-clear. Absorb-on-match at the
--                        WRITE side: a request naming the already-active
--                        rung is never recorded, which is the switch
--                        analogue of seek absorption and kills request
--                        storms at the door rather than at the poll tick.
--   ladder_rung_index    worker-written once per spawned run, alongside
--                        start_segment/source_origin_ms.
--
-- WHY NULLABLE, AND WHY THAT IS NOT A "MAYBE" COLUMN: NULL means "no rung
-- applies", a real and common state — direct-play sessions run no pipeline
-- at all, ladder-empty sessions (direct-stream copy, audio-only transcode)
-- have no rung to name, and every pre-C2 row predates the concept. A
-- consumer must read NULL as "not applicable", never as rung 0: rung 0 is
-- the TOP of the ladder and the rung a session normally starts on, so
-- conflating the two would silently claim every legacy row was serving top
-- quality.
--
-- REAL COLUMNS, NOT JSONB, for the same reason 0012's control columns are:
-- CLAUDE.md invariant 3 whitelists JSONB for ffprobe output, event payloads,
-- serialized plans, item_attributes values, device capability profiles, user
-- settings prefs, server_settings.value and plugin manifest/config. This is
-- none of those — it is a control channel two processes poll.
--
-- NO INDEX. Every read here is by primary key (the worker polls its own
-- session row; the server resolves one session it already authorized), so
-- an index would cost writes on the hottest table in the playback path and
-- buy nothing. `transcode_runs.ladder_rung_index` is likewise never a
-- lookup key — the existing (session_id, start_segment DESC) index answers
-- the only question that table is asked.

ALTER TABLE playback_sessions ADD COLUMN active_rung_index INTEGER;
ALTER TABLE playback_sessions ADD COLUMN pending_rung_index INTEGER;

COMMENT ON COLUMN playback_sessions.active_rung_index IS
  'Index into the stored plan''s `ladder` of the rung the live ffmpeg run '
  'is currently encoding (docs/PLAYBACK.md §9.1.3). Worker-written at every '
  'spawn — run 0 writes the plan''s own top rung, a §9.1.4 slot handoff '
  'writes the rung it handed the slot to — so the row always names what is '
  'really running. Server-read: a `v{K}` GET whose K differs from this is '
  'the ABR switch signal. NULL for direct-play, ladder-empty and pre-C2 '
  'sessions; NULL means "no rung applies", NEVER rung 0.';

COMMENT ON COLUMN playback_sessions.pending_rung_index IS
  'A requested rung switch awaiting the worker''s next poll tick (docs/'
  'PLAYBACK.md §9.1.3). Server-written by requestRungSwitch, validated '
  '0 <= K < ladder.length at the controller and absorbed at the WRITE side '
  'when it names the already-active rung. Worker-consumed under the same '
  'compare-and-clear discipline as seek_target_ms: the UPDATE is guarded on '
  'the exact value read, so a different rung written in between survives to '
  'the next tick instead of being swallowed. A PURE switch never changes '
  '`status` and never bumps `discontinuity_count` — the union playlist stays '
  'fully servable across a handoff, and its discontinuities come from run '
  'folding, not from this channel.';

ALTER TABLE transcode_runs ADD COLUMN ladder_rung_index INTEGER;

COMMENT ON COLUMN transcode_runs.ladder_rung_index IS
  'Which rung of the stored plan''s ladder this run encoded, at spawn time '
  '(docs/PLAYBACK.md §9.1.3). Bookkeeping only — the boot reaper never '
  'reads it, and segment ownership still follows start_segment alone, '
  'which stays correct under ABR precisely because this delivery model '
  'never runs two rungs in parallel. NULL for pre-C2 rows and ladder-empty '
  'sessions.';

-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0045_playback_session_served_watermark
--
-- Additive-only (mirrors 0002/.../0044's discipline): one new nullable
-- column, no drops, no type narrowing, no rewriting of prior migrations,
-- no contract surface.
--
-- WHY (QA backlog #104, d4-f2). Migration 0012 gave the worker/server seam
-- one column for "where is the client": `requested_segment`, written by
-- apps/server on EVERY segment GET. That is the right input for the
-- segment-ahead throttle — a request is DEMAND, and demand is exactly what
-- should un-throttle a stopped encoder, whether or not it can be answered.
-- It is the wrong input for the two consumers that ask a DIFFERENT
-- question: "how far has this client actually got?"
--
--   * apps/server's backward-jump gate (hls-file.controller.ts, gap-F6
--     round 3 / d3-f2) treats an ENOENT index far below the session's
--     progression as a real backward seek. Because `requested_segment`
--     records 503'd and speculative far-ahead requests verbatim, a routine
--     forward probe inside the live window raised the baseline, and the
--     client's OWN next fragment — pruned out from under it — then read as
--     a backward jump and restarted the run. The same column also PINS
--     itself: a 503 writes the index it just refused, so a retry sits
--     inside the backward-jump hysteresis of itself.
--   * apps/worker's retention prune floor (d3-f1: never delete a segment
--     the viewer has not reached) had to reconstruct progression from the
--     same column, and could only approximate it — "trust it while it is
--     at or below the produced edge" — which still let a speculative index
--     that happened to be below the produced edge authorise deleting
--     everything under it.
--
-- WHAT THIS COLUMN IS. The highest segment index this session has ever
-- actually SERVED to the client, i.e. answered with a 200 and a real file
-- body. Monotonic by construction (the write is a GREATEST), server-written
-- on the success path only, worker-read. NULL means "this session has never
-- served a segment", which is a real and common state (a client that has
-- only ever 503'd), never "index 0".
--
-- WHY NOT REUSE `requested_segment`. The two columns answer different
-- questions and both answers are needed at once: the throttle must see a
-- far-ahead request (it is the signal that the client wants more), while
-- retention and the seek gate must not. Narrowing `requested_segment` to
-- 200s would silently break the throttle's un-suspend path (docs/
-- PLAYBACK.md §9 "Lead arithmetic"); widening the prune floor to demand
-- would reopen d3-f1. Two columns, two write rules, both cheap.
--
-- REAL COLUMN, NOT JSONB, for the same reason 0012's control columns are:
-- CLAUDE.md invariant 3 whitelists JSONB for ffprobe output, event
-- payloads, serialized plans, item_attributes values, device capability
-- profiles, user settings prefs, server_settings.value and plugin
-- manifest/config. This is none of those — it is a control-channel scalar
-- two processes poll.
--
-- NO INDEX. Every read is by primary key (the worker polls its own session
-- row; the server resolves one session it already authorized), so an index
-- would cost writes on the hottest table in the playback path and buy
-- nothing.

ALTER TABLE playback_sessions ADD COLUMN highest_served_segment INTEGER;

COMMENT ON COLUMN playback_sessions.highest_served_segment IS
  'The highest HLS segment index this session has ever SERVED (answered '
  '200 with a real file body) — d4-f2. Server-written on the success path '
  'of GET /playback/sessions/{id}/hls/{file} only, under a GREATEST so it '
  'is monotonic: an out-of-order or repeated fetch never moves it '
  'backward. Worker-read as the retention prune floor (apps/worker/src/'
  'transcode/playlist.ts pruneRetention''s viewer floor, d3-f1) and '
  'server-read as the backward-jump gate''s progression baseline '
  '(hls-file.controller.ts). Deliberately NOT the same column as '
  'requested_segment: that one records DEMAND (every GET, including 503''d '
  'and far-ahead ones) because the segment-ahead throttle must react to '
  'demand, while these two consumers must react to PROGRESS. NULL means '
  '"never served a segment", never index 0.';
