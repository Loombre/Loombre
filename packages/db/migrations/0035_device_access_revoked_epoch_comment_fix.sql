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
