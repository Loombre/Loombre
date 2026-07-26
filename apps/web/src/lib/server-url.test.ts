// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/server-url.test.ts

import { describe, expect, it } from "vitest";
import { describeServerUrl } from "./server-url.js";

describe("describeServerUrl", () => {
  it("reports the host and TLS=true for an https URL", () => {
    expect(describeServerUrl("https://loombre.local:3001")).toEqual({
      host: "loombre.local:3001",
      tls: true,
    });
  });

  it("reports TLS=false for a plain http URL", () => {
    expect(describeServerUrl("http://192.168.1.40:3001")).toEqual({
      host: "192.168.1.40:3001",
      tls: false,
    });
  });

  it("returns null for an empty string (nothing entered yet)", () => {
    expect(describeServerUrl("")).toBeNull();
    expect(describeServerUrl("   ")).toBeNull();
  });

  it("returns null for an unparseable value instead of guessing", () => {
    expect(describeServerUrl("not a url")).toBeNull();
  });

  it("never fabricates a port — omits it exactly when the URL didn't have one", () => {
    expect(describeServerUrl("https://loombre.example")).toEqual({
      host: "loombre.example",
      tls: true,
    });
  });
});
