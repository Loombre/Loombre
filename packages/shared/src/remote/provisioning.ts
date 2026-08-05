// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/provisioning.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R2/R3, Wave 0 freeze).
//
// THE PROVISIONING CONTRACT — Loombre Remote's wg-quick config generator.
// Pure, framework-free (CLAUDE.md invariant 2's playback-engine discipline
// extended to this module: no I/O, no framework imports — every fact the
// config needs is passed in as typed input, nothing read from disk/network/
// env here). Produces STANDARD wg-quick config text.
//
// DESIGN NOTE for the native-app epic (R3, recorded here verbatim per the
// task brief): this format is deliberately APP-AGNOSTIC — plain WireGuard
// config semantics, nothing Loombre-proprietary in the wire format itself.
// Today's official WireGuard mobile/desktop apps import this text directly
// (QR scan or .conf download); a future native Loombre client is expected
// to parse/import this SAME format through the SAME server-side enrollment
// machinery (POST /admin/remote/wireguard/devices), not a bespoke shape
// invented for it later. Any future native client convenience (e.g. an
// embedded deep-link) must be ADDITIVE alongside this text, never a
// replacement for it — that is the whole point of freezing the contract
// here.
//
// SPLIT TUNNEL ONLY (R3): AllowedIPs is scoped to exactly the Loombre
// server's own tunnel address (a /32) — never the subnet, never 0.0.0.0/0.
// Full-device tunneling is explicitly NOT offered by this module (R3: "a
// bandwidth + privacy anti-feature"); there is no parameter that could
// produce a wider AllowedIPs than that single host route.
//
// VERSIONED (R3): PROVISIONING_FORMAT_VERSION bumps only on a wire-shape
// change an existing strict wg-quick parser could not tolerate (e.g. a new
// REQUIRED stanza/key, or a changed key name). A WireGuard config is
// line-oriented, not JSON — there is no schema to "additively extend" the
// way the REST contract is; this constant exists so a consumer (the
// enrollment API response, docs, a future native client) can assert which
// shape it is speaking without re-parsing the text.

export const PROVISIONING_FORMAT_VERSION = 1;

export interface ProvisioningInput {
  /** The Loombre server's WireGuard public key (R2: generated at enable, private half stays in the KEYRING). */
  serverPublicKey: string;
  /** The publicly reachable host the device connects to (remote.wireguardEndpointHost). */
  serverEndpointHost: string;
  /** The UDP port the server's listener is bound to (remote.wireguardPort). */
  serverEndpointPort: number;
  /** This device's freshly generated peer private key (R2: generated server-side at enrollment, delivered ONCE, never retained after this config is rendered). */
  devicePrivateKey: string;
  /** This device's stable tunnel IP, allocated from the tunnel subnet (RG9). */
  deviceTunnelIp: string;
  /** The server's own tunnel IP (RG9: the subnet's .1) — the device's ONLY route through the tunnel (R3 split-tunnel). */
  serverTunnelIp: string;
  /** The tunnel subnet in CIDR form (e.g. "10.82.146.0/24", RG9 default) — only its prefix length is used, for the device's own [Interface] Address line; it never widens AllowedIPs. */
  subnetCidr: string;
}

/** WireGuard's own recommended keepalive for a peer that may sit behind
 *  NAT/carrier-grade NAT or a mobile-network idle timeout (exactly this
 *  subsystem's expected client population, R1) — keeps the NAT mapping
 *  alive so the server can still reach the device between handshakes.
 *  Fixed, not a parameter: every enrolled device gets the same value. */
const PERSISTENT_KEEPALIVE_SECONDS = 25;

function extractPrefixLength(subnetCidr: string): string {
  const slashIndex = subnetCidr.indexOf("/");
  if (slashIndex === -1 || slashIndex === subnetCidr.length - 1) {
    throw new Error(`buildProvisioningConfig: subnetCidr must be in CIDR form ("a.b.c.d/n"), got ${JSON.stringify(subnetCidr)}`);
  }
  return subnetCidr.slice(slashIndex + 1);
}

/**
 * Renders THE ONE-TIME provisioning payload's config text (R2/R3). Total
 * for any well-formed input; throws only on a structurally malformed
 * subnetCidr (a caller bug, not a runtime condition to recover from).
 *
 * Standard wg-quick stanza order — [Interface] (this device's own
 * identity), blank line, [Peer] (the Loombre server, the device's only
 * peer) — exactly what every WireGuard app's own config parser expects,
 * by construction (R3's app-agnostic design note above).
 */
export function buildProvisioningConfig(input: ProvisioningInput): string {
  const prefixLength = extractPrefixLength(input.subnetCidr);

  const lines = [
    "[Interface]",
    `PrivateKey = ${input.devicePrivateKey}`,
    `Address = ${input.deviceTunnelIp}/${prefixLength}`,
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.serverEndpointHost}:${input.serverEndpointPort}`,
    `AllowedIPs = ${input.serverTunnelIp}/32`,
    `PersistentKeepalive = ${PERSISTENT_KEEPALIVE_SECONDS}`,
  ];

  return `${lines.join("\n")}\n`;
}
