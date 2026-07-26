// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-network.ts
//
// NetworkConditions assembly (docs/PLAYBACK.md §2.3, Phase 3 §11 step 6b
// deliverable 2).
//
// isLocal (task text, quoted): "request IP is RFC1918/loopback (respect
// LOOMBRE_TRUST_PROXY)". Resolved from Express's `req.ip`, which already
// honors X-Forwarded-For ONLY when LOOMBRE_TRUST_PROXY is explicitly enabled
// (apps/server/src/main.ts's applyTrustProxy — the SAME req.ip the auth
// rate-limiter/anomaly log already trust, STATE.md P2.2). No new
// IP-resolution path is introduced here; the client-declared
// `PlanRequest.network.isLocal` is deliberately NOT consulted (the server
// decides this one itself — a client cannot self-declare "local network"
// to unlock a relaxed bitrate cap).
//
// maxBitrateBps — BIND (reported): this step's literal instruction gives
// `min(device.maxStreamBitrateBps ?? Inf, LOOMBRE_MAX_STREAM_BITRATE env ??
// Inf, 100_000_000 documented default)`. This module EXTENDS that with a
// FOURTH term — the request body's own client-declared
// `network.maxBitrateBps` (PlanRequest.network, contract-REQUIRED and
// already Ajv-shape-validated upstream in plan-request.ts) — because
// docs/PLAYBACK.md §2.3's own authoritative formula is "min(user setting,
// measured estimate, device cap)": silently discarding an already-
// collected, contractually-required client signal in favor of ONLY
// server-side caps would ignore real data the contract still mandates
// sending on every request, and adding it as a FOURTH min() term can only
// make the resulting bound MORE conservative, never violate the
// tier-0/network-safety intent the device/env/default caps exist for.
// Flagged here for owner review, not silently decided.

import type { Request } from "express";
import type { NetworkConditions } from "@loombre/playback-engine";

const DEFAULT_MAX_STREAM_BITRATE_BPS = 100_000_000;

/** Strips an IPv4-mapped IPv6 prefix ("::ffff:1.2.3.4" -> "1.2.3.4") — a
 *  dual-stack Node socket accepting an IPv4 peer reports it this way; every
 *  check below wants the plain IPv4 form when one exists. */
function unwrapIpv4MappedIpv6(ip: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match ? match[1]! : ip;
}

function isIpv4PrivateOrLoopback(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  return false;
}

/** Pure: is `ip` an RFC1918 private address or loopback (IPv4 or IPv6)? */
export function isPrivateOrLoopbackAddress(ip: string): boolean {
  const unwrapped = unwrapIpv4MappedIpv6(ip);
  if (isIpv4PrivateOrLoopback(unwrapped)) return true;
  const lowered = unwrapped.toLowerCase();
  if (lowered === "::1") return true; // IPv6 loopback
  if (lowered.startsWith("fc") || lowered.startsWith("fd")) return true; // fc00::/7 (ULA)
  return false;
}

export function resolveIsLocal(req: Request): boolean {
  const ip = req.ip;
  if (!ip || ip.length === 0) return false;
  return isPrivateOrLoopbackAddress(ip);
}

/** Parses `LOOMBRE_MAX_STREAM_BITRATE` — a positive integer bps, or
 *  `undefined` for unset/non-positive/non-finite (the formula below then
 *  treats it as "no override", i.e. +Infinity). */
export function parseEnvMaxStreamBitrateBps(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Pure formula (module header's BIND) — every term is already-resolved
 *  data, no I/O. */
export function resolveMaxBitrateBps(
  clientDeclaredMaxBitrateBps: number,
  deviceMaxStreamBitrateBps: number | null,
  envMaxStreamBitrateBps: number | undefined,
): number {
  return Math.min(
    clientDeclaredMaxBitrateBps,
    deviceMaxStreamBitrateBps ?? Number.POSITIVE_INFINITY,
    envMaxStreamBitrateBps ?? Number.POSITIVE_INFINITY,
    DEFAULT_MAX_STREAM_BITRATE_BPS,
  );
}

export function assembleNetworkConditions(
  req: Request,
  clientNetwork: { maxBitrateBps: number; isLocal: boolean },
  deviceMaxStreamBitrateBps: number | null,
): NetworkConditions {
  return {
    isLocal: resolveIsLocal(req),
    maxBitrateBps: resolveMaxBitrateBps(
      clientNetwork.maxBitrateBps,
      deviceMaxStreamBitrateBps,
      parseEnvMaxStreamBitrateBps(process.env["LOOMBRE_MAX_STREAM_BITRATE"]),
    ),
  };
}
