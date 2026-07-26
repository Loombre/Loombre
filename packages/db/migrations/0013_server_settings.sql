-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0013_server_settings
--
-- Additive-only (mirrors 0002/.../0012's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md Addendum A (post-Phase-4), decision A4: persistence for the
-- admin-configurable settings registry (packages/shared/src/
-- settings-registry.ts). One row per REGISTRY KEY, never one row per
-- setting "category" or a single blob row — this is what lets a single
-- key be read/written/audited independently and lets an unrecognized
-- leftover row be detected without parsing anything.
--
-- `value JSONB NOT NULL` — every setting's value, whatever shape its own
-- zod schema declares (boolean/number/string/array/object). Addendum
-- decision AD5: this column joins the JSONB whitelist CLAUDE.md invariant 3
-- names (ffprobe output, event payloads, serialized plans, item_attributes
-- values, device capability profiles, user settings prefs) as its 7th
-- entry — CLAUDE.md is updated in this same lane's commit.
--
-- `updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL` — NULL
-- (not a FK violation) if the acting admin's account is later deleted,
-- matching `events.actor_user_id`'s exact same ON DELETE SET NULL
-- convention (migrations/0001_init.sql) — an audit trail must survive the
-- actor's own account being removed.
--
-- Deliberately NO `content_class`/restricted-content columns and NO
-- ViewerContext-guarded read path (packages/db/src/query/settings.ts's own
-- header): server settings are instance facts, not viewer-scoped catalog
-- data, the same P1.14 precedent identity.ts's users/user_settings/
-- devices tables already establish. Authorization (admin-only) is enforced
-- at the apps/server API layer, re-verified live against `users.is_admin`
-- on every mutation (A10) rather than trusted from a cached role.
--
-- Only registry keys are ever meant to be written here (enforced by the
-- SERVICE layer, apps/server/src/settings/ — this table has no CHECK
-- constraint enumerating valid keys, deliberately: the registry is a
-- TypeScript source of truth that evolves without a migration every time a
-- setting is added, and a stray row for a since-removed/renamed key must
-- be READABLE so it can be reported, never silently un-selectable).

CREATE TABLE server_settings (
  key            TEXT PRIMARY KEY,
  value          JSONB NOT NULL,
  updated_at_ms  BIGINT NOT NULL,
  updated_by     UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE server_settings IS
  'Addendum A (STATE.md, admin-configurable server settings): one row per '
  'packages/shared/src/settings-registry.ts key with a DB-persisted value. '
  'Absence of a row for a known key is normal and means "use the registry '
  'default" (or the env-pinned value, which always outranks this table '
  'regardless of what is stored here) — see settings-resolve.ts''s '
  'resolveEffectiveSettings for the full env > database > default '
  'precedence. A row for a key NOT in the current registry (renamed, '
  'removed, or a typo from manual SQL) is preserved as-is, never dropped, '
  'and reported at boot (A4) rather than silently ignored.';

COMMENT ON COLUMN server_settings.value IS
  'JSONB — shape is whatever the matching registry entry''s zod schema '
  'declares (boolean/number/string/array/object). CLAUDE.md invariant 3 '
  'JSONB whitelist entry 7 (AD5).';

COMMENT ON COLUMN server_settings.updated_by IS
  'The admin user who last wrote this row, re-verified live (A10) at '
  'mutation time — NULL if that account has since been deleted.';
