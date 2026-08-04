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
