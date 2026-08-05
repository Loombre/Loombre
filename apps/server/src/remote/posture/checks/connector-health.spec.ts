// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/connector-health.spec.ts
import { describe, expect, it } from "vitest";
import { gradeConnectorHealth, type ConnectorHealthState } from "./connector-health.js";

describe("gradeConnectorHealth (R7 connectorHealth)", () => {
  it("defaults unknown to warn (mission brief, verbatim)", () => {
    expect(gradeConnectorHealth("unknown").grade).toBe("warn");
  });

  it("passes when running", () => {
    expect(gradeConnectorHealth("running").grade).toBe("pass");
  });

  it("is info while starting", () => {
    expect(gradeConnectorHealth("starting").grade).toBe("info");
  });

  it("warns when degraded", () => {
    expect(gradeConnectorHealth("degraded").grade).toBe("warn");
  });

  it("fails when stopped", () => {
    expect(gradeConnectorHealth("stopped").grade).toBe("fail");
  });

  it("fails on a reported error", () => {
    expect(gradeConnectorHealth("error").grade).toBe("fail");
  });

  // FALSE-GREEN HUNT: "running" here only means the supervised child
  // process is alive and hasn't reported an error to its OWN supervisor —
  // it cannot verify Cloudflare's edge considers the tunnel healthy, and
  // it cannot verify DNS for the tunnel hostname currently resolves to it.
  // A `pass` grade is honest about process-liveness only, never about
  // end-to-end reachability (that stronger claim belongs to R6's proof).
  it("BLIND SPOT — every state is exercised, and 'pass' is reachable ONLY through 'running' (process-liveness, not end-to-end proof)", () => {
    const states: ConnectorHealthState[] = ["unknown", "stopped", "starting", "running", "degraded", "error"];
    const passStates = states.filter((s) => gradeConnectorHealth(s).grade === "pass");
    expect(passStates).toEqual(["running"]);
  });
});
