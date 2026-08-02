-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0023_user_invites
--
-- Additive-only (mirrors 0002/.../0022's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations. One exception that is
-- still additive in spirit — DROP NOT NULL below is a LOOSENING, never a
-- narrowing (M1).
--
-- "Optional mail transport + invitation & reset flows that work without
-- it" (STATE.md, kicked off 2026-08-01), Lane A: E2 (invitations) + E4/M1/M2
-- (optional email + real display_name storage). Pre-assigned this migration
-- number (M5, to avoid parallel-lane collisions with Lane B's 0024).
--
-- ============================================================================
-- users.email loosens to optional (M1)
-- ============================================================================
--
-- Reality check at kickoff: users.email was CITEXT NOT NULL UNIQUE
-- (0001_init.sql) and a live login identifier (getUserByEmail). E4's
-- "optional email" therefore reads onto this table as a LOOSENING, not a
-- new column: DROP NOT NULL only. CITEXT + UNIQUE are UNCHANGED — Postgres
-- treats NULLs as mutually distinct under a UNIQUE constraint (no
-- NULLS NOT DISTINCT clause here, deliberately), so any number of
-- email-less users may coexist without a conflict. Every insert/read path
-- that touches users.email is updated in this Lane A wave to treat the
-- column as nullable: createUserAdmin/createUserAdminAndEmit,
-- createFirstAdminIfEmpty/insertUserAndEmit (unchanged — FirstAdminRequest
-- keeps requiring email; first-boot bootstrap is out of scope for the
-- loosening), getUserByEmail (a `column = $literal` comparison already
-- never matches a NULL row — verified, no code change needed there, see
-- packages/db/src/query/identity.ts's getUserByEmail doc comment), login
-- (already resolves by username OR email; an email-less user simply always
-- authenticates by username — no code change needed), the data-freedom
-- export/import round trip, and the users seed data.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN users.email IS
  'Optional login identifier (E4/M1: an additive LOOSENING of the original '
  'CITEXT NOT NULL UNIQUE column, not a new one — CITEXT + UNIQUE are '
  'unchanged). NULL = no email on file; Postgres treats NULLs as mutually '
  'distinct under the UNIQUE constraint, so any number of email-less users '
  'may coexist. A user with no email logs in by username only.';

-- ============================================================================
-- users.display_name — a real column at last (M2, the H1 bug class)
-- ============================================================================
--
-- packages/contract/openapi.yaml's User.displayName has been declared since
-- before this migration, and the web profile form / AddUserSheet have
-- always SUBMITTED it — but no column existed to persist it, so the value
-- was silently discarded while the UI reported "Saved" (the H1 bug class,
-- STATE.md). packages/db/src/query/admin.ts's module header documented
-- this gap explicitly; this migration closes it.

ALTER TABLE users ADD COLUMN display_name TEXT NULL;

COMMENT ON COLUMN users.display_name IS
  'Free-form display name (M2), settable by the user (PATCH /users/me) or '
  'an admin (PATCH /users/{id}) and preset-able at invite creation '
  '(user_invites.display_name_preset below). NULL = unset; callers fall '
  'back to username for display.';

-- ============================================================================
-- user_invites (E2, M3 token posture, M4 no-role-no-restricted-grant)
-- ============================================================================

CREATE TABLE user_invites (
  id                   UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  token_hash           TEXT NOT NULL UNIQUE,
  created_by           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_ms        BIGINT NOT NULL,
  expires_at_ms        BIGINT NOT NULL,
  username_preset      CITEXT NULL,
  display_name_preset  TEXT NULL,
  email                CITEXT NULL,
  claimed_at_ms        BIGINT NULL,
  claimed_user_id      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at_ms        BIGINT NULL
);

COMMENT ON TABLE user_invites IS
  'E2: a one-time, expiring invite link an admin creates to provision a new '
  'user through a self-serve claim flow. `status` (pending/claimed/revoked/'
  'expired) is DERIVED at read time from claimed_at_ms/revoked_at_ms/'
  'expires_at_ms, never stored — see packages/db/src/query/invites.ts. No '
  'role/admin field exists anywhere on this table (M4): escalation via an '
  'intercepted invite link is impossible by construction, not by '
  'validation — grants are library_permissions rows only, via '
  'user_invite_grants below, and restricted-class libraries are rejected '
  'both at invite creation and re-checked at claim time (defense in '
  'depth).';

COMMENT ON COLUMN user_invites.token_hash IS
  'SHA-256 hex of the raw invite token (M3: the refresh-token posture '
  'EXACTLY — packages/db/src/query/identity.ts''s refresh_tokens.token_hash '
  'is the template, DB-equality lookup, no argon2id on an unauthenticated '
  'route). The raw token is returned exactly once, in POST /invites''s own '
  'response, and is never stored anywhere in plaintext.';

COMMENT ON COLUMN user_invites.created_by IS
  'The admin who created this invite (ON DELETE CASCADE, matching the '
  'house convention for every other NOT NULL users(id) FK — refresh_tokens.'
  'user_id, devices.user_id, library_permissions.user_id — rather than the '
  'nullable audit-actor convention events.actor_user_id/server_settings.'
  'updated_by use, since this column is NOT NULL by design, M5 brief).';

COMMENT ON COLUMN user_invites.username_preset IS
  'Admin-set username suggestion. When present it is AUTHORITATIVE at '
  'claim time (preset wins over anything the claiming client submits) — '
  'see claimInviteAndEmit''s username-resolution order.';

COMMENT ON COLUMN user_invites.email IS
  'Send-to address AND claim-time email preset (E2 body.email). The '
  'claiming client''s own submitted email, when present, wins over this '
  'preset (defaults-to-invite-email semantics, distinct from '
  'username_preset''s preset-always-wins rule) — see the claim endpoint.';

COMMENT ON COLUMN user_invites.claimed_user_id IS
  'The user row this invite produced, once claimed. ON DELETE SET NULL '
  '(not CASCADE): deleting the claimed user later must not erase the fact '
  'that this invite WAS claimed (claimed_at_ms stays set) — only the '
  'specific-user link is severed, mirroring events.actor_user_id''s own '
  'ON DELETE SET NULL rationale for the same reason.';

COMMENT ON COLUMN user_invites.revoked_at_ms IS
  'Admin-initiated revocation timestamp (DELETE /invites/{id}). Revoking '
  'an already-claimed or already-revoked invite is rejected (404, see the '
  'revokeInvite endpoint) rather than silently no-opping — revoking a '
  'claimed invite has no invite-side effect (the user already exists), so '
  'the 404 signals "nothing left to revoke" honestly.';

-- ============================================================================
-- user_invite_grants (real FKs, no JSONB — CLAUDE.md invariant 3)
-- ============================================================================

CREATE TABLE user_invite_grants (
  invite_id  UUID NOT NULL REFERENCES user_invites(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (invite_id, library_id)
);

COMMENT ON TABLE user_invite_grants IS
  'The library_permissions rows a successful claim will create (M4: '
  'general-class libraries only — rejected at invite creation for any '
  'restricted-class library id, and RE-CHECKED at claim time in case a '
  'library''s content_class changed after the invite was created).';
