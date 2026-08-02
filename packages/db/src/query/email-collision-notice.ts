// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/email-collision-notice.ts
//
// G7 (STATE.md "Current-password re-auth on self-changes"): the atomic 24h
// window claim for the email-in-use security notice — migrations/
// 0025_email_collision_notice_ledger.sql's own header has the full
// rationale (a DB ledger, not an in-memory KeyedRateLimiter, because the
// window must survive a routine server restart and @loombre/jobs exposes
// no pg-boss singleton/dedup surface to ride on instead). ONE statement —
// INSERT ... ON CONFLICT (email) DO UPDATE ... WHERE ... RETURNING — so
// "check the window, then claim it" can never race two concurrent
// collision attempts against the SAME address into both winning; exactly
// one caller's row satisfies the WHERE clause and gets a RETURNING row
// back, the same compare-and-swap shape as identity.ts's
// revokeRefreshTokenById / password-reset.ts's atomic consume.
//
// Lives in the public barrel (not @loombre/db/internal) for the same
// reason invites.ts/password-reset.ts do: this is auth-adjacent identity
// plumbing apps/server's controllers call directly, not a catalog_items
// read gated by a ViewerContext.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';

/** F5: "max 1 notice per address per 24h". */
export const EMAIL_COLLISION_NOTICE_WINDOW_MS = 86_400_000;

/**
 * Attempts to claim the 24h notice window for `email`. Returns `true`
 * (WON — the caller should send the notice) when no ledger row exists yet
 * for this address, or the existing row's `last_notice_at_ms` is at least
 * `EMAIL_COLLISION_NOTICE_WINDOW_MS` in the past as of `nowMs`; returns
 * `false` (a notice already went out inside the window — SUPPRESS)
 * otherwise. `email` is matched CITEXT case-insensitively (the column's
 * own type), same as `users.email`'s own uniqueness. `nowMs` is an
 * argument, never `Date.now()` — house style, every query-layer function
 * in this package takes its clock as a parameter (see neighboring
 * functions, e.g. password-reset.ts's issuePasswordResetToken).
 */
export async function claimEmailCollisionNoticeWindow(
  db: Kysely<DB>,
  email: string,
  nowMs: number
): Promise<boolean> {
  const row = await db
    .insertInto('email_collision_notice_ledger')
    .values({ email, last_notice_at_ms: nowMs })
    .onConflict((oc) =>
      oc
        .column('email')
        .doUpdateSet({ last_notice_at_ms: nowMs })
        .where('email_collision_notice_ledger.last_notice_at_ms', '<=', nowMs - EMAIL_COLLISION_NOTICE_WINDOW_MS)
    )
    .returning('email')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * R-F5 (opus adversarial review, fix wave): releases the window a caller's
 * OWN `claimEmailCollisionNoticeWindow(email, claimedAtMs)` call just won,
 * when the notice it was claimed for turned out NOT to be dispatched
 * (`MailDispatchService.trySend` degrading to `{dispatched: false}` — its
 * documented E6 posture whenever the job-queue enqueue itself throws).
 * Without this, a single transient queue hiccup silently costs that
 * address its ENTIRE 24h notice window, and a later, genuine collision on
 * the same address stays silent too.
 *
 * `claimedAtMs` must be the EXACT `nowMs` value passed to the winning
 * `claimEmailCollisionNoticeWindow` call — the DELETE only matches a row
 * whose `last_notice_at_ms` still equals it, so a caller can only ever
 * release the row ITS OWN attempt just claimed, never a window a
 * different (later) collision attempt against the same address may have
 * legitimately re-claimed in the meantime. In practice that race cannot
 * happen inside this window anyway (a re-claim within
 * EMAIL_COLLISION_NOTICE_WINDOW_MS of this one can never satisfy the
 * winning UPDATE's own `WHERE` clause), but the guard is cheap, correct
 * either way, and self-documents the invariant rather than assuming it.
 */
export async function releaseEmailCollisionNoticeWindow(
  db: Kysely<DB>,
  email: string,
  claimedAtMs: number
): Promise<void> {
  await db
    .deleteFrom('email_collision_notice_ledger')
    .where('email', '=', email)
    .where('last_notice_at_ms', '=', claimedAtMs)
    .execute();
}
