// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/posture-model.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7, Wave 0 freeze). Fixture-driven
// tests for the applicability + grading composition logic — S1 implements
// the real per-check checkers server-side later; this module only owns the
// closed unions, the applicability rule, the fix-action link model, and
// pure composition (never a live check itself).

import { describe, expect, it } from "vitest";
import {
  POSTURE_CHECK_KEYS,
  POSTURE_CHECK_FIX_ACTIONS,
  applicableChecks,
  overallGrade,
  deriveCardState,
  type PostureCheckKey,
  type PostureGrade,
  type PostureActivePath,
} from "../../src/remote/posture-model.js";

describe("POSTURE_CHECK_KEYS — the closed union (R7)", () => {
  it("is exactly these 7 keys", () => {
    expect([...POSTURE_CHECK_KEYS].sort()).toEqual(
      [
        "tlsValidity",
        "rateLimitersActive",
        "staleAccounts",
        "inviteLinksReachable",
        "wgPortSilence",
        "connectorHealth",
        "publicUrlCoherence",
      ].sort(),
    );
  });

  it("every key has a fix action with a non-empty label and href", () => {
    for (const key of POSTURE_CHECK_KEYS) {
      const action = POSTURE_CHECK_FIX_ACTIONS[key];
      expect(action.label.length, `${key} fix action label`).toBeGreaterThan(0);
      expect(action.href.length, `${key} fix action href`).toBeGreaterThan(0);
    }
  });
});

describe("applicableChecks — per-path applicability rules (R7)", () => {
  it("Remote: wgPortSilence applies, connectorHealth and tlsValidity do not", () => {
    const checks = applicableChecks("remote");
    expect(checks).toContain("wgPortSilence");
    expect(checks).not.toContain("connectorHealth");
    expect(checks).not.toContain("tlsValidity");
  });

  it("Tunnel: connectorHealth applies, wgPortSilence and tlsValidity do not", () => {
    const checks = applicableChecks("tunnel");
    expect(checks).toContain("connectorHealth");
    expect(checks).not.toContain("wgPortSilence");
    expect(checks).not.toContain("tlsValidity");
  });

  it("Direct: tlsValidity applies, wgPortSilence and connectorHealth do not", () => {
    const checks = applicableChecks("direct");
    expect(checks).toContain("tlsValidity");
    expect(checks).not.toContain("wgPortSilence");
    expect(checks).not.toContain("connectorHealth");
  });

  it("universal checks (rateLimitersActive, staleAccounts, inviteLinksReachable, publicUrlCoherence) apply to every path", () => {
    const universal: readonly PostureCheckKey[] = ["rateLimitersActive", "staleAccounts", "inviteLinksReachable", "publicUrlCoherence"];
    for (const path of ["remote", "tunnel", "direct"] as const) {
      const checks = applicableChecks(path);
      for (const key of universal) {
        expect(checks, `${path} should include ${key}`).toContain(key);
      }
    }
  });

  it("every path-specific check (tlsValidity/wgPortSilence/connectorHealth) applies to exactly ONE path", () => {
    const pathSpecific: readonly PostureCheckKey[] = ["tlsValidity", "wgPortSilence", "connectorHealth"];
    for (const key of pathSpecific) {
      const applicablePaths = (["remote", "tunnel", "direct"] as const).filter((path) => applicableChecks(path).includes(key));
      expect(applicablePaths, key).toHaveLength(1);
    }
  });
});

describe("overallGrade — worst-of composition", () => {
  it("empty result set -> pass", () => {
    expect(overallGrade([])).toBe("pass");
  });

  it("all pass -> pass", () => {
    expect(overallGrade([{ checkKey: "staleAccounts", grade: "pass" }, { checkKey: "publicUrlCoherence", grade: "pass" }])).toBe("pass");
  });

  it("one fail among passes -> fail (fail is worst)", () => {
    expect(
      overallGrade([
        { checkKey: "staleAccounts", grade: "pass" },
        { checkKey: "connectorHealth", grade: "fail" },
        { checkKey: "publicUrlCoherence", grade: "pass" },
      ]),
    ).toBe("fail");
  });

  it("warn beats info and pass, but loses to fail", () => {
    expect(overallGrade([{ checkKey: "staleAccounts", grade: "warn" }, { checkKey: "publicUrlCoherence", grade: "info" }])).toBe("warn");
    expect(overallGrade([{ checkKey: "staleAccounts", grade: "warn" }, { checkKey: "connectorHealth", grade: "fail" }])).toBe("fail");
  });

  it("info beats pass", () => {
    expect(overallGrade([{ checkKey: "inviteLinksReachable", grade: "info" }, { checkKey: "staleAccounts", grade: "pass" }])).toBe("info");
  });

  it("order of results never changes the outcome", () => {
    const a = [{ checkKey: "staleAccounts" as PostureCheckKey, grade: "warn" as PostureGrade }, { checkKey: "connectorHealth" as PostureCheckKey, grade: "fail" as PostureGrade }];
    const b = [...a].reverse();
    expect(overallGrade(a)).toBe(overallGrade(b));
  });
});

describe("deriveCardState — the fixture the posture card renders from", () => {
  it("path 'none' -> inactive, empty checks, overallGrade pass (R7: activates only when a path is enabled)", () => {
    const state = deriveCardState("none", new Map());
    expect(state.active).toBe(false);
    expect(state.checks).toEqual([]);
    expect(state.overallGrade).toBe("pass");
  });

  it("Remote with every applicable check passing -> active, all pass, overallGrade pass", () => {
    const results = new Map<PostureCheckKey, PostureGrade>([
      ["rateLimitersActive", "pass"],
      ["staleAccounts", "pass"],
      ["inviteLinksReachable", "pass"],
      ["wgPortSilence", "pass"],
      ["publicUrlCoherence", "pass"],
    ]);
    const state = deriveCardState("remote", results);
    expect(state.active).toBe(true);
    expect(state.overallGrade).toBe("pass");
    expect(state.checks.map((c) => c.checkKey).sort()).toEqual(applicableChecks("remote").slice().sort());
    expect(state.checks.every((c) => c.grade === "pass")).toBe(true);
  });

  it("Direct with a failing tlsValidity -> overallGrade fail, and that check carries its fix action", () => {
    const results = new Map<PostureCheckKey, PostureGrade>([
      ["tlsValidity", "fail"],
      ["rateLimitersActive", "pass"],
      ["staleAccounts", "pass"],
      ["inviteLinksReachable", "pass"],
      ["publicUrlCoherence", "pass"],
    ]);
    const state = deriveCardState("direct", results);
    expect(state.overallGrade).toBe("fail");
    const tlsCheck = state.checks.find((c) => c.checkKey === "tlsValidity");
    expect(tlsCheck?.grade).toBe("fail");
    expect(tlsCheck?.fixAction).toEqual(POSTURE_CHECK_FIX_ACTIONS.tlsValidity);
  });

  it("a check with no reported result surfaces as 'info', never silently 'pass' (S1 hasn't run it yet is a fact worth surfacing)", () => {
    const state = deriveCardState("tunnel", new Map());
    expect(state.checks.every((c) => c.grade === "info")).toBe(true);
    expect(state.overallGrade).toBe("info");
  });

  it("never includes a check inapplicable to the active path, even if a result was supplied for it", () => {
    const results = new Map<PostureCheckKey, PostureGrade>([
      ["tlsValidity", "fail"], // irrelevant for Remote — must be ignored, not leaked into the card
      ["wgPortSilence", "pass"],
    ]);
    const state = deriveCardState("remote", results);
    expect(state.checks.map((c) => c.checkKey)).not.toContain("tlsValidity");
  });

  it("path type covers exactly none/remote/tunnel/direct (mirrors RemotePathId in openapi.yaml)", () => {
    const paths: readonly PostureActivePath[] = ["none", "remote", "tunnel", "direct"];
    for (const path of paths) {
      expect(() => deriveCardState(path, new Map())).not.toThrow();
    }
  });
});
