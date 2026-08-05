// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/public-url-coherence.spec.ts
import { describe, expect, it } from "vitest";
import { gradePublicUrlCoherence } from "./public-url-coherence.js";

describe("gradePublicUrlCoherence (R7 publicUrlCoherence)", () => {
  describe("tunnel", () => {
    it("fails when no tunnel hostname is configured", () => {
      const outcome = gradePublicUrlCoherence({ path: "tunnel", publicUrl: "", tunnelHostname: "" });
      expect(outcome.grade).toBe("fail");
    });

    it("fails when publicUrl does not match https://<tunnelHostname>", () => {
      const outcome = gradePublicUrlCoherence({ path: "tunnel", publicUrl: "https://wrong.example.com", tunnelHostname: "tunnel.example.com" });
      expect(outcome.grade).toBe("fail");
    });

    it("passes when publicUrl equals https://<tunnelHostname> exactly", () => {
      const outcome = gradePublicUrlCoherence({ path: "tunnel", publicUrl: "https://tunnel.example.com", tunnelHostname: "tunnel.example.com" });
      expect(outcome.grade).toBe("pass");
    });
  });

  describe("direct", () => {
    it("fails when unset", () => {
      const outcome = gradePublicUrlCoherence({ path: "direct", publicUrl: "", tunnelHostname: "" });
      expect(outcome.grade).toBe("fail");
    });

    it("fails when set but not https", () => {
      const outcome = gradePublicUrlCoherence({ path: "direct", publicUrl: "http://example.com", tunnelHostname: "" });
      expect(outcome.grade).toBe("fail");
    });

    it("passes when set and https", () => {
      const outcome = gradePublicUrlCoherence({ path: "direct", publicUrl: "https://example.com", tunnelHostname: "" });
      expect(outcome.grade).toBe("pass");
    });
  });

  describe("remote", () => {
    it("passes when unset", () => {
      const outcome = gradePublicUrlCoherence({ path: "remote", publicUrl: "", tunnelHostname: "" });
      expect(outcome.grade).toBe("pass");
    });

    it("passes for a LAN-looking address (10.x)", () => {
      const outcome = gradePublicUrlCoherence({ path: "remote", publicUrl: "https://10.0.1.5", tunnelHostname: "" });
      expect(outcome.grade).toBe("pass");
    });

    it("passes for a .local hostname", () => {
      const outcome = gradePublicUrlCoherence({ path: "remote", publicUrl: "https://loombre.local", tunnelHostname: "" });
      expect(outcome.grade).toBe("pass");
    });

    it("warns for a public-looking address", () => {
      const outcome = gradePublicUrlCoherence({ path: "remote", publicUrl: "https://media.example.com", tunnelHostname: "" });
      expect(outcome.grade).toBe("warn");
    });
  });

  describe("none", () => {
    it("is info — defensive only; deriveCardState never actually surfaces any check when the path is 'none'", () => {
      const outcome = gradePublicUrlCoherence({ path: "none", publicUrl: "", tunnelHostname: "" });
      expect(outcome.grade).toBe("info");
    });
  });

  // FALSE-GREEN HUNT: the "looks private" heuristic is a coarse hostname
  // pattern match, not DNS resolution or CIDR-correct parsing. A malformed
  // URL, or a public-looking domain that actually resolves to a private
  // address via split-horizon DNS, is NOT something this function can see
  // — both fail toward the safer `warn` outcome for the 'remote' path
  // rather than silently defaulting to `pass`.
  it("BLIND SPOT — a malformed publicUrl on the remote path degrades to warn, never assumed private/pass", () => {
    const outcome = gradePublicUrlCoherence({ path: "remote", publicUrl: "not a url at all", tunnelHostname: "" });
    expect(outcome.grade).toBe("warn");
  });
});
