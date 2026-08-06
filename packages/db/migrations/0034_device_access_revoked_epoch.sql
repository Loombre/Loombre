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
