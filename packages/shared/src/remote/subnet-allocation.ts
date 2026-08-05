// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/subnet-allocation.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R2/RG9, lane WG2). Pure IPv4 math for
// allocating a WireGuard peer's stable tunnel IP from the configured
// remote.subnet (RG9: "Server = .1, devices allocated lowest-free from
// .2-.254" for the /24 default — generalized here to ANY prefix length
// REMOTE_SUBNET_SCHEMA allows, /8-/30, packages/shared/src/
// settings-registry.ts). No I/O — packages/db/src/query/wg-peers.ts's
// allocateWgPeer composes this with a live read of already-allocated
// tunnel_ip values and a unique-constraint-retry loop for the concurrent-
// enroll race (see that file's header for why the retry lives there, not
// here: this module is pure and cannot itself resolve a race).
//
// Device range = every host address in the subnet EXCLUDING the network
// address, the server's own address (apps/server/src/remote/wireguard/
// subnet.ts's deriveServerTunnelIp — always network+1), and the broadcast
// address. For the smallest legal subnet (/30: network, server, ONE
// device, broadcast) this range is exactly one address; this module works
// identically for any prefix in between.

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

export interface DeviceIpRange {
  /** The lowest allocatable device address, as a uint32 (network + 2 —
   *  network + 1 is always the server, deriveServerTunnelIp). */
  minInt: number;
  /** The highest allocatable device address, as a uint32 (broadcast - 1). */
  maxInt: number;
}

/** The device-allocatable range for a configured tunnel subnet — RG9
 *  generalized past the /24 default to any REMOTE_SUBNET_SCHEMA-legal
 *  prefix (/8-/30). Throws on a malformed CIDR or a prefix with no room
 *  for even one device address (a caller/config bug, not a runtime
 *  condition — same posture as apps/server/src/remote/wireguard/
 *  subnet.ts's deriveServerTunnelIp). */
export function deviceIpRange(cidr: string): DeviceIpRange {
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
  if (hostBits < 2) {
    throw new Error(`subnet "${cidr}" has no usable device addresses (prefix /${prefix} leaves room only for the server, if that)`);
  }
  const networkInt = hostBits === 32 ? 0 : (baseInt >>> hostBits) << hostBits;
  const broadcastInt = hostBits === 32 ? 0xffffffff : (networkInt + (2 ** hostBits - 1)) >>> 0;
  return { minInt: (networkInt + 2) >>> 0, maxInt: (broadcastInt - 1) >>> 0 };
}

/** Lowest-free device IP (RG9) given the subnet and every tunnel_ip
 *  ALREADY in use (packages/db/src/query/wg-peers.ts reads these live) —
 *  null when the range is fully allocated (subnet exhausted). Pure and
 *  deterministic: same inputs, same output, every time — it is the
 *  CALLER's job to make repeated calls under concurrent writers race-safe
 *  (a unique-constraint-retry loop, since this function's own read of
 *  `usedIps` can always be stale the instant another enrollment commits
 *  between the read and the write). */
export function lowestFreeDeviceIp(cidr: string, usedIps: readonly string[]): string | null {
  const { minInt, maxInt } = deviceIpRange(cidr);
  const used = new Set(usedIps.map(parseIPv4));
  for (let ip = minInt; ip <= maxInt; ip++) {
    if (!used.has(ip)) return formatIPv4(ip);
  }
  return null;
}
