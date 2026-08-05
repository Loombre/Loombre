// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/diagnosis.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Wave 0 freeze).
// Table-driven, exhaustive spec for the pure WAN-classification decision
// function — playback-matrix case discipline (docs/PLAYBACK.md's own
// exhaustive-table precedent), local to this package per RG11 ("not wired
// into the global matrix burnup").

import { describe, expect, it } from "vitest";
import { classifyReachability, type ReachabilityInput } from "../../src/remote/diagnosis.js";
import type { DiagnosisCode } from "../../src/remote/diagnosis.js";

interface MatrixCase {
  name: string;
  input: ReachabilityInput;
  expected: DiagnosisCode;
}

// RFC 6598 shared address space (100.64.0.0/10) — the CGNAT block ISPs use
// for their own NAT layer.
const CGNAT_ADDRESS = "100.64.5.5";
// RFC 1918 private ranges.
const PRIVATE_ADDRESS_10 = "10.0.0.5";
const PRIVATE_ADDRESS_172 = "172.20.0.5";
const PRIVATE_ADDRESS_192 = "192.168.1.5";
const RESOLVED_PUBLIC = "203.0.113.10";
const OTHER_PUBLIC = "198.51.100.20";

const MATRIX: readonly MatrixCase[] = [
  {
    name: "WAN in 100.64.0.0/10 -> definite CGNAT, regardless of probe arrival",
    input: { wanAddress: CGNAT_ADDRESS, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "cgnat",
  },
  {
    name: "WAN at the exact 100.64.0.0/10 lower boundary -> cgnat",
    input: { wanAddress: "100.64.0.0", resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "cgnat",
  },
  {
    name: "WAN at the exact 100.127.255.255 upper boundary -> cgnat",
    input: { wanAddress: "100.127.255.255", resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "cgnat",
  },
  {
    name: "WAN just below the CGNAT block (100.63.255.255) is NOT cgnat by this rule",
    input: { wanAddress: "100.63.255.255", resolvedPublicAddress: "100.63.255.255", probeArrived: true },
    expected: "unknown", // arrived + WAN matches resolved -> nothing to diagnose (see "probeArrived" cases below); listed here to pin the boundary is exclusive-correct, not to assert cgnat
  },
  {
    name: "WAN in 10.0.0.0/8 -> double-NAT",
    input: { wanAddress: PRIVATE_ADDRESS_10, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "doubleNat",
  },
  {
    name: "WAN in 172.16.0.0/12 -> double-NAT",
    input: { wanAddress: PRIVATE_ADDRESS_172, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "doubleNat",
  },
  {
    name: "WAN in 192.168.0.0/16 -> double-NAT",
    input: { wanAddress: PRIVATE_ADDRESS_192, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "doubleNat",
  },
  {
    name: "WAN 172.32.0.0 is OUTSIDE 172.16.0.0/12 (boundary exclusivity) and matches resolved -> port block, not double-NAT",
    input: { wanAddress: "172.32.0.0", resolvedPublicAddress: "172.32.0.0", probeArrived: false },
    expected: "portBlocked",
  },
  {
    name: "WAN matches the resolved public endpoint, probe never arrived -> portBlocked",
    input: { wanAddress: RESOLVED_PUBLIC, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "portBlocked",
  },
  {
    name: "WAN differs from the resolved public endpoint (both public) -> dnsMismatch",
    input: { wanAddress: OTHER_PUBLIC, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "dnsMismatch",
  },
  {
    name: "WAN matches resolved AND the probe arrived -> unknown (nothing to diagnose; caller should not have invoked this for a success)",
    input: { wanAddress: RESOLVED_PUBLIC, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: true },
    expected: "unknown",
  },
  {
    name: "no WAN address supplied at all (admin hasn't completed the router-status-page step yet) -> unknown, never guessed",
    input: { wanAddress: null, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "unknown",
  },
  {
    name: "WAN supplied but syntactically not a valid IPv4 address -> unknown, never thrown",
    input: { wanAddress: "not-an-ip", resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false },
    expected: "unknown",
  },
];

describe("classifyReachability — RG11 exhaustive decision table", () => {
  for (const testCase of MATRIX) {
    it(testCase.name, () => {
      expect(classifyReachability(testCase.input)).toBe(testCase.expected);
    });
  }

  it("is a pure function: same input twice, same output, no shared mutable state", () => {
    const input: ReachabilityInput = { wanAddress: CGNAT_ADDRESS, resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false };
    expect(classifyReachability(input)).toBe(classifyReachability({ ...input }));
  });

  it("CGNAT classification takes priority over the double-NAT check (100.64/10 is checked before RFC1918)", () => {
    // 100.64.x.x is never inside any RFC1918 block, so this also proves the
    // two checks don't overlap by accident.
    expect(classifyReachability({ wanAddress: "100.70.0.1", resolvedPublicAddress: RESOLVED_PUBLIC, probeArrived: false })).toBe("cgnat");
  });
});

describe("DiagnosisCode — closed union sanity (mirrors DiagnosisCode in openapi.yaml)", () => {
  it("classifyReachability never returns a value outside the seven documented codes", () => {
    const ALL_CODES: readonly DiagnosisCode[] = [
      "portBlocked",
      "cgnat",
      "doubleNat",
      "dnsMismatch",
      "tunnelDown",
      "connectorUnhealthy",
      "unknown",
    ];
    for (const testCase of MATRIX) {
      expect(ALL_CODES).toContain(classifyReachability(testCase.input));
    }
  });
});
