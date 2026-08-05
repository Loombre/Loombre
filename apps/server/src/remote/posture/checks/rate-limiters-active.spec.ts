// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/rate-limiters-active.spec.ts
import { describe, expect, it } from "vitest";
import { gradeRateLimitersActive } from "./rate-limiters-active.js";

describe("gradeRateLimitersActive (R7 rateLimitersActive)", () => {
  it("passes when every unauth-surface limiter has a positive cap", () => {
    const outcome = gradeRateLimitersActive({ probe: 10, login: 10, refresh: 30, unlock: 5 });
    expect(outcome.grade).toBe("pass");
  });

  it("fails when any single limiter is zeroed", () => {
    const outcome = gradeRateLimitersActive({ probe: 0, login: 10, refresh: 30, unlock: 5 });
    expect(outcome.grade).toBe("fail");
    expect(outcome.detail).toContain("probe");
    expect(outcome.detail).not.toContain("login");
  });

  it("fails and names every zeroed limiter when more than one is zeroed", () => {
    const outcome = gradeRateLimitersActive({ probe: 0, login: -1, refresh: 30, unlock: 5 });
    expect(outcome.grade).toBe("fail");
    expect(outcome.detail).toContain("probe");
    expect(outcome.detail).toContain("login");
  });

  // FALSE-GREEN HUNT: packages/shared/src/settings-registry.ts's
  // rateLimit.* schemas all carry `z.number().int().min(1)`, and
  // parseEnvPositiveInt() silently discards a zero-or-negative env value
  // rather than letting it through — so a genuinely env-zeroed cap cannot
  // reach this function via the real settings pipeline today. This is
  // documented, not assumed: the grading function is still exercised
  // directly against a hostile <= 0 input here (bypassing the registry
  // entirely) so a future loosening of that floor is caught by an ALREADY
  // EXISTING red case, not a check nobody thought to write.
  it("BLIND SPOT — a hostile zero/negative cap fed directly (bypassing the registry's own min(1) floor) still fails, never passes", () => {
    const outcome = gradeRateLimitersActive({ probe: 10, login: 10, refresh: 30, unlock: -5 });
    expect(outcome.grade).toBe("fail");
    expect(outcome.grade).not.toBe("pass");
  });
});
