// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-probes.ts
//
// Loombre Remote's one-time-token reachability proof (STATE.md "Loombre
// Remote — embedded WireGuard + three-path wizard + reachability proof +
// posture card", R6/RG6, Lane P1), migrations/0031_probe_tokens.sql.
// probe_tokens CRUD-plus-consume, the SAME reasoning src/query/invites.ts
// and src/query/password-reset.ts each carry at length: this lives in the
// PUBLIC barrel (src/index.ts), not @loombre/db/internal, because
// probe_tokens is instance-administration data (mint/poll authorized by
// `isAdmin`, checked at the apps/server controller layer via
// requireAdmin/requireLiveAdmin) or by presenting a valid single-use token
// with NO authentication at all (consumeProbeTokenAndEmit — the arrival
// side, an unauthenticated external phone request by design, R6/R9) —
// NEITHER shape is a ViewerContext-guarded catalog read.
//
// Token handling: this module only ever sees `tokenHash` (SHA-256 hex).
// Generating the raw token and hashing it is apps/server's job
// (apps/server/src/remote/remote-probes.controller.ts, RG6's house
// pattern M3: `randomBytes(32).toString("base64url")` then sha256 hex —
// the SAME posture password_reset_tokens/refresh_tokens/user_invites all
// share). No function here ever receives or returns a raw token.
//
// All timestamps arrive as an explicit `nowMs`/`*AtMs` argument — this
// module never calls Date.now() itself (house style; every other query
// module in this package follows the same rule, see src/query/notices.ts's
// header).

import type { Kysely, Selectable, Transaction } from 'kysely';
import type { DB, ProbeTokensTable, RemoteProbePath } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export type ProbeTokenRow = Selectable<ProbeTokensTable>;
export type { RemoteProbePath };

// ============================================================================
// mintProbeToken (POST /admin/remote/probes)
// ============================================================================

export interface MintProbeTokenInput {
  tokenHash: string;
  expectedEndpoint: string;
  path: RemoteProbePath;
  /** NOT NULL at insert (audit-actor pattern — same convention system_
   *  notices.created_by/user_invites.created_by use), enforced here by the
   *  TypeScript type; the column itself stays nullable (ON DELETE SET
   *  NULL — see the migration's own COMMENT). */
  createdBy: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/**
 * Plain insert — no transaction/outbox event needed here (unlike
 * publishNoticeAndEmit/createInviteAndEmit): minting a probe has no R9
 * event of its own (the 9-event Wave-0 freeze list has only
 * `probe.arrived`, the ARRIVAL side below — a mint is an ordinary admin
 * action, not something every admin session needs broadcast).
 */
export async function mintProbeToken(db: Kysely<DB>, input: MintProbeTokenInput): Promise<ProbeTokenRow> {
  return db
    .insertInto('probe_tokens')
    .values({
      token_hash: input.tokenHash,
      expected_endpoint: input.expectedEndpoint,
      path: input.path,
      created_by: input.createdBy,
      created_at_ms: input.createdAtMs,
      expires_at_ms: input.expiresAtMs,
      arrived_at_ms: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ============================================================================
// getProbeTokenById (GET /admin/remote/probes/{id})
// ============================================================================

export async function getProbeTokenById(db: Kysely<DB>, id: string): Promise<ProbeTokenRow | undefined> {
  return db.selectFrom('probe_tokens').selectAll().where('id', '=', id).executeTakeFirst();
}

// ============================================================================
// status derivation (GET /admin/remote/probes/{id}'s poll shape)
// ============================================================================

export type ProbeStatus = 'pending' | 'arrived' | 'expired';

/** Derives the wire `status` (never stored — same derive-don't-store rule
 *  src/query/notices.ts's deriveNoticeStatus/src/query/invites.ts's
 *  deriveInviteStatus establish for their own rows). Arrived wins over
 *  expired in the check order: a token that arrived in its final second
 *  is a success, not a race against its own expiry. */
export function deriveProbeStatus(row: { arrivedAtMs: number | null; expiresAtMs: number }, nowMs: number): ProbeStatus {
  if (row.arrivedAtMs !== null) return 'arrived';
  if (row.expiresAtMs <= nowMs) return 'expired';
  return 'pending';
}

// ============================================================================
// consumeProbeTokenAndEmit (GET /probe/{token} — the public arrival side)
// ============================================================================

export type ConsumeProbeTokenResult = { ok: true; row: ProbeTokenRow } | { ok: false };

export interface ConsumeProbeTokenInput {
  tokenHash: string;
  nowMs: number;
}

/**
 * The atomic single-use consume (R6/RG6): `UPDATE probe_tokens SET
 * arrived_at_ms = $now WHERE token_hash = $hash AND arrived_at_ms IS NULL
 * AND expires_at_ms > $now RETURNING *`. A compare-and-swap identical in
 * shape to src/query/password-reset.ts's resetPasswordViaTokenAndEmit and
 * src/query/invites.ts's claim consume: when two requests race the SAME
 * token, Postgres's row-level locking on this single-row UPDATE serializes
 * them — exactly one matches (the loser's WHERE re-evaluates against the
 * winner's already-committed arrived_at_ms and matches zero rows) — this
 * IS the "row lock" proving single-use under concurrency, no
 * pg_advisory_xact_lock needed (unlike src/query/notices.ts's
 * publish/cancel, which is a multi-row supersede-then-insert, not a CAS on
 * one row). A missing, already-arrived, or expired token all collapse to
 * the SAME `{ok:false}` (no branch distinguishes them) — the controller
 * turns that into the byte-identical enumeration-resistant 404 either way
 * (R6/R9: invalid/expired/already-consumed/unknown tokens are
 * indistinguishable from the outside).
 *
 * Emits `probe.arrived` (admin-only, R9: no token/hash/expectedEndpoint in
 * the payload — `probeId` alone correlates against GET /admin/remote/
 * probes/{id}) in the SAME transaction as the consume, actorUserId null
 * (this is an unauthenticated external request — there is no acting user
 * to attribute it to, unlike every other outbox event in this package).
 */
export async function consumeProbeTokenAndEmit(
  db: Kysely<DB>,
  input: ConsumeProbeTokenInput,
): Promise<ConsumeProbeTokenResult> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const row = await trx
      .updateTable('probe_tokens')
      .set({ arrived_at_ms: input.nowMs })
      .where('token_hash', '=', input.tokenHash)
      .where('arrived_at_ms', 'is', null)
      .where('expires_at_ms', '>', input.nowMs)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      return { ok: false };
    }

    await writeEvent(trx, {
      type: 'probe.arrived',
      tsMs: input.nowMs,
      actorUserId: null,
      payload: { probeId: row.id, arrivedAtMs: input.nowMs },
    });

    return { ok: true, row };
  });
}
