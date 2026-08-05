// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/tls-validity.spec.ts
import { describe, expect, it } from "vitest";
import { gradeTlsValidity } from "./tls-validity.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("gradeTlsValidity (R7 tlsValidity)", () => {
  it("fails a certificate that has already expired", () => {
    const outcome = gradeTlsValidity({ mode: "acme", cert: { notAfterMs: NOW - DAY_MS }, nowMs: NOW });
    expect(outcome.grade).toBe("fail");
    expect(outcome.detail).toMatch(/expired/i);
  });

  it("passes a certificate well outside the warn window", () => {
    const outcome = gradeTlsValidity({ mode: "acme", cert: { notAfterMs: NOW + 60 * DAY_MS }, nowMs: NOW });
    expect(outcome.grade).toBe("pass");
    expect(outcome.detail).toMatch(/valid/i);
  });

  it("warns inside the default 14-day window, with days-left in the detail (R7's own wording)", () => {
    const outcome = gradeTlsValidity({ mode: "manual", cert: { notAfterMs: NOW + 5 * DAY_MS }, nowMs: NOW });
    expect(outcome.grade).toBe("warn");
    expect(outcome.detail).toContain("5 day");
  });

  it("respects a caller-supplied warnWindowDays", () => {
    const outcome = gradeTlsValidity({ mode: "manual", cert: { notAfterMs: NOW + 20 * DAY_MS }, nowMs: NOW, warnWindowDays: 30 });
    expect(outcome.grade).toBe("warn");
  });

  it("fails when the mode expects a certificate but none could be read (a real problem, not a blind spot)", () => {
    const outcome = gradeTlsValidity({ mode: "acme", cert: undefined, nowMs: NOW });
    expect(outcome.grade).toBe("fail");
  });

  // FALSE-GREEN HUNT: mode "off" means TLS terminates somewhere Loombre
  // never sees (e.g. a reverse proxy) — this check has NO certificate to
  // read at all in that state, and must degrade honestly to `info` rather
  // than ever claiming `pass` for a certificate it cannot observe.
  it("BLIND SPOT — mode 'off' (reverse-proxy TLS) degrades to info, never pass", () => {
    const outcome = gradeTlsValidity({ mode: "off", cert: undefined, nowMs: NOW });
    expect(outcome.grade).toBe("info");
    expect(outcome.grade).not.toBe("pass");
  });
});
