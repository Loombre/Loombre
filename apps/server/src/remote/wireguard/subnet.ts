// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/wireguard/subnet.ts
//
// RG9: "default subnet 10.82.146.0/24 ... Server = .1, devices allocated
// lowest-free from .2-.254." Pure — no I/O, no settings coupling — so this
// is trivially unit-testable against every configured prefix length the
// registry allows (REMOTE_SUBNET_SCHEMA bounds /8-/30).

const OCTET_MAX = 255;

function parseIPv4(address: string): number {
  const octets = address.split(".");
  if (octets.length !== 4) throw new Error(`invalid IPv4 address: "${address}"`);
  let value = 0;
  for (const part of octets) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > OCTET_MAX || part.trim() !== part || part === "") {
      throw new Error(`invalid IPv4 address: "${address}"`);
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function formatIPv4(value: number): string {
  return [(value >>> 24) & OCTET_MAX, (value >>> 16) & OCTET_MAX, (value >>> 8) & OCTET_MAX, value & OCTET_MAX].join(".");
}

/** The server's own tunnel address: the configured subnet's network
 *  address + 1 (RG9's "Server = .1"), regardless of prefix length. */
export function deriveServerTunnelIp(cidr: string): string {
  const [base, prefixRaw] = cidr.split("/");
  if (!base || prefixRaw === undefined) {
    throw new Error(`invalid CIDR: "${cidr}"`);
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR prefix: "${cidr}"`);
  }
  const baseInt = parseIPv4(base);
  const hostBits = 32 - prefix;
  if (hostBits < 1) {
    throw new Error(`subnet "${cidr}" has no usable host addresses (prefix /${prefix} leaves no room for a server + peers)`);
  }
  const networkInt = hostBits === 32 ? 0 : (baseInt >>> hostBits) << hostBits;
  return formatIPv4((networkInt + 1) >>> 0);
}
