// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/brand/boot-log.test.ts
//
// STATE.md "Blaze logo rollout" D6/G5 — feedback-loop-first: written before
// BootSplash.tsx consumed this module. Locks the derivation rules (never
// the reference's fixture literals) as a pure-function contract, same
// pattern as lib/server-url.test.ts for describeServerUrl().

import { describe, expect, it } from "vitest";
import { getBootLogLines } from "./boot-log.js";
import { APP_VERSION } from "../../lib/app-version.js";

describe("getBootLogLines", () => {
  it("derives the client line from the real APP_VERSION, prefixed V", () => {
    const lines = getBootLogLines({ serverUrl: "", hasStoredSession: false });
    expect(lines[0]).toEqual({ label: "LOOMBRE CLIENT", value: `V${APP_VERSION}` });
  });

  it("derives the server line's host + TLS from a real URL (server-url.ts precedent)", () => {
    const lines = getBootLogLines({ serverUrl: "https://loombre.local:3001", hasStoredSession: false });
    expect(lines[1]).toEqual({ label: "SERVER", value: "loombre.local:3001 · TLS" });
  });

  it("omits the TLS suffix for a plain http URL", () => {
    const lines = getBootLogLines({ serverUrl: "http://192.168.1.40:3001", hasStoredSession: false });
    expect(lines[1]).toEqual({ label: "SERVER", value: "192.168.1.40:3001" });
  });

  it("reports NOT SET instead of fabricating a host when no server URL is resolvable", () => {
    const lines = getBootLogLines({ serverUrl: "", hasStoredSession: false });
    expect(lines[1]).toEqual({ label: "SERVER", value: "NOT SET" });
  });

  it("derives the session line from AuthStore.isAuthenticated(), never a fabricated readiness probe", () => {
    const restored = getBootLogLines({ serverUrl: "", hasStoredSession: true });
    const fresh = getBootLogLines({ serverUrl: "", hasStoredSession: false });
    expect(restored[2]).toEqual({ label: "SESSION", value: "RESTORED" });
    expect(fresh[2]).toEqual({ label: "SESSION", value: "NEW" });
  });

  // The banned-fixture negative assertions for these lines live in
  // BootSplash.fixtures.test.tsx — the ONE brand:fixture-strings allowlist
  // entry (G14); duplicating them here would trip the gate on this file.
});
