// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-update-notice.test.ts

import { describe, expect, it } from "vitest";
import { describeUpdateVerification } from "./admin-update-notice.js";

describe("describeUpdateVerification", () => {
  it("verified -> tone success", () => {
    expect(describeUpdateVerification("verified").tone).toBe("success");
  });

  it("'signature-invalid' is rendered as a WARNING state, not an error/danger (task brief requirement)", () => {
    const info = describeUpdateVerification("signature-invalid");
    expect(info.tone).toBe("warning");
    expect(info.tone).not.toBe("danger");
    expect(info.label.toLowerCase()).toContain("invalid");
    expect(info.detail).toMatch(/untrusted/i);
  });

  it("unreachable -> neutral, not alarming", () => {
    expect(describeUpdateVerification("unreachable").tone).toBe("neutral");
  });

  it("disabled -> neutral", () => {
    expect(describeUpdateVerification("disabled").tone).toBe("neutral");
  });

  it("every documented SystemUpdateVerification enum member has dedicated (non-fallback) copy", () => {
    for (const v of ["verified", "signature-invalid", "unreachable", "disabled"]) {
      const info = describeUpdateVerification(v);
      expect(info.detail, v).not.toMatch(/unrecognized verification state/i);
    }
  });

  it("falls back honestly for an unrecognized value", () => {
    const info = describeUpdateVerification("some-future-state");
    expect(info.detail).toMatch(/unrecognized verification state/i);
  });
});
