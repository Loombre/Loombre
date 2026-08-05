// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/provisioning.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R3, Wave 0 freeze). Golden-file tests
// for THE PROVISIONING CONTRACT — buildProvisioningConfig must produce
// byte-identical, standard wg-quick config text for a fixed input, so any
// accidental format drift (whitespace, stanza order, a renamed field) is
// caught immediately by a diff against the checked-in fixture rather than
// discovered by a real WireGuard app failing to import it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVISIONING_FORMAT_VERSION,
  buildProvisioningConfig,
  type ProvisioningInput,
} from "../../src/remote/provisioning.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

const BASE_INPUT: ProvisioningInput = {
  serverPublicKey: "sPGqjK1z7z8s5nQeYw8vQ2y9xJk4mC6hT1bV3wR7XkE=",
  serverEndpointHost: "loombre.example.com",
  serverEndpointPort: 51820,
  devicePrivateKey: "dP9mE2rL5xK8sQ1vT4wY7bN0cH3gJ6zA9uF2iM5oR8s=",
  deviceTunnelIp: "10.82.146.2",
  serverTunnelIp: "10.82.146.1",
  subnetCidr: "10.82.146.0/24",
};

describe("PROVISIONING_FORMAT_VERSION", () => {
  it("is 1 (R3, versioned so a future breaking shape change can bump it)", () => {
    expect(PROVISIONING_FORMAT_VERSION).toBe(1);
  });
});

describe("buildProvisioningConfig — golden file", () => {
  it("matches the checked-in fixture exactly for a standard input", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    expect(config).toBe(loadFixture("basic.conf"));
  });

  it("matches the checked-in fixture exactly for a non-default port and a /28 subnet", () => {
    const input: ProvisioningInput = {
      ...BASE_INPUT,
      serverEndpointPort: 4500,
      deviceTunnelIp: "10.82.146.14",
      subnetCidr: "10.82.146.0/28",
    };
    const config = buildProvisioningConfig(input);
    expect(config).toBe(loadFixture("custom-port-subnet.conf"));
  });
});

describe("buildProvisioningConfig — shape invariants", () => {
  it("is split-tunnel ONLY (R3): AllowedIPs is exactly the server tunnel IP as a /32, never the subnet or 0.0.0.0/0", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    expect(config).toContain(`AllowedIPs = ${BASE_INPUT.serverTunnelIp}/32`);
    expect(config).not.toContain("0.0.0.0/0");
    expect(config).not.toMatch(/AllowedIPs = 10\.82\.146\.0\/24/);
  });

  it("Address uses the device tunnel IP with the subnet's own prefix length, not /32", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    expect(config).toContain(`Address = ${BASE_INPUT.deviceTunnelIp}/24`);
  });

  it("carries the device private key in [Interface] and the server public key in [Peer] — never swapped", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    const interfaceStanza = config.slice(config.indexOf("[Interface]"), config.indexOf("[Peer]"));
    const peerStanza = config.slice(config.indexOf("[Peer]"));
    expect(interfaceStanza).toContain(`PrivateKey = ${BASE_INPUT.devicePrivateKey}`);
    expect(peerStanza).toContain(`PublicKey = ${BASE_INPUT.serverPublicKey}`);
    expect(interfaceStanza).not.toContain(BASE_INPUT.serverPublicKey);
    expect(peerStanza).not.toContain(BASE_INPUT.devicePrivateKey);
  });

  it("Endpoint combines host and port with a colon, no scheme", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    expect(config).toContain("Endpoint = loombre.example.com:51820");
  });

  it("is app-agnostic standard wg-quick syntax: exactly two stanzas, [Interface] before [Peer]", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    const interfaceIdx = config.indexOf("[Interface]");
    const peerIdx = config.indexOf("[Peer]");
    expect(interfaceIdx).toBeGreaterThanOrEqual(0);
    expect(peerIdx).toBeGreaterThan(interfaceIdx);
    expect(config.match(/\[Interface\]/g)).toHaveLength(1);
    expect(config.match(/\[Peer\]/g)).toHaveLength(1);
  });

  it("ends with a single trailing newline (a well-formed text file, no missing/double newline)", () => {
    const config = buildProvisioningConfig(BASE_INPUT);
    expect(config.endsWith("\n")).toBe(true);
    expect(config.endsWith("\n\n")).toBe(false);
  });

  it("is deterministic: same input twice produces byte-identical output", () => {
    expect(buildProvisioningConfig(BASE_INPUT)).toBe(buildProvisioningConfig({ ...BASE_INPUT }));
  });

  it("throws a clear error on a subnetCidr with no prefix length (malformed input, not a silent guess)", () => {
    expect(() => buildProvisioningConfig({ ...BASE_INPUT, subnetCidr: "10.82.146.0" })).toThrow(/subnetCidr/);
  });
});
