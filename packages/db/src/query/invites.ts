// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/invites.ts
//
// E2 (invitations): user_invites/user_invite_grants CRUD plus the
// atomic-consume claim transaction (migrations/0023_user_invites.sql).
// Lives in the PUBLIC barrel, not @loombre/db/internal, for the exact same
// reason src/query/identity.ts and src/query/admin.ts do (see admin.ts's
// module header): invite/user administration is authorized by `isAdmin`
// (createInvite/listInvites/revokeInvite, checked at the apps/server
// controller layer) or by presenting a valid unauthenticated token
// (getClaimState/claimInvite) — never by a ViewerContext, so wrapping these
// in applyGuard() would be both wrong and impossible (a claim request has
// no authenticated viewer yet to build one from).
//
// Token handling: this module only ever sees `tokenHash` (SHA-256 hex) —
// generating the raw token and hashing it is apps/server's job
// (apps/server/src/invites/invites.controller.ts reuses
// RefreshTokenService.generateOpaqueToken()/hashToken() directly, M3: "the
// refresh-token posture EXACTLY"). No function here ever receives or
// returns a raw token.

import type { Kysely, Selectable, Transaction } from 'kysely';
import type { DB, UserInvitesTable } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { createUserAdminAndEmit } from './identity.js';
import type { UserRow } from './identity.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export type InviteRow = Selectable<UserInvitesTable>;

const DEFAULT_LIMIT = 50;

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * R-F3/F3: `users` carries TWO unique constraints — `users_username_key`
 * and `users_email_key` (CITEXT UNIQUE, 0001, loosened to nullable by
 * 0023 — still unique when present). A 23505 raised by
 * createUserAdminAndEmit's INSERT could be either one; the Postgres error
 * object's own `constraint` field (never `detail`, which echoes the
 * conflicting VALUE back — exactly the leak this function exists to avoid
 * reading from) says which, so the caller below can raise a DISTINCT,
 * accurate error instead of blaming the username for an email collision.
 */
function pgConstraintName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

const USERS_EMAIL_UNIQUE_CONSTRAINT = 'users_email_key';

/** Thrown INSIDE the claim transaction to force a rollback (see
 *  claimInviteAndEmit's header) — never escapes this module. */
class UsernameConflictError extends Error {}

/** Same rollback contract as UsernameConflictError above, raised instead
 *  when the 23505 is on `users_email_key` rather than `users_username_key`
 *  — see claimInviteAndEmit's catch block and this module's header. */
class EmailConflictError extends Error {}

// ============================================================================
// shape shared by createInvite/listInvites/getInvite's mappers
// ============================================================================

export interface InviteAdminRow {
  id: string;
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs: number;
  usernamePreset: string | null;
  displayNamePreset: string | null;
  email: string | null;
  claimedAtMs: number | null;
  claimedUserId: string | null;
  revokedAtMs: number | null;
  libraryIds: string[];
}

function mapInviteRow(row: InviteRow, libraryIds: string[]): InviteAdminRow {
  return {
    id: row.id,
    createdByUserId: row.created_by,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    usernamePreset: row.username_preset,
    displayNamePreset: row.display_name_preset,
    email: row.email,
    claimedAtMs: row.claimed_at_ms,
    claimedUserId: row.claimed_user_id,
    revokedAtMs: row.revoked_at_ms,
    libraryIds,
  };
}

/** Derives the wire `status` (never stored — M-brief "status: derived").
 *  Revoked wins over claimed in the check order; in practice the two are
 *  mutually exclusive by construction (revokeInviteAndEmit's own WHERE
 *  clause refuses to revoke an already-claimed invite), but checking
 *  revoked first keeps this function correct even if that invariant were
 *  ever relaxed. */
export type InviteStatus = 'pending' | 'claimed' | 'revoked' | 'expired';

export function deriveInviteStatus(
  row: { claimedAtMs: number | null; revokedAtMs: number | null; expiresAtMs: number },
  nowMs: number
): InviteStatus {
  if (row.revokedAtMs !== null) return 'revoked';
  if (row.claimedAtMs !== null) return 'claimed';
  if (row.expiresAtMs <= nowMs) return 'expired';
  return 'pending';
}

async function loadGrants(db: Kysely<DB> | Transaction<DB>, inviteIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (inviteIds.length === 0) return map;
  const rows = await db
    .selectFrom('user_invite_grants')
    .select(['invite_id', 'library_id'])
    .where('invite_id', 'in', inviteIds)
    .execute();
  for (const row of rows) {
    const list = map.get(row.invite_id) ?? [];
    list.push(row.library_id);
    map.set(row.invite_id, list);
  }
  return map;
}

// ============================================================================
// createInvite (POST /invites)
// ============================================================================

export interface CreateInviteInput {
  createdByUserId: string;
  tokenHash: string;
  usernamePreset: string | null;
  displayNamePreset: string | null;
  email: string | null;
  /** Already existence + restricted-class validated by the caller (M4) —
   *  this function trusts the list as-is. May be empty. */
  libraryIds: string[];
  expiresAtMs: number;
  nowMs: number;
}

/**
 * Inserts the invite row + its user_invite_grants rows + the ADMIN_ONLY
 * `user.invited` event, all in one transaction. Payload carries
 * inviteId/usernamePreset/libraryIds/createdAtMs only — NEVER the token
 * (this function never even sees the raw token, only its hash).
 */
export async function createInviteAndEmit(db: Kysely<DB>, input: CreateInviteInput): Promise<InviteAdminRow> {
  return withTransaction(db, async (trx) => {
    const row = await trx
      .insertInto('user_invites')
      .values({
        token_hash: input.tokenHash,
        created_by: input.createdByUserId,
        created_at_ms: input.nowMs,
        expires_at_ms: input.expiresAtMs,
        username_preset: input.usernamePreset,
        display_name_preset: input.displayNamePreset,
        email: input.email,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (input.libraryIds.length > 0) {
      await trx
        .insertInto('user_invite_grants')
        .values(input.libraryIds.map((libraryId) => ({ invite_id: row.id, library_id: libraryId })))
        .execute();
    }

    await writeEvent(trx, {
      type: 'user.invited',
      tsMs: input.nowMs,
      actorUserId: input.createdByUserId,
      payload: {
        inviteId: row.id,
        usernamePreset: row.username_preset,
        libraryIds: input.libraryIds,
        createdAtMs: row.created_at_ms,
      },
    });

    return mapInviteRow(row, input.libraryIds);
  });
}

// ============================================================================
// listInvites (GET /invites)
// ============================================================================

export interface ListInvitesParams {
  cursor?: string;
  limit?: number;
}
export interface ListInvitesResult {
  rows: InviteAdminRow[];
  nextCursor: string | null;
}

interface InviteCursorPayload {
  createdAtMs: number;
  id: string;
}
function isInviteCursorPayload(value: unknown): value is InviteCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function listInvitesAdmin(db: Kysely<DB>, params: ListInvitesParams = {}): Promise<ListInvitesResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db.selectFrom('user_invites').selectAll();

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isInviteCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('created_at_ms', '<', createdAtMs),
        eb.and([eb('created_at_ms', '=', createdAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('created_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  const grantsByInvite = await loadGrants(
    db,
    rows.map((r) => r.id)
  );

  return {
    rows: rows.map((row) => mapInviteRow(row, grantsByInvite.get(row.id) ?? [])),
    nextCursor,
  };
}

// ============================================================================
// revokeInvite (DELETE /invites/{id})
// ============================================================================

/**
 * Sets revoked_at_ms — but ONLY when the invite is currently un-revoked AND
 * un-claimed (WHERE clause below); returns false (caller 404s) for an
 * already-revoked, already-claimed, or nonexistent id. Revoking a claimed
 * invite would have no invite-side effect (the user already exists), so
 * treating it as "nothing left to revoke" is the honest response — deviation
 * choice recorded (the brief left "idempotent-safe or 404" open; 404 was
 * picked here, see Lane A's freeze report).
 */
export async function revokeInviteAndEmit(
  db: Kysely<DB>,
  id: string,
  actorUserId: string,
  nowMs: number
): Promise<boolean> {
  return withTransaction(db, async (trx) => {
    const result = await trx
      .updateTable('user_invites')
      .set({ revoked_at_ms: nowMs })
      .where('id', '=', id)
      .where('revoked_at_ms', 'is', null)
      .where('claimed_at_ms', 'is', null)
      .executeTakeFirst();

    const won = (result.numUpdatedRows ?? 0n) > 0n;
    if (!won) return false;

    await writeEvent(trx, {
      type: 'user.invite-revoked',
      tsMs: nowMs,
      actorUserId,
      payload: { inviteId: id, revokedAtMs: nowMs },
    });

    return true;
  });
}

// ============================================================================
// getClaimState (GET /claim/{token})
// ============================================================================

export interface InviteClaimStateRow {
  usernamePreset: string | null;
  displayNamePreset: string | null;
  emailPreset: string | null;
}

/** True iff an invite (by its own row fields) can still be claimed right
 *  now — the SAME three-clause definition claimInviteAndEmit's atomic
 *  UPDATE WHERE clause enforces, kept as one predicate so the plain-read
 *  404 (getClaimState / the claim endpoint's fast pre-check) and the real
 *  race-deciding CAS can never drift apart. */
export function isInviteClaimable(
  row: { claimedAtMs: number | null; revokedAtMs: number | null; expiresAtMs: number },
  nowMs: number
): boolean {
  return row.claimedAtMs === null && row.revokedAtMs === null && row.expiresAtMs > nowMs;
}

export async function getInviteByTokenHash(db: Kysely<DB>, tokenHash: string): Promise<InviteRow | undefined> {
  return db.selectFrom('user_invites').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
}

export function mapClaimState(row: InviteRow): InviteClaimStateRow {
  return {
    usernamePreset: row.username_preset,
    displayNamePreset: row.display_name_preset,
    emailPreset: row.email,
  };
}

// ============================================================================
// claimInvite (POST /claim/{token})
// ============================================================================

export interface ClaimInviteInput {
  tokenHash: string;
  username: string;
  email: string | null;
  displayName: string | null;
  passwordHash: string;
  nowMs: number;
}

export type ClaimInviteResult =
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'username-conflict' }
  | { ok: false; reason: 'email-conflict' }
  | {
      ok: true;
      user: UserRow;
      inviteId: string;
      grantedLibraryIds: string[];
      skippedRestrictedLibraryIds: string[];
    };

/**
 * The whole claim in ONE transaction (M13/M4/M6):
 *   1. Look up the invite by token hash — missing/expired/claimed/revoked
 *      -> `{ok:false, reason:'invalid'}` (caller throws the byte-identical
 *      404, same detail as an unknown token).
 *   2. Atomic consume: `UPDATE ... WHERE claimed_at_ms IS NULL AND
 *      revoked_at_ms IS NULL AND expires_at_ms > $now` (rowcount=1 wins —
 *      this is the actual race decider the RACE TEST exercises: of N
 *      concurrent callers hitting the same invite, exactly one UPDATE
 *      matches a row, every other caller's WHERE clause matches zero rows
 *      once it re-evaluates against the winner's already-committed-or-
 *      still-locked row). `claimed_user_id` is intentionally NOT set in
 *      this same UPDATE — the new user's id does not exist yet at this
 *      point — it is backfilled by a follow-up UPDATE once the user row
 *      exists (step 3), still inside this same transaction, so no window
 *      exists where a caller can observe "claimed but no claimed_user_id"
 *      outside the transaction.
 *   3. Create the user via createUserAdminAndEmit (the reused creation
 *      primitive, M6 — emits the EXISTING `user.created`, self-attributed
 *      since no actorUserId is passed). A username collision throws
 *      UsernameConflictError; an email collision (R-F3/F3 — users.email is
 *      CITEXT UNIQUE too, distinguished via the 23505's own `constraint`
 *      name, never blamed on the username) throws EmailConflictError.
 *      Either unwinds the WHOLE transaction (including step 2's
 *      claimed_at_ms write) so the invite is claimable again on retry — a
 *      conflict, of either kind, must never burn the invite.
 *   4. library_permissions grants from user_invite_grants, RE-CHECKED
 *      against each library's current content_class (M4 defense in depth
 *      — a library could have flipped to restricted after the invite was
 *      created); restricted grants are silently skipped and reported back
 *      in `skippedRestrictedLibraryIds` for the caller to log/surface.
 *   5. The ADMIN_ONLY `user.claimed` event (actorUserId = the new user).
 */
export async function claimInviteAndEmit(db: Kysely<DB>, input: ClaimInviteInput): Promise<ClaimInviteResult> {
  try {
    return await withTransaction(db, async (trx) => {
      const invite = await trx
        .selectFrom('user_invites')
        .selectAll()
        .where('token_hash', '=', input.tokenHash)
        .executeTakeFirst();
      if (!invite) {
        return { ok: false as const, reason: 'invalid' as const };
      }

      const consume = await trx
        .updateTable('user_invites')
        .set({ claimed_at_ms: input.nowMs })
        .where('id', '=', invite.id)
        .where('claimed_at_ms', 'is', null)
        .where('revoked_at_ms', 'is', null)
        .where('expires_at_ms', '>', input.nowMs)
        .executeTakeFirst();
      if ((consume.numUpdatedRows ?? 0n) === 0n) {
        return { ok: false as const, reason: 'invalid' as const };
      }

      // R-F3/F3 (E8, "no enumeration anywhere"): resolve the email BEFORE
      // attempting to create the user. A candidate email that already
      // belongs to another account is silently DROPPED — this claim
      // proceeds exactly as if no email had been submitted at all — rather
      // than rejected. A distinguishable rejection (even with perfectly
      // accurate, username-agnostic wording) would still let an invite
      // holder learn "this email exists" from the STATUS CODE alone
      // (422 + rollback vs 201 + success); dropping it silently makes a
      // taken-email claim and a free-email claim identical in status, body
      // shape, AND invite-consumption behavior — there is nothing left to
      // distinguish. Checked case-insensitively (CITEXT) via a plain
      // SELECT inside this same transaction, not a second unique-
      // constraint catch, specifically so the COMMON case never reaches a
      // 23505/rollback at all. The (23505 -> EmailConflictError) branch
      // below still exists as a narrow safety net for the vanishing race
      // where the email is registered in the gap between this check and
      // the INSERT below — that race is not a usable enumeration channel
      // (an attacker cannot reliably trigger it to learn pre-existing
      // state), so it stays a hard rollback+422 rather than a second
      // silent-retry attempt.
      let email = input.email;
      if (email !== null) {
        const existingByEmail = await trx
          .selectFrom('users')
          .select('id')
          .where('email', '=', email)
          .executeTakeFirst();
        if (existingByEmail) {
          email = null;
        }
      }

      let user: UserRow;
      try {
        user = await createUserAdminAndEmit(trx, {
          username: input.username,
          email,
          passwordHash: input.passwordHash,
          isAdmin: false,
          maxContentRating: null,
          displayName: input.displayName,
          nowMs: input.nowMs,
          // actorUserId omitted deliberately: this is a self-serve claim,
          // not an admin action — insertUserAndEmit's documented fallback
          // attributes `user.created` to the new user's own id.
        });
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          // Distinguish which constraint actually fired instead of
          // blaming the username for every 23505 — a free username must
          // never surface as a (false) username conflict.
          if (pgConstraintName(err) === USERS_EMAIL_UNIQUE_CONSTRAINT) {
            throw new EmailConflictError();
          }
          throw new UsernameConflictError();
        }
        throw err;
      }

      await trx.updateTable('user_invites').set({ claimed_user_id: user.id }).where('id', '=', invite.id).execute();

      const grantedLibraryIds: string[] = [];
      const skippedRestrictedLibraryIds: string[] = [];
      const grantRows = await trx
        .selectFrom('user_invite_grants')
        .select('library_id')
        .where('invite_id', '=', invite.id)
        .execute();

      if (grantRows.length > 0) {
        const libraryIds = grantRows.map((g) => g.library_id);
        const libs = await trx
          .selectFrom('libraries')
          .select(['id', 'content_class'])
          .where('id', 'in', libraryIds)
          .execute();
        const contentClassById = new Map(libs.map((l) => [l.id, l.content_class]));

        for (const libraryId of libraryIds) {
          const contentClass = contentClassById.get(libraryId);
          // Defensive only: user_invite_grants.library_id cascades away
          // with its library (ON DELETE CASCADE), so a grant row pointing
          // at a nonexistent library should not occur in practice.
          if (contentClass === undefined) continue;
          if (contentClass === 'restricted') {
            skippedRestrictedLibraryIds.push(libraryId);
            continue;
          }
          await trx
            .insertInto('library_permissions')
            .values({ user_id: user.id, library_id: libraryId, granted_at_ms: input.nowMs })
            .onConflict((oc) => oc.columns(['user_id', 'library_id']).doNothing())
            .execute();
          grantedLibraryIds.push(libraryId);
        }
      }

      await writeEvent(trx, {
        type: 'user.claimed',
        tsMs: input.nowMs,
        actorUserId: user.id,
        payload: {
          userId: user.id,
          inviteId: invite.id,
          username: user.username,
          createdAtMs: user.created_at_ms,
        },
      });

      return {
        ok: true as const,
        user,
        inviteId: invite.id,
        grantedLibraryIds,
        skippedRestrictedLibraryIds,
      };
    });
  } catch (err) {
    if (err instanceof UsernameConflictError) {
      return { ok: false, reason: 'username-conflict' };
    }
    if (err instanceof EmailConflictError) {
      return { ok: false, reason: 'email-conflict' };
    }
    throw err;
  }
}
