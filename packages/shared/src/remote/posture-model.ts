// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/posture-model.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7, Wave 0 freeze).
//
// THE POSTURE MODEL — closed check-key/grade unions, the fix-action link
// model, applicability rules (which checks apply per active path), and
// pure grading composition. This module never CHECKS anything itself (no
// I/O, no DB/network reads) — S1 implements the real per-check checkers
// server-side later and feeds their results through deriveCardState below.
// RG4's adjudication governs delivery: a regression/recovery here is
// reported over the admin-only outbox (posture.regressed/posture.recovered,
// packages/contract/event-schemas), never auto-composed into system_notices
// (which stays human-composed only, one active slot).

/** The closed set of posture checks (R7). Three are path-specific
 *  (tlsValidity/wgPortSilence/connectorHealth — each applies to exactly
 *  one path); the rest are universal (apply whenever any path is active). */
export const POSTURE_CHECK_KEYS = [
  "tlsValidity",
  "rateLimitersActive",
  "staleAccounts",
  "inviteLinksReachable",
  "wgPortSilence",
  "connectorHealth",
  "publicUrlCoherence",
] as const;

export type PostureCheckKey = (typeof POSTURE_CHECK_KEYS)[number];

/** Grade union (R7). Ordered worst-to-best is FAIL > WARN > INFO > PASS —
 *  see GRADE_SEVERITY below, the single source that ordering is derived
 *  from (never re-declared elsewhere in this module). */
export type PostureGrade = "pass" | "warn" | "fail" | "info";

/** Mirrors RemotePathId in openapi.yaml — the DERIVED active-path union
 *  (RG15), with 'none' meaning no path is enabled and the card is
 *  inactive (R7: "activates when any path is enabled"). */
export type PostureActivePath = "none" | "remote" | "tunnel" | "direct";

export interface FixAction {
  /** Short, human-facing label for the link ("Review TLS certificate"). */
  label: string;
  /** A settings-section or wizard-step path the admin UI can route to
   *  directly (apps/web's router paths — this module stays framework-free
   *  and only carries the string, never a component reference). */
  href: string;
}

/** R7: "Grades link to fix actions." One fixed destination per check —
 *  the checkers server-side (S1) don't choose this; it's frozen here so
 *  every lane routes an admin to the same place for the same check. */
export const POSTURE_CHECK_FIX_ACTIONS: Record<PostureCheckKey, FixAction> = {
  tlsValidity: { label: "Review the Direct path's certificate", href: "/settings/remote-access?path=direct&step=direct-enable" },
  rateLimitersActive: { label: "Review rate-limit settings", href: "/settings/server?category=rateLimit" },
  staleAccounts: { label: "Review user accounts", href: "/settings/users" },
  inviteLinksReachable: { label: "Review pending invites", href: "/settings/users?tab=invites" },
  wgPortSilence: { label: "Review the Remote (WireGuard) listener", href: "/settings/remote-access?path=remote" },
  connectorHealth: { label: "Review the Tunnel connector", href: "/settings/remote-access?path=tunnel&step=tunnel-enable" },
  publicUrlCoherence: { label: "Review the public URL setting", href: "/settings/server?category=network" },
};

/** Per-path applicability (R7's own enumeration): the three path-specific
 *  checks map to exactly the path that names them in R7's text; every
 *  other check is universal — relevant no matter which path is active,
 *  because enabling ANY path is the shared precondition that makes it
 *  matter (exposure-aware, not path-flavor-aware). */
const PATH_SPECIFIC_CHECKS: Record<Exclude<PostureActivePath, "none">, PostureCheckKey> = {
  remote: "wgPortSilence",
  tunnel: "connectorHealth",
  direct: "tlsValidity",
};

const UNIVERSAL_CHECKS: readonly PostureCheckKey[] = [
  "rateLimitersActive",
  "staleAccounts",
  "inviteLinksReachable",
  "publicUrlCoherence",
];

/** Which POSTURE_CHECK_KEYS apply for a given active (non-'none') path —
 *  the universal four plus that path's own path-specific check. */
export function applicableChecks(path: Exclude<PostureActivePath, "none">): readonly PostureCheckKey[] {
  return [...UNIVERSAL_CHECKS, PATH_SPECIFIC_CHECKS[path]];
}

/** Exported (S1 lane, R7/RG4): the background regression scheduler
 *  (apps/server/src/remote/posture/remote-posture-regression.scheduler.ts)
 *  needs the SAME worst-to-best ordering `overallGrade` composes from to
 *  classify a grade change as a regression (severity increased) vs a
 *  recovery (severity decreased) — re-declaring the table there would risk
 *  the two orderings silently drifting apart. */
export const GRADE_SEVERITY: Record<PostureGrade, number> = { pass: 0, info: 1, warn: 2, fail: 3 };

export interface PostureCheckResult {
  checkKey: PostureCheckKey;
  grade: PostureGrade;
}

/** Worst-of composition (order-independent): the card's overall grade is
 *  the single worst grade among its checks, defaulting to 'pass' for an
 *  empty result set (nothing checked yet is not itself a failure). */
export function overallGrade(results: readonly PostureCheckResult[]): PostureGrade {
  let worst: PostureGrade = "pass";
  for (const result of results) {
    if (GRADE_SEVERITY[result.grade] > GRADE_SEVERITY[worst]) {
      worst = result.grade;
    }
  }
  return worst;
}

export interface PostureCardCheck extends PostureCheckResult {
  fixAction: FixAction;
}

export interface PostureCardState {
  /** R7: the card activates when any path is enabled; false (and empty
   *  checks) when activePath is 'none'. */
  active: boolean;
  overallGrade: PostureGrade;
  checks: readonly PostureCardCheck[];
}

/**
 * Composes the fixture the posture card renders from: applicability +
 * supplied results + fix-action links, all pure. A check applicable to the
 * active path with no reported result surfaces as `info` (S1 hasn't run it
 * yet is a fact worth surfacing honestly, never silently defaulted to
 * `pass`); a result supplied for a check NOT applicable to the active path
 * is ignored (never leaked into the card).
 */
export function deriveCardState(path: PostureActivePath, results: ReadonlyMap<PostureCheckKey, PostureGrade>): PostureCardState {
  if (path === "none") {
    return { active: false, overallGrade: "pass", checks: [] };
  }

  const checks: PostureCardCheck[] = applicableChecks(path).map((checkKey) => ({
    checkKey,
    grade: results.get(checkKey) ?? "info",
    fixAction: POSTURE_CHECK_FIX_ACTIONS[checkKey],
  }));

  return { active: true, overallGrade: overallGrade(checks), checks };
}
