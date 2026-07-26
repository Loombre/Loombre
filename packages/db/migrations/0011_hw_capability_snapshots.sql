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
