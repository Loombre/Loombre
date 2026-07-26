// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-network.spec.ts
//
// Pure unit tests for isPrivateOrLoopbackAddress/resolveMaxBitrateBps
// (docs/PLAYBACK.md §2.3, Phase 3 §11 step 6b).

import { describe, expect, it } from "vitest";
import { isPrivateOrLoopbackAddress, parseEnvMaxStreamBitrateBps, resolveMaxBitrateBps } from "./resolve-network.js";

describe("isPrivateOrLoopbackAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.5.5.5", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:192.168.1.5", true],
    ["fd00::1", true],
    ["fc00::1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false], // just outside 172.16.0.0/12
    ["172.15.255.255", false],
    ["203.0.113.5", false],
    ["2001:4860:4860::8888", false], // real public IPv6 (Google DNS)
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });
});

describe("parseEnvMaxStreamBitrateBps", () => {
  it("undefined/empty -> undefined", () => {
    expect(parseEnvMaxStreamBitrateBps(undefined)).toBeUndefined();
    expect(parseEnvMaxStreamBitrateBps("")).toBeUndefined();
    expect(parseEnvMaxStreamBitrateBps("   ")).toBeUndefined();
  });

  it("non-positive/non-numeric -> undefined", () => {
    expect(parseEnvMaxStreamBitrateBps("0")).toBeUndefined();
    expect(parseEnvMaxStreamBitrateBps("-5")).toBeUndefined();
    expect(parseEnvMaxStreamBitrateBps("not-a-number")).toBeUndefined();
  });

  it("a positive integer parses through", () => {
    expect(parseEnvMaxStreamBitrateBps("50000000")).toBe(50_000_000);
  });
});

describe("resolveMaxBitrateBps", () => {
  it("takes the minimum of every supplied term, including the client-declared value", () => {
    expect(resolveMaxBitrateBps(200_000_000, 50_000_000, undefined)).toBe(50_000_000);
  });

  it("env override applies when it is the smallest term", () => {
    expect(resolveMaxBitrateBps(200_000_000, null, 10_000_000)).toBe(10_000_000);
  });

  it("falls back to the 100 Mbps documented default when nothing else constrains it", () => {
    expect(resolveMaxBitrateBps(200_000_000, null, undefined)).toBe(100_000_000);
  });

  it("a low client-declared value is honored even with no device/env cap", () => {
    expect(resolveMaxBitrateBps(2_000_000, null, undefined)).toBe(2_000_000);
  });

  it("device cap of exactly 0 still wins (edge case, never silently ignored)", () => {
    expect(resolveMaxBitrateBps(200_000_000, 0, undefined)).toBe(0);
  });
});
