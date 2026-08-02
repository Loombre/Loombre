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
