-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0028_system_notices
--
-- Additive-only (mirrors 0001/.../0027's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Admin broadcast notifications: restart warnings, maintenance, custom
-- notices" (STATE.md, kicked off 2026-08-04), Lane A (server side). N1
-- (locked decision): a single additive `system_notices` table — ONE active
-- notice at a time in v1, composing a new one REPLACES the active one
-- (packages/db/src/query/notices.ts's publishNoticeAndEmit does the
-- cancel-then-insert in one transaction; no stacking, no queue). NG4/NG8
-- (orchestrator recon adjudications) resolve this migration's one
-- ambiguity and its audit posture — both cited inline below.

-- ============================================================================
-- notice_severity — real PG enum (house style: item_type/content_class/
-- watch_state/stash_sync_report_status/... all use CREATE TYPE for a closed
-- SCALAR value set; migrations/0011_hw_capability_snapshots.sql's TEXT[]
-- CHECK columns are the documented exception for ARRAY-typed columns only,
-- which does not apply here).
-- ============================================================================

CREATE TYPE notice_severity AS ENUM ('info', 'warning', 'critical');

-- ============================================================================
-- system_notices
-- ============================================================================

CREATE TABLE system_notices (
  id               UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  message          TEXT NOT NULL CHECK (char_length(message) <= 500),
  severity         notice_severity NOT NULL,
  effective_at_ms  BIGINT NULL,
  expires_at_ms    BIGINT NULL,
  created_by       UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms    BIGINT NOT NULL,
  cancelled_at_ms  BIGINT NULL,
  -- NG4: NULL expires_at_ms means "until cancelled", legal ONLY for
  -- 'critical' (N1's "critical until cancelled" — a far-future sentinel
  -- would be dishonest data). info/warning always carry a real
  -- expires_at_ms — info defaults to now+1h and warning REQUIRES a
  -- composer-set expiry (422 when absent), both enforced by the
  -- apps/server controller, not this CHECK; this CHECK only forbids the
  -- ONE combination that can never be correct at the storage layer.
  CHECK (severity = 'critical' OR expires_at_ms IS NOT NULL)
);

COMMENT ON TABLE system_notices IS
  'N1: an admin-broadcast notice shown to every user (info/warning/'
  'critical). ACTIVE is DERIVED, never stored (the same derive-dont-store '
  'rule packages/db/src/query/invites.ts establishes for invite status): '
  '`cancelled_at_ms IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > '
  'now)` -- see packages/db/src/query/notices.ts getActiveNotice/'
  'listNoticesAdmin. Only ONE notice is active at a time in v1: publishing '
  'a new one cancels whichever row is currently active in the SAME '
  'transaction as the insert (publishNoticeAndEmit) -- a notice channel '
  'that stacks becomes noise (N1). Audit IS the broadcast (NG8): publish/'
  'cancel each emit exactly one all-user outbox event (notice.published / '
  'notice.cancelled, packages/contract/event-schemas/) carrying the '
  'acting admin as the envelope actorUserId -- there is no separate '
  'admin-only audit event, and REPLACING the active notice emits ONLY '
  'notice.published for the new row, never a notice.cancelled for the '
  'superseded one (clients hold one notice and replace by design; a '
  'client that misses the supersession reconciles via GET /notices/'
  'active). History reads this table directly, not the events outbox.';

COMMENT ON COLUMN system_notices.message IS
  'Plain text only, no markup in v1 (N1) -- capped at 500 chars by the '
  'CHECK above AND by the contract maxLength:500 (defense in depth); '
  'clients render it as plain text nodes only, never HTML (N6/NG10).';

COMMENT ON COLUMN system_notices.effective_at_ms IS
  'The countdown target ("restarting AT this time"), NULL when the '
  'notice carries no scheduled moment. Set from the publish request '
  'RELATIVE effectiveInMs, anchored to the SERVER own clock at publish '
  'time (NG5: "durations in, absolutes out" -- compose-time clock skew '
  'is impossible by construction). The notice system never itself '
  'restarts anything -- this is communication only (N4).';

COMMENT ON COLUMN system_notices.expires_at_ms IS
  'When this notice stops being active, absolute ms. NULL = "until '
  'cancelled", legal ONLY for severity=''critical'' -- see this table CHECK '
  'and NG4. Derived from the publish request RELATIVE expiresInMs the '
  'same way effective_at_ms is (NG5); severity-specific defaults (info '
  'absent -> now+3_600_000; warning absent -> 422) are applied by the '
  'apps/server controller before the insert, not by this column.';

COMMENT ON COLUMN system_notices.created_by IS
  'The admin who published this notice. ON DELETE SET NULL (audit-actor '
  'column pattern -- events.actor_user_id/server_settings.updated_by '
  'precedent, NOT user_invites.created_by ON DELETE CASCADE): deleting '
  'an admin later must not erase notice history, only sever the '
  'specific-user link (NG8). NOT NULL is enforced by the query layer at '
  'insert time (packages/db/src/query/notices.ts publishNoticeAndEmit), '
  'not by a SQL constraint here -- matching server_settings.updated_by '
  'own nullable-column-but-app-enforced-not-null posture for the '
  'identical audit-actor reason.';

COMMENT ON COLUMN system_notices.cancelled_at_ms IS
  'Set by an explicit admin cancel (POST /system/notices/{id}/cancel) '
  'OR implicitly by a later publish superseding this row (both go '
  'through packages/db/src/query/notices.ts). NULL = never cancelled; '
  'combined with expires_at_ms this is the ACTIVE predicate this '
  'table own COMMENT documents.';
