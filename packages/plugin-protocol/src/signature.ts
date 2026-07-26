// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/signature.ts
//
// Capability 3.2 (event-subscriber) delivery signing. Scheme:
//
//   X-LPP-Signature: t=<unix-ms>,v1=<hex hmac-sha256 of "<t>.<raw body>">
//
// modeled on the well-established Stripe/GitHub webhook-signature shape
// deliberately, not invented from scratch: a timestamp component defeats
// pure replay of a captured request, and signing "<timestamp>.<raw body>"
// (not the body alone) binds the timestamp itself into the signature so an
// attacker cannot detach a valid signature from an old timestamp and staple
// on a fresh one.
//
// Secret provenance (design decision, not fully pinned by the mission
// rails — see this lane's report): "secret minted per-plugin at
// registration" is host-side (W2). This package treats delivery signing as
// a SEPARATE trust concern from the plugin's own configSchema secrets
// (C3's per-request X-LPP-Secret-<NAME> config injection): the signing
// secret authenticates the SENDER of an inbound POST /lpp/events, the same
// role a webhook-receiver secret plays for Stripe/GitHub webhook consumers,
// and those ecosystems' universal convention is that the receiver persists
// its own copy out-of-band (shown once at registration, stored in the
// plugin's own config/env) rather than having it re-delivered on every
// call — re-delivering the very secret used to compute a request's
// signature, in that same request, would not usefully authenticate
// anything a working TLS channel doesn't already guarantee. This module
// only fixes the WIRE FORMAT (header shape, HMAC construction, replay
// window); how a plugin obtains its secret is out of LPP v1's scope.
//
// Verification pseudocode (also reproduced in spec/lpp-v1.md, generated
// from this file's constants — keep both in sync by re-running
// `pnpm --filter @loombre/plugin-protocol run generate`):
//
//   function verify(headerValue, secret, rawBody, nowMs, replayWindowMs):
//     if headerValue is absent: reject("missing-header")
//     (t, v1) = parse "t=<ms>,v1=<hex>" from headerValue
//     if parse fails: reject("malformed-header")
//     expected = hex(hmacSha256(secret, `${t}.${rawBody}`))
//     if not constantTimeEqual(expected, v1): reject("signature-mismatch")
//     if abs(nowMs - t) > replayWindowMs: reject("stale-timestamp" | "future-timestamp")
//     accept()

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LPP_SIGNATURE_HEADER = "X-LPP-Signature";

export const LPP_SIGNATURE_SCHEME_VERSION = "v1";

export const LPP_SIGNATURE_ALGORITHM = "sha256";

/** SHOULD-level default (mission: replay-window enforcement is a SHOULD for
 *  plugins, exercised by the conformance suite as pass/warn, not pass/fail). */
export const LPP_DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;

/** Builds the full `X-LPP-Signature` header value. */
export function signLppBatch(secret: string, timestampMs: number, rawBody: string): string {
  const hex = createHmac(LPP_SIGNATURE_ALGORITHM, secret)
    .update(`${timestampMs}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestampMs},${LPP_SIGNATURE_SCHEME_VERSION}=${hex}`;
}

export interface LppSignatureParts {
  timestampMs: number;
  signatureHex: string;
}

/** Parses `t=<ms>,v1=<hex>` (order-independent, extra unknown `key=value`
 *  members are ignored — additive-friendly). Returns null on any structural
 *  malformation rather than throwing, so callers can distinguish
 *  "malformed-header" from every other rejection reason. */
export function parseLppSignatureHeader(headerValue: string): LppSignatureParts | null {
  const parts = new Map<string, string>();
  for (const segment of headerValue.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const tRaw = parts.get("t");
  const v1 = parts.get(LPP_SIGNATURE_SCHEME_VERSION);
  if (tRaw === undefined || v1 === undefined || v1.length === 0 || !/^[0-9a-fA-F]+$/.test(v1)) {
    return null;
  }
  const timestampMs = Number(tRaw);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) return null;
  return { timestampMs, signatureHex: v1.toLowerCase() };
}

export type LppSignatureRejectionReason =
  | "missing-header"
  | "malformed-header"
  | "signature-mismatch"
  | "stale-timestamp"
  | "future-timestamp";

export type LppSignatureVerification = { valid: true } | { valid: false; reason: LppSignatureRejectionReason };

/**
 * Full verification: parse -> recompute -> constant-time compare -> replay
 * window. Plugins (the reference notifier included) run this on every
 * `POST /lpp/events` before trusting the batch (spec MUST); the replay
 * window check specifically is documented as a SHOULD for third-party
 * plugins, but this function always enforces it — a caller that only wants
 * signature-mismatch semantics can pass `replayWindowMs: Infinity`.
 */
export function verifyLppSignature(params: {
  headerValue: string | undefined | null;
  secret: string;
  rawBody: string;
  nowMs: number;
  replayWindowMs?: number;
}): LppSignatureVerification {
  const replayWindowMs = params.replayWindowMs ?? LPP_DEFAULT_REPLAY_WINDOW_MS;
  if (!params.headerValue) return { valid: false, reason: "missing-header" };
  const parsed = parseLppSignatureHeader(params.headerValue);
  if (!parsed) return { valid: false, reason: "malformed-header" };

  const expectedHex = createHmac(LPP_SIGNATURE_ALGORITHM, params.secret)
    .update(`${parsed.timestampMs}.${params.rawBody}`, "utf8")
    .digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(parsed.signatureHex, "hex");
  const signaturesMatch = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!signaturesMatch) return { valid: false, reason: "signature-mismatch" };

  const deltaMs = params.nowMs - parsed.timestampMs;
  if (Math.abs(deltaMs) > replayWindowMs) {
    return { valid: false, reason: deltaMs > replayWindowMs ? "stale-timestamp" : "future-timestamp" };
  }
  return { valid: true };
}

/** Generates a fresh per-plugin delivery-signing secret (host-side use at
 *  registration; also used by tests/examples to mint deterministic-enough
 *  test secrets). 256 bits of `node:crypto` randomness, hex-encoded. */
export function generateLppSigningSecret(): string {
  return randomBytes(32).toString("hex");
}
