// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/wg-port-silence.spec.ts
import { describe, expect, it } from "vitest";
import { gradeWgPortSilence } from "./wg-port-silence.js";

describe("gradeWgPortSilence (R7 wgPortSilence)", () => {
  it("warns when the listener status is unknown (reader not wired / read failure)", () => {
    const outcome = gradeWgPortSilence(undefined);
    expect(outcome.grade).toBe("warn");
  });

  it("fails when enabled but genuinely not listening — a real, internally-verifiable problem", () => {
    const outcome = gradeWgPortSilence({ enabled: true, listening: false });
    expect(outcome.grade).toBe("fail");
  });

  it("is info (not pass) when the listener is confirmed bound", () => {
    const outcome = gradeWgPortSilence({ enabled: true, listening: true });
    expect(outcome.grade).toBe("info");
  });

  // FALSE-GREEN HUNT / R9's own hunting brief made literal: this check
  // must be STRUCTURALLY incapable of ever returning `pass` — there is no
  // vantage point inside the server process from which "scanners see
  // nothing" can be confirmed (the server cannot probe its own external
  // exposure). Enumerate every input this pure function accepts and assert
  // none of them ever produces `pass`.
  it("BLIND SPOT — never fakes a pass, for ANY input this function accepts", () => {
    const allInputs: Parameters<typeof gradeWgPortSilence>[0][] = [
      undefined,
      { enabled: true, listening: true },
      { enabled: true, listening: false },
      { enabled: false, listening: false },
      { enabled: false, listening: true },
    ];
    for (const input of allInputs) {
      expect(gradeWgPortSilence(input).grade).not.toBe("pass");
    }
  });
});
