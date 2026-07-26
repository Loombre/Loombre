// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/restricted.controller.ts
//
// POST /restricted/unlock, POST /restricted/lock (task spec, docs/PLAN.md
// §6.4 gate 5). Gate ordering: unlock only succeeds if gates 1-4 already
// pass (checked via resolveClearance with the live-unlock input forced to
// "not unlocked" — we're establishing gate 5 right now, so its current
// value is irrelevant to the precondition check).
//
// Phase 2 additions (STATE.md P2.1/P2.12): unlock is rate-limited PER-USER
// (PIN brute-force protection — a shared IP/NAT must not throttle other
// users, and an attacker guessing one account's PIN shouldn't get a wider
// budget by rotating source addresses) and every wrong-PIN attempt is
// written to the fail2ban-compatible anomaly log.
//
// P2.8 (websocket-presence lane): both handlers below now call
// setRestrictedUnlockUntilAndEmit (not the plain setRestrictedUnlockUntil)
// so the caller's OWN already-connected websocket sockets learn about the
// gate-5 transition immediately via a `restricted.unlocked`/`restricted.
// locked` outbox event, USER-SCOPED delivery only (packages/db/src/query/
// identity.ts, events.ts's USER_ONLY_TYPES). The expiry case (no explicit
// call to either endpoint) is handled separately, entirely inside the
// websocket broadcaster — see apps/server/src/gateway/
// ws-broadcaster.service.ts's header.
//
// GET /restricted/count (STATE.md Phosphor retheme, W1c "contract
// enablers" lane; design/phosphor README U10): the zone's aggregate item
// count, visible to entitled viewers REGARDLESS of current lock state —
// 404 (not a body carrying `count: 0`) for a viewer with no
// restricted-library entitlement at all, so a restricted-profile viewer
// cannot even infer the zone exists. See packages/db/src/query/
// restricted-zone.ts's header for the full entitlement-model writeup this
// implements.
//
// GET /restricted/items (STATE.md Phosphor retheme, Wave 2 lane L8): the
// zone's own item listing — same 404-for-not-entitled posture as count(),
// but ADDITIONALLY gate-5 (lock-state) sensitive: an entitled-but-locked
// caller gets 200 with an empty page (packages/db/src/query/
// restricted-zone.ts's "Restricted zone item listing" section explains why
// this, unlike count(), routes through the normal guard). No libraryId/q
// params — the zone's own library membership is resolved server-side from
// entitlement, and there is no separate zone-search endpoint (the web
// client fetches the small, curated zone in full and filters/sorts/
// searches it locally, deriving genre pills from the results rather than
// hardcoding them).

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters } from "@nestjs/common";
import {
  getLibraryPermissionSummary,
  getRestrictedZoneCountForViewer,
  getUserById,
  getUserSettings,
  listRestrictedZoneItemsForViewer,
  setRestrictedUnlockUntilAndEmit,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unauthorized, unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";
import {
  isRestrictedContentEnabled,
  resolveRestrictedMajorityAgeYears,
  resolveRestrictedUnlockDurationMs,
} from "../common/capabilities.js";
import { resolveClearance } from "../common/resolve-clearance.js";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";
import { AnomalyLogService } from "./anomaly-log.service.js";
import { tooManyRequests } from "../common/rate-limit.exception.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { SettingsService } from "../settings/settings.service.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";

interface UnlockRequestBody {
  pin?: unknown;
}

interface UnlockResponse {
  unlockedUntilMs: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

@Controller("restricted")
@UseFilters(RateLimitExceptionFilter)
export class RestrictedController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly anomalyLog: AnomalyLogService,
    private readonly settingsService: SettingsService,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Post("unlock")
  @HttpCode(HttpStatus.OK)
  async unlock(
    @Body() rawBody: UnlockRequestBody | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<UnlockResponse> {
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    const userId = req.user!.userId;

    const limit = this.rateLimiter.unlock.attempt(userId);
    if (!limit.allowed) {
      this.anomalyLog.log("RATE_LIMITED", { user: userId, op: "unlock" });
      throw tooManyRequests("Too many unlock attempts. Try again later.", instance, limit.retryAfterMs);
    }

    if (!isNonEmptyString(body.pin)) {
      // A missing/empty pin is a request-validation failure (UnlockRequest
      // requires `pin`, minLength 1), distinct from a WRONG pin (401,
      // below) — 422 per contract's documented UnprocessableEntity.
      throw unprocessableEntity("pin is required.", instance);
    }

    const db = this.dbProvider.db;
    const nowMs = clockNowMs();

    const [user, settings, permissions] = await Promise.all([
      getUserById(db, userId),
      getUserSettings(db, userId),
      getLibraryPermissionSummary(db, userId),
    ]);

    const precondition = resolveClearance({
      capabilityEnabled: isRestrictedContentEnabled(this.settingsService),
      birthDate: user?.birth_date ?? null,
      nowMs,
      majorityAgeYears: resolveRestrictedMajorityAgeYears(this.settingsService),
      optIn: settings?.restricted_opt_in ?? false,
      hasPin: settings?.restricted_pin_hash != null,
      hasRestrictedLibraryPermission: permissions.restrictedLibraryIds.length > 0,
      unlockedUntilMs: null, // gate 5 isn't established yet — irrelevant to this precondition
    });
    const gates1through4 =
      precondition.gates.g1 && precondition.gates.g2 && precondition.gates.g3 && precondition.gates.g4;

    if (!gates1through4) {
      throw forbidden(
        "Restricted-content unlock requires the server capability, age eligibility, opt-in with a PIN, and an explicit library grant (gates 1-4) to all pass first.",
        instance,
      );
    }

    const pinOk =
      settings?.restricted_pin_hash != null &&
      (await this.hashService.verify(settings.restricted_pin_hash, body.pin));
    if (!pinOk) {
      this.anomalyLog.log("PIN_FAILURE", { user: userId });
      throw unauthorized("Incorrect PIN.", instance);
    }

    const unlockedUntilMs = nowMs + resolveRestrictedUnlockDurationMs(this.settingsService);
    await setRestrictedUnlockUntilAndEmit(db, userId, unlockedUntilMs, nowMs);

    return { unlockedUntilMs };
  }

  @Post("lock")
  @HttpCode(HttpStatus.NO_CONTENT)
  async lock(@Req() req: AuthenticatedRequest): Promise<void> {
    const userId = req.user!.userId;
    await setRestrictedUnlockUntilAndEmit(this.dbProvider.db, userId, null, clockNowMs());
  }

  @Get("count")
  async count(@Req() req: AuthenticatedRequest): Promise<{ count: number }> {
    // Local resolveViewer equivalent (apps/server/src/catalog/viewer.ts's
    // pattern) — session/ must never import catalog/ (D2, dependency-
    // cruiser-enforced), so this three-line call is inlined here exactly
    // like apps/server/src/playback/viewer.ts's own local copy.
    const ctx = await this.viewerContextProvider.resolve(req.user!.userId, clockNowMs());
    const result = await getRestrictedZoneCountForViewer(this.dbProvider.db, ctx);
    if (!result) {
      // Not entitled (docs/PLAN.md §6.4 gates 1-4 never all passed) — the
      // zone does not exist for this viewer. 404, never a body carrying
      // `count: 0`, so a restricted-profile viewer cannot even infer the
      // zone exists (U10).
      throw notFound("Not found.", req.originalUrl);
    }
    return result;
  }

  // GET /restricted/items (STATE.md Phosphor retheme, Wave 2 lane L8;
  // design/phosphor README "Restricted content" — the zone's OWN query
  // surface). Same 404-for-not-entitled posture as count() above; unlike
  // count(), a real page (possibly EMPTY) requires the caller to also be
  // gate-5 unlocked — that distinction lives entirely inside
  // listRestrictedZoneItemsForViewer (packages/db/src/query/
  // restricted-zone.ts), this controller only maps undefined -> 404.
  @Get("items")
  async items(
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const ctx = await this.viewerContextProvider.resolve(req.user!.userId, clockNowMs());

    const cursor = typeof query["cursor"] === "string" ? query["cursor"] : undefined;
    let limit: number | undefined;
    if (typeof query["limit"] === "string") {
      const n = Number.parseInt(query["limit"], 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }

    const page = await listRestrictedZoneItemsForViewer(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!page) {
      // Not entitled at all — same "the zone does not exist for this
      // viewer" posture as count() (U10); never an empty-but-200 body for
      // this case specifically, since that would let a restricted-profile
      // viewer distinguish "zone exists, empty" from "no zone" via this
      // endpoint even though count() already refuses them the same way.
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows, nextCursor: page.nextCursor };
  }
}
