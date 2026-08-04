// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/notices.ts
//
// Admin broadcast notifications (STATE.md "Admin broadcast notifications —
// system notices", N1-N6/NG1-NG10), migrations/0028_system_notices.sql.
// system_notices/CRUD-plus-broadcast, the SAME reasoning src/query/
// invites.ts and src/query/settings.ts each carry at length: this lives in
// the PUBLIC barrel (src/index.ts), not @loombre/db/internal, because
// system_notices is instance-administration data, not viewer-scoped
// catalog data — authorization is `isAdmin` (checked at the apps/server
// controller layer via requireAdmin/requireLiveAdmin, the A10 fresh-read
// pattern) for the three admin mutations/reads, and "any authenticated
// user" (no admin check at all) for getActiveNotice — NEITHER shape is a
// ViewerContext-guarded catalog read, so wrapping any of this in
// applyGuard() would be both wrong and impossible (there is no
// item/library association to gate on at all).
//
// N1/NG8: v1 holds exactly ONE active notice. publishNoticeAndEmit does
// "cancel whichever notice is currently active, then insert the new one"
// in ONE transaction — replacing, never stacking — and emits exactly ONE
// `notice.published` event for the new row (never a `notice.cancelled` for
// the row it just superseded; NG8 — a client that misses the supersession
// reconciles via GET /notices/active, NG2). Audit IS the broadcast: both
// outbox events carry the acting admin as the envelope's actorUserId, and
// there is no separate admin-only audit event — history reads this table
// directly (listNoticesAdmin), not the events outbox.
//
// All timestamps arrive as an explicit `nowMs: number` argument — this
// module never calls Date.now() itself (house style; every other query
// module in this package follows the same rule).

import type { ExpressionBuilder, Kysely, Selectable } from 'kysely';
import type { DB, NoticeSeverity, SystemNoticesTable } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export type NoticeRow = Selectable<SystemNoticesTable>;

const DEFAULT_LIMIT = 50;

// ============================================================================
// shared shape + status derivation
// ============================================================================

export type NoticeStatus = 'active' | 'cancelled' | 'expired';

/** Derives the wire `status` (never stored — same derive-don't-store rule
 *  src/query/invites.ts's deriveInviteStatus establishes for invite
 *  status). Cancelled wins over expired in the check order — in practice
 *  a row can be both (cancelled after its own expiry already passed), and
 *  "cancelled" is the more informative fact of the two. */
export function deriveNoticeStatus(
  row: { cancelledAtMs: number | null; expiresAtMs: number | null },
  nowMs: number
): NoticeStatus {
  if (row.cancelledAtMs !== null) return 'cancelled';
  if (row.expiresAtMs !== null && row.expiresAtMs <= nowMs) return 'expired';
  return 'active';
}

export interface NoticeAdminRow {
  id: string;
  message: string;
  severity: NoticeSeverity;
  effectiveAtMs: number | null;
  expiresAtMs: number | null;
  createdBy: string | null;
  createdAtMs: number;
  cancelledAtMs: number | null;
  status: NoticeStatus;
}

function mapNoticeRow(row: NoticeRow, nowMs: number): NoticeAdminRow {
  return {
    id: row.id,
    message: row.message,
    severity: row.severity,
    effectiveAtMs: row.effective_at_ms,
    expiresAtMs: row.expires_at_ms,
    createdBy: row.created_by,
    createdAtMs: row.created_at_ms,
    cancelledAtMs: row.cancelled_at_ms,
    status: deriveNoticeStatus({ cancelledAtMs: row.cancelled_at_ms, expiresAtMs: row.expires_at_ms }, nowMs),
  };
}

// NG4's active predicate, factored once so publishNoticeAndEmit's
// supersede-UPDATE, cancelNoticeAndEmit's conditional UPDATE, and
// getActiveNotice's SELECT can never drift apart (the same
// single-predicate-function discipline src/query/events.ts's
// eventVisibilityWhere and src/query/invites.ts's isInviteClaimable each
// apply for their own "one true definition" reasons): NOT cancelled AND
// (no expiry OR expiry still in the future).
function activeExpr(eb: ExpressionBuilder<DB, 'system_notices'>, nowMs: number) {
  return eb.or([eb('expires_at_ms', 'is', null), eb('expires_at_ms', '>', nowMs)]);
}

// ============================================================================
// publishNoticeAndEmit (POST /system/notices)
// ============================================================================

export interface PublishNoticeInput {
  message: string;
  severity: NoticeSeverity;
  /** Already resolved to an ABSOLUTE ms value by the caller (NG5: the
   *  publish request carries relative durations; the apps/server
   *  controller anchors them to its own clock before calling this). */
  effectiveAtMs: number | null;
  /** Same NG5 note as effectiveAtMs. NULL is legal only when severity is
   *  'critical' (NG4) — the caller is responsible for having already
   *  applied the severity-specific default/required rules; this function
   *  trusts the value as-is (the migration's own CHECK is the last-resort
   *  backstop, not the primary enforcement point). */
  expiresAtMs: number | null;
  /** NOT NULL at insert (NG8) — enforced here by the TypeScript type,
   *  same convention src/query/settings.ts's UpsertServerSettingInput.
   *  actorUserId uses for server_settings.updated_by (a nullable column,
   *  audit-actor pattern, ALWAYS supplied by every real caller). */
  createdBy: string;
  nowMs: number;
}

/**
 * ONE transaction (N1/NG8): (1) cancel whichever notice is currently
 * active — a plain UPDATE, no row read first, so this is naturally a
 * no-op when nothing is active; (2) INSERT the new row; (3) emit exactly
 * ONE `notice.published` event for the new row. Step (1) never emits
 * `notice.cancelled` — see this module's header. Returns the inserted row
 * (admin shape, including createdBy — the apps/server controller decides
 * which fields the caller-facing response actually exposes, same split
 * src/query/invites.ts's InviteAdminRow vs the claim-state public shape
 * already establishes).
 */
export async function publishNoticeAndEmit(db: Kysely<DB>, input: PublishNoticeInput): Promise<NoticeAdminRow> {
  return withTransaction(db, async (trx) => {
    await trx
      .updateTable('system_notices')
      .set({ cancelled_at_ms: input.nowMs })
      .where('cancelled_at_ms', 'is', null)
      .where((eb) => activeExpr(eb, input.nowMs))
      .execute();

    const row = await trx
      .insertInto('system_notices')
      .values({
        message: input.message,
        severity: input.severity,
        effective_at_ms: input.effectiveAtMs,
        expires_at_ms: input.expiresAtMs,
        created_by: input.createdBy,
        created_at_ms: input.nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Payload matches packages/contract/event-schemas/notice.published.
    // schema.json EXACTLY — the all-user SystemNotice shape, deliberately
    // NO createdBy/user-id field of any kind (NG6's plain-content
    // posture: this event reaches every non-admin socket too, and admin
    // identity is not for every-user broadcast). The envelope's own
    // actorUserId (writeEvent's actorUserId arg below) is where the
    // acting admin is recorded — audit lives at the envelope, never the
    // payload, for this pair.
    await writeEvent(trx, {
      type: 'notice.published',
      tsMs: input.nowMs,
      actorUserId: input.createdBy,
      payload: {
        id: row.id,
        message: row.message,
        severity: row.severity,
        effectiveAtMs: row.effective_at_ms,
        expiresAtMs: row.expires_at_ms,
        createdAtMs: row.created_at_ms,
      },
    });

    return mapNoticeRow(row, input.nowMs);
  });
}

// ============================================================================
// cancelNoticeAndEmit (POST /system/notices/{id}/cancel)
// ============================================================================

export interface CancelNoticeInput {
  id: string;
  actorUserId: string;
  nowMs: number;
}

/**
 * Conditional UPDATE (same CAS-then-check-rowcount shape src/query/
 * invites.ts's revokeInviteAndEmit uses): sets cancelled_at_ms ONLY when
 * the row is currently active (NG4's predicate, via activeExpr above).
 * numUpdatedRows > 0 wins and emits `notice.cancelled`; the loser (row
 * missing, already cancelled, or already naturally expired) returns
 * false and writes nothing — the apps/server controller maps that to 404
 * (invites revoke precedent: "nothing left to cancel").
 */
export async function cancelNoticeAndEmit(db: Kysely<DB>, input: CancelNoticeInput): Promise<boolean> {
  return withTransaction(db, async (trx) => {
    const result = await trx
      .updateTable('system_notices')
      .set({ cancelled_at_ms: input.nowMs })
      .where('id', '=', input.id)
      .where('cancelled_at_ms', 'is', null)
      .where((eb) => activeExpr(eb, input.nowMs))
      .executeTakeFirst();

    const won = (result.numUpdatedRows ?? 0n) > 0n;
    if (!won) return false;

    await writeEvent(trx, {
      type: 'notice.cancelled',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { id: input.id },
    });

    return true;
  });
}

// ============================================================================
// getActiveNotice (GET /notices/active)
// ============================================================================

/**
 * NG4's active predicate, newest first (created_at_ms desc, id desc —
 * UUIDv7 makes `id desc` a valid tie-break, same reasoning src/query/
 * events.ts's cursor ordering relies on), LIMIT 1. Returns null when no
 * notice is currently active. Only one row can ever match in practice
 * (publishNoticeAndEmit's own replace semantics keep it that way), but
 * the ORDER BY + LIMIT make this correct even if that invariant were ever
 * relaxed.
 */
export async function getActiveNotice(db: Kysely<DB>, nowMs: number): Promise<NoticeAdminRow | null> {
  const row = await db
    .selectFrom('system_notices')
    .selectAll()
    .where('cancelled_at_ms', 'is', null)
    .where((eb) => activeExpr(eb, nowMs))
    .orderBy('created_at_ms', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ? mapNoticeRow(row, nowMs) : null;
}

// ============================================================================
// listNoticesAdmin (GET /system/notices)
// ============================================================================

export interface ListNoticesParams {
  cursor?: string;
  limit?: number;
  nowMs: number;
}

export interface ListNoticesResult {
  rows: NoticeAdminRow[];
  nextCursor: string | null;
}

interface NoticeCursorPayload {
  createdAtMs: number;
  id: string;
}
function isNoticeCursorPayload(value: unknown): value is NoticeCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

/** Keyset cursor on (created_at_ms desc, id desc) — the SAME codec +
 *  ordering shape src/query/invites.ts's listInvitesAdmin uses. Every row
 *  carries created_by and a DERIVED status (never stored — see
 *  deriveNoticeStatus above), history-list shape, not the all-user
 *  broadcast shape. */
export async function listNoticesAdmin(db: Kysely<DB>, params: ListNoticesParams): Promise<ListNoticesResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db.selectFrom('system_notices').selectAll();

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isNoticeCursorPayload);
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

  return {
    rows: rows.map((row) => mapNoticeRow(row, params.nowMs)),
    nextCursor,
  };
}
