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
