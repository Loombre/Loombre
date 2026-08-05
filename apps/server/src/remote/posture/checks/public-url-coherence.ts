// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/public-url-coherence.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 publicUrlCoherence, S1 lane).
// Pure grading function over network.publicUrl (packages/shared/src/
// settings-registry.ts) vs remote.tunnelHostname and the active path — the
// impure "read the current effective settings values" half lives in
// ../remote-posture.service.ts.
//
// Per-path rule (mission brief, verbatim):
//   tunnel  -> must equal https://<tunnelHostname>
//   direct  -> must be set + https
//   remote  -> publicUrl unset or LAN-looking is fine = pass
//   none    -> info (defensive only — deriveCardState's own early return
//              means the card never actually surfaces ANY check when
//              activePath is 'none', so this branch is unreachable through
//              the real composed endpoint; kept and tested anyway so this
//              function degrades safely rather than assuming pass if that
//              composition rule is ever refactored).
//
// FALSE-GREEN HUNT: the "looks like a LAN address" heuristic below is
// exactly that — a heuristic, not an authoritative network check. It
// cannot resolve DNS, cannot see NAT/split-horizon setups, and treats any
// hostname it doesn't recognize as "looks public" by default (the safer
// direction: an unrecognized value degrades to `warn`, never silently to
// `pass`). A malformed/unparseable URL is treated the same way — never
// assumed private.

import type { PostureActivePath } from "@loombre/shared";
import type { PostureCheckOutcome } from "./types.js";

export interface PublicUrlCoherenceInput {
  path: PostureActivePath;
  /** '' = unset (network.publicUrl's own default). */
  publicUrl: string;
  /** '' = unset (remote.tunnelHostname's own default). */
  tunnelHostname: string;
}

const PRIVATE_HOST_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa"];
const PRIVATE_HOST_LITERALS = new Set(["localhost", "127.0.0.1", "::1"]);

function looksLikePrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (PRIVATE_HOST_LITERALS.has(lower)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  // RFC 1918 (IPv4 private ranges) — a coarse prefix match, not a full CIDR
  // parse; good enough for a heuristic that already fails toward `warn`.
  if (lower.startsWith("10.")) return true;
  if (lower.startsWith("192.168.")) return true;
  const octet2 = lower.match(/^172\.(\d{1,3})\./);
  if (octet2) {
    const n = Number(octet2[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function gradePublicUrlCoherence(input: PublicUrlCoherenceInput): PostureCheckOutcome {
  switch (input.path) {
    case "none":
      return { grade: "info", detail: "No remote-access path is enabled." };

    case "tunnel": {
      if (input.tunnelHostname === "") {
        return { grade: "fail", detail: "The Tunnel path is enabled but no tunnel hostname is configured." };
      }
      const expected = `https://${input.tunnelHostname}`;
      if (input.publicUrl !== expected) {
        return {
          grade: "fail",
          detail: `network.publicUrl (${input.publicUrl || "unset"}) does not match the active tunnel hostname — expected ${expected}.`,
        };
      }
      return { grade: "pass", detail: `network.publicUrl matches the active tunnel hostname (${expected}).` };
    }

    case "direct": {
      if (input.publicUrl === "") {
        return {
          grade: "fail",
          detail: "No public URL is set for the Direct path — links in outgoing mail (invites, password resets) cannot be built.",
        };
      }
      if (!input.publicUrl.startsWith("https://")) {
        return {
          grade: "fail",
          detail: `network.publicUrl (${input.publicUrl}) is not https — the Direct path should always be reachable over TLS.`,
        };
      }
      return { grade: "pass", detail: `network.publicUrl (${input.publicUrl}) is set and uses https, matching the Direct path.` };
    }

    case "remote": {
      if (input.publicUrl === "") {
        return {
          grade: "pass",
          detail: "network.publicUrl is unset, which is fine for the Remote (WireGuard-only) path — it never needs a public address.",
        };
      }
      const hostname = hostnameOf(input.publicUrl);
      if (hostname !== undefined && looksLikePrivateHost(hostname)) {
        return {
          grade: "pass",
          detail: `network.publicUrl (${input.publicUrl}) looks like a private/LAN address, which is fine for the Remote path.`,
        };
      }
      return {
        grade: "warn",
        detail: `network.publicUrl (${input.publicUrl}) looks like a public address, but only WireGuard-enrolled devices can reach this server on the Remote path — anyone else following that link would get a broken connection.`,
      };
    }
  }
}
