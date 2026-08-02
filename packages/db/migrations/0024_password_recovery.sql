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
