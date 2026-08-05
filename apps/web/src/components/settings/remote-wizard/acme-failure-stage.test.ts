// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: acme-failure-stage tests — every AcmeFailureStage classified
// from representative real detail text (see acme-failure-stage.ts's own
// header for where each pattern comes from), plus guidance coverage.

import { describe, expect, it } from "vitest";
import { ACME_FAILURE_STAGE_GUIDANCE, classifyAcmeFailureStage, type AcmeFailureStage } from "./acme-failure-stage.js";

describe("classifyAcmeFailureStage", () => {
  it("null or empty detail -> unknown", () => {
    expect(classifyAcmeFailureStage(null)).toBe("unknown");
    expect(classifyAcmeFailureStage("")).toBe("unknown");
    expect(classifyAcmeFailureStage("   ")).toBe("unknown");
  });

  it("Node bind errors (Http01ChallengeServer.listen) -> portBind", () => {
    expect(classifyAcmeFailureStage("listen EADDRINUSE: address already in use 0.0.0.0:80")).toBe("portBind");
    expect(classifyAcmeFailureStage("listen EACCES: permission denied 0.0.0.0:80")).toBe("portBind");
  });

  it("Let's Encrypt rate-limit errors -> rateLimited", () => {
    expect(classifyAcmeFailureStage('403 urn:ietf:params:acme:error:rateLimited :: too many certificates')).toBe("rateLimited");
    expect(classifyAcmeFailureStage("Too many requests, please try again later")).toBe("rateLimited");
  });

  it("DNS-shaped errors -> dns", () => {
    expect(classifyAcmeFailureStage("urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for example.com")).toBe("dns");
    expect(classifyAcmeFailureStage("getaddrinfo ENOTFOUND example.com: no such host")).toBe("dns");
  });

  it("challenge-validation-shaped errors -> challengeUnreachable", () => {
    expect(
      classifyAcmeFailureStage(
        'Authorization for example.com was not successful: 403 urn:ietf:params:acme:error:unauthorized :: The client lacks sufficient authorization',
      ),
    ).toBe("challengeUnreachable");
    expect(classifyAcmeFailureStage("connect ECONNREFUSED 203.0.113.5:80")).toBe("challengeUnreachable");
    expect(classifyAcmeFailureStage("Fetching http://example.com/.well-known/acme-challenge/abc: connection timed out")).toBe(
      "challengeUnreachable",
    );
  });

  it("an unrecognized message -> unknown, never mis-classified", () => {
    expect(classifyAcmeFailureStage("something completely unexpected happened")).toBe("unknown");
  });

  it("every AcmeFailureStage has non-empty guidance text", () => {
    const stages: AcmeFailureStage[] = ["portBind", "challengeUnreachable", "dns", "rateLimited", "unknown"];
    for (const stage of stages) {
      expect(ACME_FAILURE_STAGE_GUIDANCE[stage].length).toBeGreaterThan(20);
    }
  });
});
