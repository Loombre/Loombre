// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/wizard-state.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R8, Wave 0 freeze). Exhaustive
// transition-table tests, modeled on apps/web/src/app/setup/
// wizard-state.ts's own precedent (pure module now, thin React orchestrator
// later — U1 consumes this).

import { describe, expect, it } from "vitest";
import {
  STAGE_ORDER,
  stageIndex,
  nextStage,
  previousStage,
  PATH_FLOW_STEPS,
  firstPathFlowStep,
  nextPathFlowStep,
  planPathSwitch,
  DISABLE_VERIFICATION_STEPS,
  deriveEntryStage,
  recommendPath,
  type StageId,
  type PathId,
  type PathFlowStepId,
} from "../../src/remote/wizard-state.js";

describe("STAGE_ORDER — the top-level R8 sequence", () => {
  it("is exactly interview -> recommendation -> path-flow -> proof -> posture-handoff", () => {
    expect(STAGE_ORDER).toEqual(["interview", "recommendation", "path-flow", "proof", "posture-handoff"]);
  });

  it("stageIndex/nextStage/previousStage walk the full sequence and clamp at both ends", () => {
    for (let i = 0; i < STAGE_ORDER.length; i++) {
      expect(stageIndex(STAGE_ORDER[i]!)).toBe(i);
    }
    expect(previousStage("interview")).toBe("interview"); // clamps, doesn't go negative
    expect(nextStage("posture-handoff")).toBe("posture-handoff"); // clamps at the end
    expect(nextStage("interview")).toBe("recommendation");
    expect(previousStage("recommendation")).toBe("interview");
  });

  it("every stage transition round-trips: nextStage(previousStage(s)) === s except at the first stage", () => {
    for (const stage of STAGE_ORDER.slice(1)) {
      expect(nextStage(previousStage(stage))).toBe(stage);
    }
  });
});

describe("PATH_FLOW_STEPS — per-path step ids (R2 remote / R4 tunnel / R5 direct)", () => {
  it("covers exactly remote, tunnel, direct (never 'none' — that's not a selectable wizard path)", () => {
    expect(Object.keys(PATH_FLOW_STEPS).sort()).toEqual(["direct", "remote", "tunnel"]);
  });

  it("remote's flow is enable then enroll the first device (R2)", () => {
    expect(PATH_FLOW_STEPS.remote).toEqual(["remote-enable", "remote-enroll-first-device"]);
  });

  it("tunnel's flow is token then enable (R4)", () => {
    expect(PATH_FLOW_STEPS.tunnel).toEqual(["tunnel-token", "tunnel-enable"]);
  });

  it("direct's flow is mode -> acme-test -> enable -> router instructions (R5)", () => {
    expect(PATH_FLOW_STEPS.direct).toEqual(["direct-mode", "direct-acme-test", "direct-enable", "direct-router-instructions"]);
  });

  it("firstPathFlowStep returns each path's first step", () => {
    for (const path of ["remote", "tunnel", "direct"] as const) {
      expect(firstPathFlowStep(path)).toBe(PATH_FLOW_STEPS[path][0]);
    }
  });
});

describe("nextPathFlowStep — exhaustive transition table", () => {
  it("remote: enable -> enroll-first-device -> null (complete)", () => {
    expect(nextPathFlowStep("remote", "remote-enable", {})).toBe("remote-enroll-first-device");
    expect(nextPathFlowStep("remote", "remote-enroll-first-device", {})).toBeNull();
  });

  it("tunnel: token -> enable -> null (complete)", () => {
    expect(nextPathFlowStep("tunnel", "tunnel-token", {})).toBe("tunnel-enable");
    expect(nextPathFlowStep("tunnel", "tunnel-enable", {})).toBeNull();
  });

  it("direct mode=acme: mode -> acme-test -> enable -> router-instructions -> null (R5: full ACME flow)", () => {
    expect(nextPathFlowStep("direct", "direct-mode", { directMode: "acme" })).toBe("direct-acme-test");
    expect(nextPathFlowStep("direct", "direct-acme-test", { directMode: "acme" })).toBe("direct-enable");
    expect(nextPathFlowStep("direct", "direct-enable", { directMode: "acme" })).toBe("direct-router-instructions");
    expect(nextPathFlowStep("direct", "direct-router-instructions", { directMode: "acme" })).toBeNull();
  });

  it("direct mode=reverse-proxy: mode SKIPS acme-test straight to enable -> router-instructions -> null (R5: nothing to test)", () => {
    expect(nextPathFlowStep("direct", "direct-mode", { directMode: "reverse-proxy" })).toBe("direct-enable");
    expect(nextPathFlowStep("direct", "direct-enable", { directMode: "reverse-proxy" })).toBe("direct-router-instructions");
    expect(nextPathFlowStep("direct", "direct-router-instructions", { directMode: "reverse-proxy" })).toBeNull();
  });

  it("direct-mode with no directMode context yet behaves as the default (undecided) linear order — acme-test next", () => {
    expect(nextPathFlowStep("direct", "direct-mode", {})).toBe("direct-acme-test");
  });

  it("throws for a step that does not belong to the given path (a caller bug, never silently ignored)", () => {
    expect(() => nextPathFlowStep("remote", "tunnel-token" as unknown as PathFlowStepId, {})).toThrow();
  });

  it("every path's flow is reachable end-to-end from its first step by repeated nextPathFlowStep calls", () => {
    const paths: readonly { path: PathId; context: Parameters<typeof nextPathFlowStep>[2] }[] = [
      { path: "remote", context: {} },
      { path: "tunnel", context: {} },
      { path: "direct", context: { directMode: "acme" } },
      { path: "direct", context: { directMode: "reverse-proxy" } },
    ];
    for (const { path, context } of paths) {
      let current: PathFlowStepId | null = firstPathFlowStep(path);
      const visited: PathFlowStepId[] = [];
      while (current !== null) {
        visited.push(current);
        current = nextPathFlowStep(path, current, context);
      }
      // Every step actually belonging to the path's own step list is
      // visited under the acme context (the exhaustive branch); under
      // reverse-proxy, direct-acme-test is deliberately skipped.
      if (path !== "direct" || context.directMode === "acme") {
        expect(visited).toEqual(PATH_FLOW_STEPS[path]);
      } else {
        expect(visited).toEqual(["direct-mode", "direct-enable", "direct-router-instructions"]);
      }
    }
  });
});

describe("planPathSwitch — switch/disable flows (R8)", () => {
  it("no active path ('none') -> no teardown required, starts at the target's first step", () => {
    const plan = planPathSwitch("none", "tunnel");
    expect(plan.requiresTeardown).toBe(false);
    expect(plan.teardownPath).toBeNull();
    expect(plan.firstStep).toBe("tunnel-token");
  });

  it("switching to a DIFFERENT active path requires teardown of the old one first (R8: switch = verified teardown then enable)", () => {
    const plan = planPathSwitch("remote", "direct");
    expect(plan.requiresTeardown).toBe(true);
    expect(plan.teardownPath).toBe("remote");
    expect(plan.firstStep).toBe("direct-mode");
  });

  it("re-selecting the CURRENTLY active path requires no teardown (idempotent re-entry, not a switch)", () => {
    const plan = planPathSwitch("tunnel", "tunnel");
    expect(plan.requiresTeardown).toBe(false);
    expect(plan.teardownPath).toBeNull();
  });

  it("every (from, to) pair over none/remote/tunnel/direct x remote/tunnel/direct produces a defined plan", () => {
    const fromPaths: readonly ("none" | PathId)[] = ["none", "remote", "tunnel", "direct"];
    const toPaths: readonly PathId[] = ["remote", "tunnel", "direct"];
    for (const from of fromPaths) {
      for (const to of toPaths) {
        const plan = planPathSwitch(from, to);
        expect(plan.firstStep).toBe(firstPathFlowStep(to));
        expect(plan.requiresTeardown).toBe(from !== "none" && from !== to);
      }
    }
  });
});

describe("DISABLE_VERIFICATION_STEPS — what 'disable' verifies per path (R8/R9)", () => {
  it("remote verifies peer revocation and listener drop (R9: peers revoked, listener dropped)", () => {
    expect(DISABLE_VERIFICATION_STEPS.remote).toContain("revoke-peers");
    expect(DISABLE_VERIFICATION_STEPS.remote).toContain("drop-listeners");
  });

  it("tunnel verifies connector teardown", () => {
    expect(DISABLE_VERIFICATION_STEPS.tunnel).toEqual(["teardown-connector"]);
  });

  it("direct verifies listener/cert-state drop", () => {
    expect(DISABLE_VERIFICATION_STEPS.direct).toEqual(["drop-listeners"]);
  });

  it("every path has at least one verification step — disable is never a silent no-op", () => {
    for (const path of ["remote", "tunnel", "direct"] as const) {
      expect(DISABLE_VERIFICATION_STEPS[path].length).toBeGreaterThan(0);
    }
  });
});

describe("deriveEntryStage — wizard re-entry read (GET /admin/remote/state)", () => {
  it("activePath 'none' -> interview (a fresh wizard run)", () => {
    expect(deriveEntryStage({ activePath: "none" })).toBe("interview");
  });

  it.each(["remote", "tunnel", "direct"] as const)("activePath '%s' -> posture-handoff (re-entry lands on the handoff, not the interview)", (path) => {
    expect(deriveEntryStage({ activePath: path })).toBe("posture-handoff");
  });
});

describe("recommendPath — R8's interview -> recommendation heuristic (pure, total)", () => {
  it("everyone willing to install an app AND no shareable-URL need -> remote (least attack surface, no third party, no router touch)", () => {
    expect(
      recommendPath({ everyoneWillingToInstallApp: true, needsPubliclyShareableUrl: false, comfortableWithRouterSettings: false }),
    ).toBe("remote");
  });

  it("needs a shareable URL and comfortable with router settings -> direct (avoids the third-party dependency)", () => {
    expect(
      recommendPath({ everyoneWillingToInstallApp: false, needsPubliclyShareableUrl: true, comfortableWithRouterSettings: true }),
    ).toBe("direct");
  });

  it("needs a shareable URL and NOT comfortable with router settings -> tunnel (BYO token, no router touch)", () => {
    expect(
      recommendPath({ everyoneWillingToInstallApp: true, needsPubliclyShareableUrl: true, comfortableWithRouterSettings: false }),
    ).toBe("tunnel");
  });

  it("not everyone willing to install an app, no shareable-URL need, comfortable with router settings -> direct", () => {
    expect(
      recommendPath({ everyoneWillingToInstallApp: false, needsPubliclyShareableUrl: false, comfortableWithRouterSettings: true }),
    ).toBe("direct");
  });

  it("not everyone willing, no shareable-URL need, not comfortable with router settings -> tunnel (least-friction fallback)", () => {
    expect(
      recommendPath({ everyoneWillingToInstallApp: false, needsPubliclyShareableUrl: false, comfortableWithRouterSettings: false }),
    ).toBe("tunnel");
  });

  it("is exhaustive and total over all 8 boolean combinations — never throws, always returns a valid PathId", () => {
    const VALID: readonly PathId[] = ["remote", "tunnel", "direct"];
    for (const everyoneWillingToInstallApp of [true, false]) {
      for (const needsPubliclyShareableUrl of [true, false]) {
        for (const comfortableWithRouterSettings of [true, false]) {
          const result = recommendPath({ everyoneWillingToInstallApp, needsPubliclyShareableUrl, comfortableWithRouterSettings });
          expect(VALID).toContain(result);
        }
      }
    }
  });
});

describe("StageId/PathId — exported types line up with the runtime constants (compile-time sanity via usage)", () => {
  it("STAGE_ORDER members are all valid StageId values", () => {
    const s: StageId = STAGE_ORDER[0]!;
    expect(typeof s).toBe("string");
  });
});
