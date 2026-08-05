// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/subnet-allocation.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R2/RG9, lane WG2). Pure, table-driven
// coverage for deviceIpRange/lowestFreeDeviceIp — see subnet-allocation.ts's
// own header for the range definition (network+2..broadcast-1).

import { describe, expect, it } from "vitest";
import { deviceIpRange, lowestFreeDeviceIp } from "../../src/remote/subnet-allocation.js";

describe("deviceIpRange", () => {
  it("RG9 default /24: .2 through .254 (network .0 and server .1 excluded, broadcast .255 excluded)", () => {
    const { minInt, maxInt } = deviceIpRange("10.82.146.0/24");
    expect(minInt).toBe((10 << 24) + (82 << 16) + (146 << 8) + 2);
    expect(maxInt).toBe((10 << 24) + (82 << 16) + (146 << 8) + 254);
  });

  it("/30 (the smallest legal REMOTE_SUBNET_SCHEMA prefix): exactly ONE usable device address", () => {
    const { minInt, maxInt } = deviceIpRange("10.82.146.0/30");
    expect(minInt).toBe(maxInt);
    expect(minInt).toBe((10 << 24) + (82 << 16) + (146 << 8) + 2);
  });

  it("/28: .2 through .14 (network .0, server .1, broadcast .15 excluded)", () => {
    const { minInt, maxInt } = deviceIpRange("10.82.146.0/28");
    expect(minInt).toBe((10 << 24) + (82 << 16) + (146 << 8) + 2);
    expect(maxInt).toBe((10 << 24) + (82 << 16) + (146 << 8) + 14);
  });

  it("throws on a CIDR with no prefix length", () => {
    expect(() => deviceIpRange("10.82.146.0")).toThrow(/invalid CIDR/);
  });

  it("throws on a prefix with no room for even one device (/31, /32)", () => {
    expect(() => deviceIpRange("10.82.146.0/31")).toThrow(/no usable device addresses/);
    expect(() => deviceIpRange("10.82.146.0/32")).toThrow(/no usable device addresses/);
  });

  it("throws on a malformed base address", () => {
    expect(() => deviceIpRange("10.82.146.999/24")).toThrow(/invalid IPv4 address/);
  });
});

describe("lowestFreeDeviceIp", () => {
  it("returns .2 (the first device address) when nothing is used yet", () => {
    expect(lowestFreeDeviceIp("10.82.146.0/24", [])).toBe("10.82.146.2");
  });

  it("skips over used addresses, even out of order, to find the lowest gap", () => {
    expect(lowestFreeDeviceIp("10.82.146.0/24", ["10.82.146.4", "10.82.146.2", "10.82.146.3"])).toBe("10.82.146.5");
  });

  it("finds a gap in the MIDDLE of the used set, not just past the highest used address", () => {
    expect(lowestFreeDeviceIp("10.82.146.0/24", ["10.82.146.2", "10.82.146.4"])).toBe("10.82.146.3");
  });

  it("ignores addresses outside the device range (e.g. a stray .1/.0/.255) — never returns them either", () => {
    // .1/.0/.255 are never legal candidates in the first place (outside the
    // computed range), so "using" them changes nothing about the result.
    expect(lowestFreeDeviceIp("10.82.146.0/24", ["10.82.146.0", "10.82.146.1", "10.82.146.255"])).toBe("10.82.146.2");
  });

  it("returns null when the range is fully exhausted (/30's single device address already used)", () => {
    expect(lowestFreeDeviceIp("10.82.146.0/30", ["10.82.146.2"])).toBeNull();
  });

  it("returns null when a whole small subnet is saturated", () => {
    const used = ["10.82.146.2", "10.82.146.3", "10.82.146.4", "10.82.146.5", "10.82.146.6", "10.82.146.7", "10.82.146.8", "10.82.146.9", "10.82.146.10", "10.82.146.11", "10.82.146.12", "10.82.146.13", "10.82.146.14"];
    expect(lowestFreeDeviceIp("10.82.146.0/28", used)).toBeNull();
  });

  it("is deterministic: same inputs, same output", () => {
    const usedIps = ["10.82.146.2", "10.82.146.3"];
    expect(lowestFreeDeviceIp("10.82.146.0/24", usedIps)).toBe(lowestFreeDeviceIp("10.82.146.0/24", [...usedIps]));
  });
});
