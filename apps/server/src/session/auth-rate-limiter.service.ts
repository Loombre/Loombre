// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/auth-rate-limiter.service.ts
//
// The five auth-surface rate-limit policies (STATE.md P2.1/P2.12,
// docs/PLAN.md §10): POST /auth/login and POST /auth/refresh are each
// keyed per-IP (the resolved client address — see main.ts's trust-proxy
// wiring, P2.2) AND, independently, per-SUBMITTED-ACCOUNT (login) / per-
// SUBMITTED-DEVICE (refresh) — Fix Wave 3, AUD-A7d-001: the per-IP-only
// pair left a distributed attempt against one account/device unthrottled,
// since source-address diversity is cheap (IPv6 rotation) but a specific
// identifier/deviceId is not. POST /restricted/unlock is keyed per-USER
// (PIN brute-force protection scopes to the account being attacked, not
// the network origin, since a single IP can legitimately host many users
// behind NAT/shared networks) — the loginByIdentifier field above mirrors
// this exact precedent for the higher-value login route.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration + hot-reload):
// capacities now come from SettingsService (packages/shared/src/
// settings-registry.ts's rateLimit.login/refresh/unlock entries, still
// env-pinnable via LOOMBRE_RATE_LOGIN/LOOMBRE_RATE_REFRESH/LOOMBRE_RATE_UNLOCK,
// A8) instead of a raw process.env read in the constructor. S1 initially
// marked these requiresRestart:true (the old read site read env once at
// construction, this file's own prior header said so) — lane S3 flips
// them to requiresRestart:false in the SAME change that makes it actually
// safe: this service subscribes to SettingsService.onChange() and calls
// KeyedRateLimiter.updatePolicy() for whichever policy's key changed, which
// applies to the very next bucket check (rate-limiter.ts's own updatePolicy
// doc comment) — never retroactively, never dropping an in-flight request.
//
// A plain @Injectable(), constructor-injecting SettingsService only (see
// that class's own header for why an INTERFACE-typed constructor param
// would silently break Nest's DI resolution — SettingsService is a
// concrete class specifically so this works). Tests exercise the
// underlying pure `KeyedRateLimiter`/`TokenBucket` classes directly (see
// rate-limiter.spec.ts) with an injected fake clock; this service always
// uses the real system clock, and is itself unit-tested via plain
// `new AuthRateLimiterService(fakeSettingsService)` (bypassing Nest's
// container entirely, same pattern as hash.service.spec.ts) — see
// common/test-support/fake-settings-service.ts.
//
// LIFECYCLE HAZARD (found + fixed by lane S3, worth recording): Nest's DI
// container instantiates every provider's CONSTRUCTOR before ANY
// `OnApplicationBootstrap` hook runs anywhere in the app — including
// SettingsService's OWN `onApplicationBootstrap()`, which is what actually
// populates its cache (settings.service.ts's `bootstrap()`). Reading
// `settingsService.getEffective()` directly in THIS class's constructor
// therefore throws "must run before any read" on every real boot (proven
// empirically — see this lane's report). Fix: `safeInitialCapacity()`
// below never throws (falls back to the registry default if the cache
// isn't loaded yet, which is always true at construction time in
// production) so the constructor never crashes, and `onApplicationBootstrap()`
// (guaranteed to run AFTER SettingsService's own, since this service
// depends on it — verified empirically) re-applies the REAL effective
// policy via `updatePolicy()`. No externally-observable window exists
// where the "possibly wrong" constructor-time fallback could matter: real
// HTTP traffic can never reach `.attempt()` before `app.listen()`, which
// itself never runs until every module's `onApplicationBootstrap()` has
// completed.

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { KeyedRateLimiter, type TokenBucketOptions } from "../common/rate-limiter.js";
import { SettingsService } from "../settings/settings.service.js";

const ONE_MINUTE_MS = 60_000;

/** Never throws — falls back to `defaultCapacity` both when the key is
 *  genuinely absent AND when SettingsService's cache isn't loaded yet
 *  (constructor-time hazard, see this file's header). */
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

@Injectable()
export class AuthRateLimiterService implements OnApplicationBootstrap {
  /** POST /auth/login — per-IP (default 10/min, rateLimit.login). */
  readonly login: KeyedRateLimiter;
  /** POST /auth/login — per-SUBMITTED-IDENTIFIER (username/email, CITEXT-
   *  normalized: trim+lowercase — AUD-A7d-001, Fix Wave 3). A fully
   *  independent bucket from `login` above, closing docs/PLAN.md §10's
   *  "per-IP AND per-user" promise: a distributed attempt against one
   *  account from many source addresses (trivial via IPv6 rotation) faced
   *  only the per-IP cap before this existed. Keyed on the UNVERIFIED
   *  value the caller submitted, not a resolved user id — an unknown
   *  identifier costs an attacker the same budget as a real one, the same
   *  timing-parity discipline login()'s DUMMY_PASSWORD_HASH already
   *  establishes for the argon2id step. Mirrors `unlock` below's
   *  per-user precedent (restricted.controller.ts's own header: "an
   *  attacker guessing one account's PIN shouldn't get a wider budget by
   *  rotating source addresses") applied to the higher-value target.
   *  (default 20/min, rateLimit.loginByIdentifier). */
  readonly loginByIdentifier: KeyedRateLimiter;
  /** POST /auth/refresh — per-IP (default 30/min, rateLimit.refresh). */
  readonly refresh: KeyedRateLimiter;
  /** POST /auth/refresh — per-SUBMITTED-DEVICE-ID (AUD-A7d-001, Fix Wave
   *  3). Refresh tokens are opaque 256-bit values (refresh-token.service.ts)
   *  — brute-forcing one is computationally infeasible regardless of rate,
   *  so this is not a credential-guessing guard the way loginByIdentifier
   *  is. It closes the literal per-IP-only gap docs/PLAN.md §10 names for
   *  BOTH auth routes: a distributed attempt hammering one known device's
   *  refresh chain across many source addresses now shares one budget
   *  regardless of which address each attempt arrives from (default
   *  40/min, rateLimit.refreshByDevice). */
  readonly refreshByDevice: KeyedRateLimiter;
  /** POST /restricted/unlock — per-USER (default 5/min, rateLimit.unlock). */
  readonly unlock: KeyedRateLimiter;

  constructor(private readonly settingsService: SettingsService) {
    this.login = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.login", 10));
    this.loginByIdentifier = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.loginByIdentifier", 20));
    this.refresh = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.refresh", 30));
    this.refreshByDevice = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.refreshByDevice", 40));
    this.unlock = new KeyedRateLimiter(perMinutePolicy(settingsService, "rateLimit.unlock", 5));

    settingsService.onChange((event) => {
      switch (event.key) {
        case "rateLimit.login":
          this.login.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.login", 10));
          break;
        case "rateLimit.loginByIdentifier":
          this.loginByIdentifier.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.loginByIdentifier", 20));
          break;
        case "rateLimit.refresh":
          this.refresh.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.refresh", 30));
          break;
        case "rateLimit.refreshByDevice":
          this.refreshByDevice.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.refreshByDevice", 40));
          break;
        case "rateLimit.unlock":
          this.unlock.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.unlock", 5));
          break;
        default:
          break;
      }
    });
  }

  /** Re-applies each policy from the NOW-guaranteed-loaded SettingsService
   *  cache — corrects any constructor-time fallback before real traffic
   *  can ever observe it (see this file's header). `updatePolicy()` is a
   *  no-op when the value hasn't actually changed. */
  onApplicationBootstrap(): void {
    this.login.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.login", 10));
    this.loginByIdentifier.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.loginByIdentifier", 20));
    this.refresh.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.refresh", 30));
    this.refreshByDevice.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.refreshByDevice", 40));
    this.unlock.updatePolicy(perMinutePolicy(this.settingsService, "rateLimit.unlock", 5));
  }
}
