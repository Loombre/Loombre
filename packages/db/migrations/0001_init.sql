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
  'Cached device capability profile (codecs, containers, HDR support): the '
  'input to PlaybackPlan. Refreshed on login.';

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
