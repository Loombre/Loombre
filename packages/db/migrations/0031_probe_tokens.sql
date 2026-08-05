-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0031_probe_tokens
--
-- Additive-only (mirrors 0001/.../0030's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
-- reachability proof + posture card" (R6/RG6, Lane P1). Drift decision #2
-- (orchestrator freeze, "Orchestrator freeze ground-truth + Batch-1
-- dispatch") reserved this number for P1 after WG1/WG2 took 0029/0030.
--
-- The one-time-token reachability proof (R6): the admin mints a probe
-- token bound to a specific expected public endpoint and remote-access
-- path; a phone ON CELLULAR (no prior credentials, RG6) visits
-- `https://<expectedEndpoint>/probe/<token>` to prove the path is
-- actually reachable from the outside. RG6's house pattern M3 EXACTLY:
-- `randomBytes(32).toString("base64url")` minted once by
-- apps/server/src/remote/remote-probes.controller.ts, SHA-256 hex hash
-- stored here, DB equality lookup (constant-time by construction — never
-- a string compare of a secret) — the SAME posture password_reset_tokens/
-- user_invites/refresh_tokens all share (see 0024_password_recovery.sql's
-- header). This module never sees a plaintext token, only its hash.

-- ============================================================================
-- remote_probe_path — real PG enum (house style: notice_severity/
-- device_kind/item_type/... all use CREATE TYPE for a closed SCALAR value
-- set). Deliberately narrower than the contract's RemotePathId (which adds
-- 'none' for the DERIVED "nothing enabled yet" state, RG15/wizard-state.ts's
-- own PathId comment) — a probe is always minted FOR one specific path's
-- setup flow; "prove path none is reachable" is not a legal request
-- (apps/server/src/remote/remote-probes.controller.ts 422s it before this
-- column is ever reached).
-- ============================================================================

CREATE TYPE remote_probe_path AS ENUM ('remote', 'tunnel', 'direct');

-- ============================================================================
-- probe_tokens
-- ============================================================================

CREATE TABLE probe_tokens (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  token_hash        TEXT NOT NULL UNIQUE,
  expected_endpoint TEXT NOT NULL,
  path              remote_probe_path NOT NULL,
  created_by        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms     BIGINT NOT NULL,
  expires_at_ms     BIGINT NOT NULL,
  arrived_at_ms     BIGINT NULL
);

COMMENT ON TABLE probe_tokens IS
  'R6/RG6: one-time reachability-proof tokens. token_hash lookup is the '
  'ONLY read path GET /probe/{token} (apps/server/src/remote/probe-page.'
  'controller.ts) ever uses — constant-time by construction (a DB equality '
  'lookup on a hash, never a string compare of a secret). Single-use, '
  'enforced by the SAME atomic ''UPDATE ... WHERE arrived_at_ms IS NULL '
  'AND expires_at_ms > $now RETURNING *'' compare-and-swap shape '
  'password_reset_tokens/user_invites both already rely on for exactly '
  'this race (packages/db/src/query/remote-probes.ts consumeProbeTokenAndEmit) '
  '— Postgres''s row-level locking on that single-row UPDATE is the ''row '
  'lock'' proving single-use under concurrent first-visits, no advisory '
  'lock needed (unlike system_notices'' multi-row supersede-then-insert, '
  'this is a compare-and-swap on ONE row). 15-minute expiry (R6) set by '
  'the controller at mint time, not this table.';

COMMENT ON COLUMN probe_tokens.token_hash IS
  'sha256(randomBytes(32).toString("base64url")) hex — RG6''s house pattern '
  'M3 EXACTLY, same posture as refresh_tokens.token_hash/'
  'password_reset_tokens.token_hash. The raw token is minted by '
  'apps/server/src/remote/remote-probes.controller.ts, appears ONCE in '
  'POST /admin/remote/probes''s 201 response (embedded in probeUrl/'
  'qrPayload), and is never persisted anywhere — this column is the only '
  'trace of it, and it cannot be reversed back to the plaintext.';

COMMENT ON COLUMN probe_tokens.expected_endpoint IS
  'The public endpoint (bare host[:port], no scheme) the proof is bound '
  'to — embedded verbatim into probeUrl as '
  '`https://<expected_endpoint>/probe/<token>`. Also fed to node:dns '
  '(apps/server/src/remote/remote-dns-resolver.service.ts) when a failed '
  'probe needs classifying (R5/RG11).';

COMMENT ON COLUMN probe_tokens.path IS
  'Which remote-access path (Remote/Tunnel/Direct) this probe is proving '
  '(P1 adjudication — see packages/contract/openapi.yaml''s '
  'CreateRemoteProbeRequest description). Threaded through to '
  'diagnoseReachability so the Tunnel-path connector-health short-circuit '
  '(the freeze''s own diagnosis note) only ever fires for path=''tunnel'', '
  'and so the per-path guidance mapping (packages/shared/src/remote/'
  'diagnosis-guidance.ts) can render path-specific copy once a probe '
  'never arrives.';

COMMENT ON COLUMN probe_tokens.created_by IS
  'The admin who minted this probe. ON DELETE SET NULL (audit-actor '
  'column pattern — events.actor_user_id/system_notices.created_by '
  'precedent): deleting an admin later must not erase probe history, only '
  'sever the specific-user link. NOT NULL is enforced by the query layer '
  'at insert time, matching every other nullable-but-app-enforced-not-null '
  'audit-actor column in this schema.';

COMMENT ON COLUMN probe_tokens.arrived_at_ms IS
  'NULL until GET /probe/{token} consumes this token from a real external '
  'request (probe.arrived, admin-only, no token in the payload — R9). '
  'Set exactly once — the atomic consume UPDATE''s WHERE clause '
  '(arrived_at_ms IS NULL) makes a second arrival for the same token '
  'impossible by construction, so this column doubles as the single-use '
  'flag: NULL = still live, non-NULL = spent. GET /admin/remote/probes/'
  '{id}''s poll status is DERIVED from this column plus expires_at_ms '
  '(packages/db/src/query/remote-probes.ts), never stored separately.';
