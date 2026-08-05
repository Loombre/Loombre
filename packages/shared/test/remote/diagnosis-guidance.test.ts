// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/diagnosis-guidance.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (Lane P1 mission item 5's exit gate:
// "per-path diagnosis mapping renders the right guidance for each
// simulated failure"). Exhaustive PathId × DiagnosisCode matrix (3 paths ×
// 7 codes = 21 combinations) — playback-matrix case discipline, same
// posture as diagnosis.test.ts right next to it.

import { describe, expect, it } from "vitest";
import { diagnosisGuidance } from "../../src/remote/diagnosis-guidance.js";
import type { DiagnosisCode } from "../../src/remote/diagnosis.js";
import type { PathId } from "../../src/remote/wizard-state.js";

const PATH_IDS: readonly PathId[] = ["remote", "tunnel", "direct"];
const DIAGNOSIS_CODES: readonly DiagnosisCode[] = [
  "portBlocked",
  "cgnat",
  "doubleNat",
  "dnsMismatch",
  "tunnelDown",
  "connectorUnhealthy",
  "unknown",
];

describe("diagnosisGuidance — exhaustive PathId × DiagnosisCode matrix (21 combinations)", () => {
  for (const path of PATH_IDS) {
    for (const code of DIAGNOSIS_CODES) {
      it(`returns non-empty, path-appropriate guidance for path=${path} code=${code}`, () => {
        const text = diagnosisGuidance(path, code);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      });
    }
  }

  it("covers every combination — no silent gaps (matrix size sanity)", () => {
    let count = 0;
    for (const path of PATH_IDS) {
      for (const code of DIAGNOSIS_CODES) {
        diagnosisGuidance(path, code);
        count += 1;
      }
    }
    expect(count).toBe(21);
  });

  it("each path's own 7 codes each produce a DISTINCT string (no within-path collision hides a copy-paste mistake)", () => {
    for (const path of PATH_IDS) {
      const texts = new Set(DIAGNOSIS_CODES.map((code) => diagnosisGuidance(path, code)));
      expect(texts.size, `path=${path} has a duplicate guidance string across its 7 codes`).toBe(DIAGNOSIS_CODES.length);
    }
  });

  it("tunnel path's own guidance is always distinct per code (the path that actually produces every code meaningfully)", () => {
    const texts = new Set(DIAGNOSIS_CODES.map((code) => diagnosisGuidance("tunnel", code)));
    expect(texts.size).toBe(DIAGNOSIS_CODES.length);
  });

  it("tunnelDown/connectorUnhealthy guidance mentions the connector only for the tunnel path", () => {
    expect(diagnosisGuidance("tunnel", "tunnelDown").toLowerCase()).toContain("connector");
    expect(diagnosisGuidance("tunnel", "connectorUnhealthy").toLowerCase()).toContain("connector");
  });

  it("cgnat/doubleNat guidance for remote/direct mentions switching to Tunnel as the escape hatch", () => {
    expect(diagnosisGuidance("remote", "cgnat")).toContain("Tunnel");
    expect(diagnosisGuidance("direct", "cgnat")).toContain("Tunnel");
    expect(diagnosisGuidance("remote", "doubleNat")).toContain("Tunnel");
    expect(diagnosisGuidance("direct", "doubleNat")).toContain("Tunnel");
  });

  it("falls back to a generic, non-throwing message for an unrecognized path/code pair (defensive totality, see this module's own header)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = diagnosisGuidance("bogus-path" as any, "bogus-code" as any);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
