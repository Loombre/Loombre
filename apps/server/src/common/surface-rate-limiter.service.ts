// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/surface-rate-limiter.service.ts
//
// STATE.md P4.15 (Phase 4 lane G1's rate-limit sweep): "rate limiting
// covers exactly 3 endpoints (login, refresh per-IP; unlock per-user) ...
// G1's sweep must cover every unauthenticated surface (incl.
// /system/capabilities, /healthz) and the ?token= media GETs" plus an
// export-surface review. This service holds the NEW named policies the
// sweep adds (login/refresh/unlock stay exactly where they are —
// AuthRateLimiterService, untouched by this file) — kept as a SEPARATE
// service rather than folded into AuthRateLimiterService for two reasons:
// (1) AuthRateLimiterService's own header documents it as auth-surface-
// specific by design; (2) this service must be importable from catalog/
// playback controllers (images/hls-file/session-file/subtitle-file/
// data-freedom), which is exactly why it lives in common/ rather than
// session/ — see rate-limiter.ts's header for the full module-boundary
// rationale.
//
// Coverage table (this wave's report has the full narrative + the
// exempt-vs-limit decisions):
//   - capabilities: GET /system/capabilities, unauthenticated, per-IP,
//     generous (cheap in-memory read, no DB/IO — the ceiling exists for
//     basic DoS-amplification hygiene on an unauthenticated route, not
//     because the handler itself is expensive).
//   - healthz: DELIBERATELY EXEMPT, not a policy here at all — see
//     health.controller.ts's own comment for the documented rationale
//     (container/systemd/LB health probes hit this every few seconds by
//     design; rate-limiting a zero-cost liveness ping would risk breaking
//     legitimate infrastructure for zero security benefit).
//   - mediaToken: the four `?token=` media GET families (images, HLS
//     manifest+segments, direct-play file, subtitle manifest+segment) —
//     keyed per AUTHENTICATED IDENTITY (userId:deviceId), not per-IP or
//     per-raw-token-string, so the same limit applies whether the request
//     arrived via the Authorization header or the ?token= fallback (P2.18).
//     GENEROUS ceiling — video seeking makes rapid bursts of segment/range
//     requests, and a poster grid can fire dozens of concurrent image
//     requests on one page load; this must never be tight enough to be
//     mistaken for a seeking regression the way the Phase-3 CSP blob:
//     incident was mistaken for a playback bug.
//   - export: GET /export — authenticated but HEAVY (a full catalog +
//     progress + user dump, streamed but still real DB/CPU work per STATE.md
//     P4.15's own "export surface review" instruction) — per-USER, tight
//     ceiling (a handful per hour), since nothing about normal product
//     usage calls this endpoint repeatedly in a short window.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration + hot-reload):
// every capacity now comes from SettingsService (packages/shared/src/
// settings-registry.ts's rateLimit.capabilities/mediaToken/export/setup
// entries, still env-pinnable via LOOMBRE_RATE_CAPABILITIES/
// LOOMBRE_RATE_MEDIA_TOKEN/LOOMBRE_RATE_EXPORT/LOOMBRE_RATE_SETUP, A8) instead
// of a raw process.env read in the constructor. Flipped requiresRestart to
// false in the registry in the SAME change: this service subscribes to
// SettingsService.onChange() and calls KeyedRateLimiter.updatePolicy() for
// whichever policy's key changed — see rate-limiter.ts's updatePolicy doc
// comment for why this applies to the very next bucket check, never
// retroactively.
//
// LIFECYCLE HAZARD — see auth-rate-limiter.service.ts's header for the
// full empirically-verified explanation: SettingsService's cache is not
// populated until ITS OWN `onApplicationBootstrap()` runs, which is AFTER
// every provider's constructor across the whole app. `safeEffectiveNumber()`
// below never throws (falls back to the registry default at construction
// time); `onApplicationBootstrap()` re-applies the real effective policy
// once SettingsService is guaranteed loaded — no externally-observable
// window exists (real traffic can't reach `.attempt()` before `app.listen()`).

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { KeyedRateLimiter, type TokenBucketOptions } from "./rate-limiter.js";
import { SettingsService } from "../settings/settings.service.js";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** Never throws — see this file's header ("LIFECYCLE HAZARD"). */
function safeEffectiveNumber(settingsService: SettingsService, key: string, fallback: number): number {
  try {
    const effective = settingsService.getEffective(key);
    return effective !== undefined ? (effective.value as number) : fallback;
  } catch {
    return fallback;
  }
}

function perMinutePolicy(settingsService: SettingsService, key: string, defaultCapacity: number): TokenBucketOptions {
  const capacity = safeEffectiveNumber(settingsService, key, defaultCapacity);
  return { capacity, refillMs: ONE_MINUTE_MS / capacity };
}

function perHourPolicy(settingsService: SettingsService, key: string, defaultCapacity: number): TokenBucketOptions {
  const capacity = safeEffectiveNumber(settingsService, key, defaultCapacity);
  return { capacity, refillMs: ONE_HOUR_MS / capacity };
}

@Injectable()
export class SurfaceRateLimiterService implements OnApplicationBootstrap {
  /** GET /system/capabilities — per-IP (default 120/min, rateLimit.capabilities). */
  readonly capabilities: KeyedRateLimiter;
  /** The four ?token= media GET families — per authenticated identity
   *  (default 600/min, rateLimit.mediaToken). */
  readonly mediaToken: KeyedRateLimiter;
  /** GET /export — per-user (default 5/hour, rateLimit.export). */
  readonly export: KeyedRateLimiter;
  /** GET /setup/state + POST /setup/first-admin — per-IP (default 20/min,
   *  rateLimit.setup). Unauthenticated first-boot surface. */
  readonly setup: KeyedRateLimiter;
  /** GET/POST /claim/{token} — per-IP (default 10/min, rateLimit.claim,
   *  M12). Unauthenticated invite-claim surface. */
  readonly claim: KeyedRateLimiter;

  constructor(private readonly settingsService: SettingsService) {
    this.capabilities = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.capabilities", 120));
    this.mediaToken = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.mediaToken", 600));
    this.export = new KeyedRateLimiter(perHourPolicy(settingsService, "rateLimit.export", 5));
    this.setup = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.setup", 20));
    this.claim = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.claim", 10));

    settingsService.onChange((event) => {
      switch (event.key) {
        case "rateLimit.capabilities":
          this.capabilities.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.capabilities", 120));
          break;
        case "rateLimit.mediaToken":
          this.mediaToken.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.mediaToken", 600));
          break;
        case "rateLimit.export":
          this.export.updatePolicy(perHourPolicy(this.settingsService, "rateLimit.export", 5));
          break;
        case "rateLimit.setup":
          this.setup.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.setup", 20));
          break;
        case "rateLimit.claim":
          this.claim.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.claim", 10));
          break;
        default:
          break;
      }
    });
  }

  /** Re-applies every policy from the NOW-guaranteed-loaded SettingsService
   *  cache — see this file's header ("LIFECYCLE HAZARD"). No-op per
   *  policy if the value hasn't actually changed since construction. */
  onApplicationBootstrap(): void {
    this.capabilities.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.capabilities", 120));
    this.mediaToken.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.mediaToken", 600));
    this.export.updatePolicy(perHourPolicy(this.settingsService, "rateLimit.export", 5));
    this.setup.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.setup", 20));
    this.claim.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.claim", 10));
  }
}
