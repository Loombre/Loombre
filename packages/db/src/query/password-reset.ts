// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/password-reset.ts
//
// Self-service password recovery, email tier (E3b/M15, STATE.md "Optional
// mail transport + invitation & reset flows"). `password_reset_tokens`
// mirrors refresh_tokens' posture (M3): the plaintext token is a 256-bit
// randomBytes(32) base64url string minted by the caller
// (apps/server/src/session/reset-token.ts), never persisted — only its
// SHA-256 hex hash lives here. This module never sees a plaintext token or
// a plaintext password; both are hashed by the caller before reaching it
// (same "this package never hashes a plaintext secret itself" posture as
// src/query/identity.ts's resetUserPasswordAndEmit).
//
// Lives in the public barrel (src/index.ts), not @loombre/db/internal, for
// the SAME two reasons src/query/identity.ts's header gives: this is
// auth-adjacent identity plumbing (a caller has no ViewerContext yet — it
// is trying to recover the ability to get one), not a catalog_items read,
// and dependency-cruiser's "no-internal-db-outside-worker" rule forbids
// apps/server from reaching into @loombre/db/internal at all.

import type { Kysely, Selectable, Transaction } from 'kysely';
import type { DB, PasswordResetTokensTable } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { getUserById, revokeAllRefreshTokensForUser } from './identity.js';

export type PasswordResetTokenRow = Selectable<PasswordResetTokensTable>;

/**
 * Marks every still-unused `password_reset_tokens` row for `userId` as
 * used (see the migration's COMMENT ON COLUMN for why "used" and
 * "superseded by a newer request" share one column). Exported standalone
 * (not just inlined into issuePasswordResetToken below) for two callers:
 * that function's own invalidate-before-insert step, AND
 * apps/server/src/session/auth.controller.ts's forgotPassword() anti-
 * timing "unknown identifier" branch (E8) — which calls this with a
 * random, non-existent userId so the UNKNOWN-account path pays for a real
 * UPDATE of the same shape/cost as the KNOWN-account path, without being
 * able to INSERT a fabricated token row (password_reset_tokens.user_id is
 * an FK to users(id) — there is no legal row to fake).
 */
export async function invalidateUnusedPasswordResetTokens(
  db: Kysely<DB>,
  userId: string,
  nowMs: number
): Promise<void> {
  await db
    .updateTable('password_reset_tokens')
    .set({ used_at_ms: nowMs })
    .where('user_id', '=', userId)
    .where('used_at_ms', 'is', null)
    .execute();
}

export interface IssuePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/**
 * F10 (opus adversarial review, fix wave): opportunistic cleanup of this
 * user's own already-dead rows — used (`used_at_ms IS NOT NULL`) or
 * expired (`expires_at_ms <= nowMs`) — deleted whenever a fresh token is
 * about to be issued for them. No new job/cron: `password_reset_tokens`
 * otherwise accumulates forever (every issuance leaves its predecessor's
 * row behind, merely marked used by invalidateUnusedPasswordResetTokens
 * above; expired-but-never-retried rows aren't touched by that function
 * at all). Scoped to ONE user per call — this only ever runs from inside
 * issuePasswordResetToken below, on that user's own issuance — not a
 * table-wide sweep.
 */
export async function purgeExpiredOrUsedPasswordResetTokens(
  db: Kysely<DB>,
  userId: string,
  nowMs: number
): Promise<number> {
  const result = await db
    .deleteFrom('password_reset_tokens')
    .where('user_id', '=', userId)
    .where((eb) => eb.or([eb('used_at_ms', 'is not', null), eb('expires_at_ms', '<=', nowMs)]))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

/**
 * POST /auth/forgot-password's real-account branch (M15): invalidates
 * every previously-issued, still-unused token for this user
 * (invalidateUnusedPasswordResetTokens above), opportunistically purges
 * this user's already-dead rows (F10, purgeExpiredOrUsedPasswordResetTokens
 * above — runs AFTER the invalidate step so a row it just marked used is
 * caught in the same pass), and inserts the new row, all atomically — a
 * caller who requests two resets in a row can only ever complete with the
 * SECOND link; the first silently stops working rather than staying live
 * in parallel (M15: "Old tokens for the same user are invalidated when a
 * new one is issued").
 */
export async function issuePasswordResetToken(
  db: Kysely<DB>,
  input: IssuePasswordResetTokenInput
): Promise<PasswordResetTokenRow> {
  return withTransaction(db, async (trx) => {
    await invalidateUnusedPasswordResetTokens(trx, input.userId, input.createdAtMs);
    await purgeExpiredOrUsedPasswordResetTokens(trx, input.userId, input.createdAtMs);

    return trx
      .insertInto('password_reset_tokens')
      .values({
        user_id: input.userId,
        token_hash: input.tokenHash,
        created_at_ms: input.createdAtMs,
        expires_at_ms: input.expiresAtMs,
        used_at_ms: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export interface GetLivePasswordResetTokenInput {
  tokenHash: string;
  nowMs: number;
}

/**
 * GET /auth/reset-password/{token} (LD-15 (rc.6)): the READ-ONLY twin of
 * resetPasswordViaTokenAndEmit's atomic consume below. It asks the exact
 * same three-clause liveness question that consume's WHERE clause asks —
 * `token_hash = $hash AND used_at_ms IS NULL AND expires_at_ms > now` —
 * and answers it WITHOUT writing anything: no used_at_ms stamp, no
 * password change, no revoke, no event. Kept immediately above the
 * consume so the two predicates can never drift apart, the same reason
 * src/query/invites.ts keeps isInviteClaimable beside claimInviteAndEmit's
 * CAS (that pair is this function's shape: plain-read 404 path first,
 * race-deciding CAS second).
 *
 * A probe is NOT a substitute for the consume's own check. Between this
 * read and the subsequent POST the token can be used, expire, or be
 * superseded — the consume re-decides, and a loser still gets the same
 * bare 404. Missing, already-used, expired, and superseded tokens all
 * collapse to the SAME `null` here (no branch distinguishes them), so the
 * controller can raise one byte-identical not-found problem for every
 * case (M12/E8).
 */
export async function getLivePasswordResetToken(
  db: Kysely<DB>,
  input: GetLivePasswordResetTokenInput
): Promise<PasswordResetTokenRow | null> {
  const row = await db
    .selectFrom('password_reset_tokens')
    .selectAll()
    .where('token_hash', '=', input.tokenHash)
    .where('used_at_ms', 'is', null)
    .where('expires_at_ms', '>', input.nowMs)
    .executeTakeFirst();
  return row ?? null;
}

export type ResetPasswordViaTokenResult = { ok: true; userId: string } | { ok: false };

export interface ResetPasswordViaTokenInput {
  tokenHash: string;
  /** Already argon2id-hashed by the caller (apps/server's HashService) —
   *  see this file's header. */
  passwordHash: string;
  nowMs: number;
}

/**
 * POST /auth/reset-password (M15, M12's E8 posture): the ENTIRE operation
 * in one transaction —
 *   1. Atomic consume: `UPDATE password_reset_tokens SET used_at_ms = now
 *      WHERE token_hash = $hash AND used_at_ms IS NULL AND expires_at_ms >
 *      now RETURNING user_id`. A compare-and-swap identical in shape to
 *      identity.ts's revokeRefreshTokenById: when two requests race the
 *      same token, exactly one UPDATE matches a row (Postgres's row-level
 *      locking serializes the two UPDATEs), so exactly one caller gets
 *      `{ok: true}` and the other gets `{ok: false}` — never two winners.
 *      A missing, already-used, or expired token all collapse to the SAME
 *      `{ok: false}` (no branch distinguishes them) — the controller turns
 *      that into a bare, byte-identical-to-unknown-route 404 either way
 *      (M12: expired/consumed/invalid tokens must be indistinguishable).
 *   2. Sets the new password hash, clears `must_change_password`
 *      (M14: "setting a new password... clears the flag" — a self-service
 *      token reset is exactly such a password set, even though this user
 *      may never have been flagged at all; clearing an already-false flag
 *      is a no-op UPDATE, not a special case).
 *   3. Revokes EVERY refresh token the user holds
 *      (revokeAllRefreshTokensForUser — a compromised-password recovery
 *      must not leave any existing session alive).
 *   4. Emits `user.password-reset` with `actor: 'self-service'` and
 *      `actorUserId` = the user themself (unlike the CLI/admin tiers, a
 *      successful token consume IS proof of the acting party's identity —
 *      there is no separate "who did this" ambiguity to resolve).
 */
export async function resetPasswordViaTokenAndEmit(
  db: Kysely<DB>,
  input: ResetPasswordViaTokenInput
): Promise<ResetPasswordViaTokenResult> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const consumed = await trx
      .updateTable('password_reset_tokens')
      .set({ used_at_ms: input.nowMs })
      .where('token_hash', '=', input.tokenHash)
      .where('used_at_ms', 'is', null)
      .where('expires_at_ms', '>', input.nowMs)
      .returning('user_id')
      .executeTakeFirst();

    if (!consumed) {
      return { ok: false };
    }

    const user = await getUserById(trx, consumed.user_id);
    // Defensive only: password_reset_tokens.user_id is a FK ON DELETE
    // CASCADE, so a row surviving the consume UPDATE above guarantees the
    // referenced user still exists — this branch is unreachable in
    // practice, never a real 404 path this suite can exercise.
    if (!user) {
      return { ok: false };
    }

    await trx
      .updateTable('users')
      .set({
        password_hash: input.passwordHash,
        must_change_password: false,
        // R-F7 (opus adversarial review, fix wave): credentials-changed
        // epoch — see migrations/0026_password_changed_epoch.sql and
        // apps/server/src/gateway/auth.guard.ts's verifyAndAttach.
        password_changed_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', user.id)
      .execute();

    await revokeAllRefreshTokensForUser(trx, user.id, input.nowMs);

    await writeEvent(trx, {
      type: 'user.password-reset',
      tsMs: input.nowMs,
      actorUserId: user.id,
      payload: { userId: user.id, username: user.username, actor: 'self-service' },
    });

    return { ok: true, userId: user.id };
  });
}
