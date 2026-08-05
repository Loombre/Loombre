// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/rate-limiters-active.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 rateLimitersActive, S1 lane). Pure
// grading function. Checks the unauth-surface policies R7 names: the probe
// endpoint's own limiter (rateLimit.probe, RG6) plus the three auth
// limiters (rateLimit.login/refresh/unlock, AuthRateLimiterService) — the
// impure "read the current effective settings value" half lives in
// ../remote-posture.service.ts (SettingsService.getEffective, same
// never-throws posture as surface-rate-limiter.service.ts's own
// safeEffectiveNumber).
//
// FALSE-GREEN HUNT: packages/shared/src/settings-registry.ts's own schema
// enforces `z.number().int().min(1)` on every one of these four keys, and
// parseEnvPositiveInt() silently drops a zero-or-negative env value back to
// DB-or-default rather than letting it through — so a genuinely
// env-zeroed cap CANNOT reach this check today via the legitimate
// settings pipeline; a `<= 0` reading is currently unreachable in
// practice. This check still tests the LIVE effective value explicitly
// (rather than trusting "the registry floor makes this impossible" and
// skipping the check) as a defense-in-depth backstop — if a future edit
// ever loosens that floor, or SettingsService.getEffective is ever wired
// to a source that bypasses schema validation, this is the one place that
// would actually catch it. Documented here so V-SEC doesn't mistake "this
// check never fires red today" for "this check is decorative."
//
// Nothing about this check can observe traffic actually BEING limited
// (that would require live token-bucket state, not settings) — it only
// proves the CONFIGURED ceiling is nonzero, matching the mission's literal
// wording ("have nonzero effective caps").

import type { PostureCheckOutcome } from "./types.js";

export interface RateLimiterCaps {
  probe: number;
  login: number;
  refresh: number;
  unlock: number;
}

const LABELS: Record<keyof RateLimiterCaps, string> = {
  probe: "probe (rateLimit.probe)",
  login: "login (rateLimit.login)",
  refresh: "refresh (rateLimit.refresh)",
  unlock: "unlock (rateLimit.unlock)",
};

export function gradeRateLimitersActive(caps: RateLimiterCaps): PostureCheckOutcome {
  const zeroed = (Object.keys(caps) as (keyof RateLimiterCaps)[]).filter((key) => !(caps[key] > 0));

  if (zeroed.length === 0) {
    return {
      grade: "pass",
      detail: "Every unauthenticated-surface rate limiter (probe, login, refresh, unlock) has a nonzero effective cap.",
    };
  }

  return {
    grade: "fail",
    detail: `The following rate limiter(s) have a zero-or-negative effective cap and are not actually limiting anything: ${zeroed.map((key) => LABELS[key]).join(", ")}.`,
  };
}
