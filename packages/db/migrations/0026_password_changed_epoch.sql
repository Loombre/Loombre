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
