// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/hsts.spec.ts
//
// The full on/off matrix (deliverable 3's "HSTS on/off matrix"): every
// combination of {tlsInternal, trustProxyEnabled} plus the header-value
// shape and the "no middleware registered at all" byte-identical-off
// assertion (same fakeApp pattern as src/main.spec.ts's
// applySecurityHeaders test).

import type { INestApplication } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { applyHsts, DEFAULT_HSTS_MAX_AGE_SECONDS, resolveHstsMaxAgeSeconds, shouldEnableHsts } from "./hsts.js";

function fakeApp(): { app: INestApplication; use: ReturnType<typeof vi.fn> } {
  const use = vi.fn();
  const instance = { use };
  const app = { getHttpAdapter: () => ({ getInstance: () => instance }) } as unknown as INestApplication;
  return { app, use };
}

describe("shouldEnableHsts: the four-cell matrix", () => {
  it("tlsInternal=true, trustProxyEnabled=false -> ON (the only ON cell)", () => {
    expect(shouldEnableHsts({ tlsInternal: true, trustProxyEnabled: false })).toBe(true);
  });

  it("tlsInternal=false, trustProxyEnabled=false -> off (no TLS at all)", () => {
    expect(shouldEnableHsts({ tlsInternal: false, trustProxyEnabled: false })).toBe(false);
  });

  it("tlsInternal=true, trustProxyEnabled=true -> off (proxy owns HSTS, even with internal TLS also on)", () => {
    expect(shouldEnableHsts({ tlsInternal: true, trustProxyEnabled: true })).toBe(false);
  });

  it("tlsInternal=false, trustProxyEnabled=true -> off (the P2.2 reverse-proxy path)", () => {
    expect(shouldEnableHsts({ tlsInternal: false, trustProxyEnabled: true })).toBe(false);
  });
});

describe("applyHsts", () => {
  it("registers no middleware at all when disabled (byte-identical to no HSTS support existing)", () => {
    const { app, use } = fakeApp();
    applyHsts(app, { tlsInternal: false, trustProxyEnabled: false });
    applyHsts(app, { tlsInternal: true, trustProxyEnabled: true });
    expect(use).not.toHaveBeenCalled();
  });

  it("registers middleware setting Strict-Transport-Security with includeSubDomains when enabled", () => {
    const { app, use } = fakeApp();
    applyHsts(app, { tlsInternal: true, trustProxyEnabled: false });
    expect(use).toHaveBeenCalledTimes(1);

    const middleware = use.mock.calls[0]![0] as (req: unknown, res: { setHeader: ReturnType<typeof vi.fn> }, next: () => void) => void;
    const res = { setHeader: vi.fn() };
    const next = vi.fn();
    middleware({}, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Strict-Transport-Security",
      `max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("honors a custom maxAgeSeconds", () => {
    const { app, use } = fakeApp();
    applyHsts(app, { tlsInternal: true, trustProxyEnabled: false, maxAgeSeconds: 60 });
    const middleware = use.mock.calls[0]![0] as (req: unknown, res: { setHeader: ReturnType<typeof vi.fn> }, next: () => void) => void;
    const res = { setHeader: vi.fn() };
    middleware({}, res, vi.fn());
    expect(res.setHeader).toHaveBeenCalledWith("Strict-Transport-Security", "max-age=60; includeSubDomains");
  });
});

describe("resolveHstsMaxAgeSeconds", () => {
  it("falls back to the default for unset/empty/non-numeric/non-positive input", () => {
    expect(resolveHstsMaxAgeSeconds(undefined)).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS);
    expect(resolveHstsMaxAgeSeconds("")).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS);
    expect(resolveHstsMaxAgeSeconds("not-a-number")).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS);
    expect(resolveHstsMaxAgeSeconds("-5")).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS);
    expect(resolveHstsMaxAgeSeconds("0")).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS);
  });

  it("parses a valid positive integer", () => {
    expect(resolveHstsMaxAgeSeconds("31536000")).toBe(31_536_000);
  });
});
