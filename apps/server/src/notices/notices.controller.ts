// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/notices/notices.controller.ts
//
// STATE.md "Admin broadcast notifications — system notices" (N1-N6,
// NG1-NG10), Lane A (server side). Four ops (tag `notices`,
// packages/contract/openapi.yaml):
//   - POST   /system/notices           publishSystemNotice   (admin)
//   - POST   /system/notices/{id}/cancel  cancelSystemNotice (admin)
//   - GET    /system/notices           listSystemNotices     (admin)
//   - GET    /notices/active           getActiveSystemNotice (ANY
//     authenticated user — deliberately NO admin check; NG2's catch-up
//     read, called on auth boot and every socket reconnect).
//
// NG5 ("durations in, absolutes out"): the publish request carries
// RELATIVE effectiveInMs/expiresInMs; THIS controller is where they get
// anchored to the server's own clock into the absolute ms values
// packages/db/src/query/notices.ts actually stores — compose-time clock
// skew is impossible by construction. NG4's severity-specific expiry
// defaults/requirements (info absent -> +1h; warning absent -> 422;
// critical absent -> null/"until cancelled") are enforced here too, not in
// the query layer (which trusts its caller — see that module's header).

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import {
  cancelNoticeAndEmit,
  getActiveNotice,
  listNoticesAdmin,
  publishNoticeAndEmit,
  type NoticeAdminRow,
  type NoticeSeverity,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";

const MESSAGE_MAX_LENGTH = 500;
const SEVERITIES: readonly NoticeSeverity[] = ["info", "warning", "critical"];
const INFO_DEFAULT_EXPIRES_IN_MS = 3_600_000; // 1h (NG4)

// F6/CREATE_INVITE_BODY_KEYS precedent (invites.controller.ts):
// additionalProperties:false made real via an explicit allowlist.
const PUBLISH_NOTICE_BODY_KEYS = new Set(["message", "severity", "effectiveInMs", "expiresInMs"]);

function isNoticeSeverity(value: unknown): value is NoticeSeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** Contract `maximum` on effectiveInMs/expiresInMs: 365 days. Beyond that
 *  a duration is a mistake, not a plan — and it must be bounded here
 *  regardless: `Number.isInteger(1e308)` is true, so an unbounded value
 *  reaches `nowMs + v` and overflows the BIGINT column into a Postgres
 *  error → 500 (review finding R-F3). */
const MAX_DURATION_MS = 31_536_000_000;

/** Bounded positive integer — the contract's `minimum: 1` / `maximum:
 *  31536000000` on both effectiveInMs/expiresInMs (a zero-or-negative
 *  duration is nonsense: "in 0ms" is just "now", and "in -5ms" is not a
 *  duration at all). */
function isValidDurationMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DURATION_MS;
}

interface CursorLimitQuery {
  cursor?: string;
  limit?: number;
}
function parseCursorLimitQuery(query: Record<string, unknown>): CursorLimitQuery {
  const result: CursorLimitQuery = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  if (typeof query["limit"] === "string") {
    const n = Number.parseInt(query["limit"], 10);
    if (Number.isFinite(n) && n > 0) result.limit = n;
  }
  return result;
}

/** The all-user SystemNotice shape (packages/contract/openapi.yaml) —
 *  deliberately drops createdBy/cancelledAtMs/status (NG6 plain-content
 *  posture: every user sees this, never who published it or its admin-
 *  only history fields). */
function mapPublicNotice(row: NoticeAdminRow) {
  return {
    id: row.id,
    message: row.message,
    severity: row.severity,
    effectiveAtMs: row.effectiveAtMs,
    expiresAtMs: row.expiresAtMs,
    createdAtMs: row.createdAtMs,
  };
}

/** SystemNoticeAdmin: the public shape plus createdBy/cancelledAtMs/status
 *  — NoticeAdminRow (packages/db/src/query/notices.ts) is already exactly
 *  this shape, so this is an identity pass-through kept as a named
 *  function for symmetry with mapPublicNotice and to keep the response
 *  shape decision at ONE call site per endpoint. */
function mapAdminNotice(row: NoticeAdminRow) {
  return {
    id: row.id,
    message: row.message,
    severity: row.severity,
    effectiveAtMs: row.effectiveAtMs,
    expiresAtMs: row.expiresAtMs,
    createdAtMs: row.createdAtMs,
    createdBy: row.createdBy,
    cancelledAtMs: row.cancelledAtMs,
    status: row.status,
  };
}

async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

@Controller()
export class NoticesController {
  constructor(private readonly dbProvider: DbProvider) {}

  // ==========================================================================
  // admin: publish / cancel / list
  // ==========================================================================

  @Post("system/notices")
  @HttpCode(HttpStatus.CREATED)
  async publishSystemNotice(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    for (const key of Object.keys(body)) {
      if (!PUBLISH_NOTICE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (typeof body["message"] !== "string") {
      throw unprocessableEntity("message is required.", instance);
    }
    const message = body["message"].trim();
    if (message.length === 0) {
      throw unprocessableEntity("message must not be empty.", instance);
    }
    if (message.length > MESSAGE_MAX_LENGTH) {
      throw unprocessableEntity(`message must be at most ${MESSAGE_MAX_LENGTH} characters.`, instance);
    }

    if (!isNoticeSeverity(body["severity"])) {
      throw unprocessableEntity("severity must be one of: info, warning, critical.", instance);
    }
    const severity = body["severity"];

    let effectiveInMs: number | undefined;
    if (body["effectiveInMs"] !== undefined) {
      if (!isValidDurationMs(body["effectiveInMs"])) {
        throw unprocessableEntity(`effectiveInMs must be a positive integer (ms), at most ${MAX_DURATION_MS} (365 days).`, instance);
      }
      effectiveInMs = body["effectiveInMs"];
    }

    let expiresInMs: number | undefined;
    if (body["expiresInMs"] !== undefined) {
      if (!isValidDurationMs(body["expiresInMs"])) {
        throw unprocessableEntity(`expiresInMs must be a positive integer (ms), at most ${MAX_DURATION_MS} (365 days).`, instance);
      }
      expiresInMs = body["expiresInMs"];
    }

    // NG4: warning REQUIRES a composer-set expiry — a maintenance banner
    // must not linger forever by accident.
    if (severity === "warning" && expiresInMs === undefined) {
      throw unprocessableEntity("expiresInMs is required for severity=warning.", instance);
    }

    // A countdown target after the notice has already expired is
    // nonsense — reject rather than silently accept an unreachable
    // effective time.
    if (effectiveInMs !== undefined && expiresInMs !== undefined && effectiveInMs > expiresInMs) {
      throw unprocessableEntity("effectiveInMs must not be after expiresInMs.", instance);
    }

    const nowMs = clockNowMs();
    const effectiveAtMs = effectiveInMs !== undefined ? nowMs + effectiveInMs : null;
    // NG4 severity-specific defaults: info absent -> +1h; warning always
    // has expiresInMs by the check above; critical absent -> null
    // ("until cancelled").
    let expiresAtMs: number | null;
    if (expiresInMs !== undefined) {
      expiresAtMs = nowMs + expiresInMs;
    } else if (severity === "info") {
      expiresAtMs = nowMs + INFO_DEFAULT_EXPIRES_IN_MS;
    } else {
      expiresAtMs = null;
    }

    const notice = await publishNoticeAndEmit(db, {
      message,
      severity,
      effectiveAtMs,
      expiresAtMs,
      createdBy: req.user!.userId,
      nowMs,
    });

    return mapPublicNotice(notice);
  }

  @Post("system/notices/:id/cancel")
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelSystemNotice(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    requireUuidParam(id, "Notice not found.", req.originalUrl);

    const won = await cancelNoticeAndEmit(db, { id, actorUserId: req.user!.userId, nowMs: clockNowMs() });
    if (!won) {
      throw notFound("Notice not found.", req.originalUrl);
    }
  }

  @Get("system/notices")
  async listSystemNotices(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const { cursor, limit } = parseCursorLimitQuery(query);
    const page = await listNoticesAdmin(db, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      nowMs: clockNowMs(),
    });
    return { items: page.rows.map(mapAdminNotice), nextCursor: page.nextCursor };
  }

  // ==========================================================================
  // any authenticated user: the active-notice catch-up read (NG2)
  // ==========================================================================

  @Get("notices/active")
  async getActiveSystemNotice(@Req() _req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    const nowMs = clockNowMs();
    const active = await getActiveNotice(db, nowMs);
    return { notice: active ? mapPublicNotice(active) : null, serverNowMs: nowMs };
  }
}
