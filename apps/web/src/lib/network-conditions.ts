// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/network-conditions.ts
//
// Builds the `NetworkConditions` object POST /playback/plan and
// POST /playback/sessions require (docs/PLAYBACK.md §2.3). Phase 2 has no
// real bandwidth measurement (no ABR ladder exists yet — direct-play only,
// P2.4), so `maxBitrateBps` is an honest, generous placeholder rather than
// a measured value; `isLocal` IS derived honestly from the server URL's
// hostname (RFC1918/loopback/.local), since that's a real, checkable fact
// and the compat-preview's bitrate-exceeds-network check reads it.

const RFC1918_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  return RFC1918_PATTERNS.some((re) => re.test(host));
}

/** No bandwidth probe exists yet (Phase 3 territory); this is a generous
 *  cap that never blocks a same-LAN direct-play file, honestly documented
 *  as a placeholder rather than a measurement. */
const ASSUMED_MAX_BITRATE_BPS = 200_000_000;

export function buildNetworkConditions(serverUrl: string): { maxBitrateBps: number; isLocal: boolean } {
  let isLocal: boolean;
  try {
    isLocal = isLocalHostname(new URL(serverUrl).hostname);
  } catch {
    isLocal = false;
  }
  return { maxBitrateBps: ASSUMED_MAX_BITRATE_BPS, isLocal };
}
