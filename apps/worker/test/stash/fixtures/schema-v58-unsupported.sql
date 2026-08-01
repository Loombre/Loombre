-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: apps/worker/test/stash/fixtures/schema-v58-unsupported.sql
--
-- S3's disable-path fixture: a schema_migrations version BELOW
-- STASH_SUPPORTED_SCHEMA_MIN (67, guard.ts) — 58 corresponds to Stash
-- v0.26.0 (2024-06-03), the release line immediately before the pinned
-- range begins (see README.md's release-history table). Deliberately
-- minimal: the guard reads schema_migrations and disables BEFORE ever
-- attempting to read scenes/performers/etc (S3: "never best-effort
-- parsing"), so no other table needs to exist for this fixture to prove
-- the disable path — an out-of-range database is never queried beyond
-- its version.

CREATE TABLE schema_migrations (version uint64, dirty bool);
CREATE UNIQUE INDEX version_unique ON schema_migrations (version);
INSERT INTO schema_migrations (version, dirty) VALUES (58, 0);
