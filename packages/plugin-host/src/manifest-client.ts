// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/manifest-client.ts
//
// LD2 "manifest client (fetch -> size cap -> staged parse via
// @loombre/plugin-protocol, unknown-capability-type surfaced as a typed
// rejection whose message states the type is not supported by this
// Loombre — C2)". Every stage is distinguishable in the return type so a
// caller (apps/server's registration/health services) can render the exact
// right error without string-sniffing: a transport failure (SSRF
// rejection, timeout, non-2xx status), a JSON parse failure, or one of
// parseLppManifest's own staged-parse failures (envelope shape, unsupported
// protocolVersion, per-capability unknown-type/invalid-shape, configSchema
// shape) — the last of these is re-exported from plugin-protocol verbatim,
// this module adds nothing on top of it.
//
// Optional breaker (LD8): registration's FIRST-ever manifest fetch has no
// plugin row (and therefore no breaker) yet and simply omits it; every
// SUBSEQUENT fetch (health-check re-checks, LD6's re-fetch-and-diff flow)
// passes the plugin's own PluginCircuitBreaker so a manifest endpoint that
// stops responding counts toward the SAME 5-consecutive-failure signal a
// capability call failure would (LD8: "the breaker gates ALL capability
// calls uniformly") — the manifest endpoint is not a "capability" in the
// LPP sense, but it is exactly as capable of stalling/wedging health
// checking as one, so it is gated the same way. Transport-exception
// failure classification mirrors call-plugin.ts's BREAKER_COUNTED_REASONS
// exactly (only `timeout`/`network-error` count). M-8 fix wave: a non-2xx
// HTTP status ALSO counts against the breaker now (this file's own
// `http-status` branch below) — before this fix a manifest endpoint that
// fast-failed every health re-check with e.g. HTTP 500 accumulated
// nothing, so it never tripped open and never auto-disabled.

import { describeLppManifestParseFailure, parseLppManifest, type LppManifest, type LppManifestParseResult } from "@loombre/plugin-protocol";
import { hardenedFetch, HardenedFetchError, type DnsLookupFn, type SsrfRejectionReason } from "./ssrf.js";
import { LPP_MANIFEST_MAX_BYTES, LPP_MANIFEST_TIMEOUT_MS } from "./timeouts.js";
import { BREAKER_COUNTED_REASONS } from "./call-plugin.js";
import type { PluginCircuitBreaker } from "./breaker.js";

export interface FetchManifestOptions {
  fetchImpl?: typeof fetch;
  /** Defaults to Date.now — only consulted when `breaker` is supplied. */
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  lanAllowlist?: readonly string[];
  dnsLookup?: DnsLookupFn;
  /** Omit during registration's first-ever fetch (no plugin row/breaker
   *  exists yet); supply for every subsequent health-check/re-fetch call. */
  breaker?: PluginCircuitBreaker;
}

export type FetchManifestResult =
  | { ok: true; manifest: LppManifest; raw: unknown }
  | { ok: false; stage: "circuit-open" }
  | { ok: false; stage: "transport"; reason: SsrfRejectionReason; detail: string }
  | { ok: false; stage: "http-status"; status: number; detail: string }
  | { ok: false; stage: "json"; detail: string }
  /** M-2 fix wave: a truly unanticipated throw from `hardenedFetch` or
   *  `parseLppManifest` itself — see this file's own "never throws" doc
   *  comment below. Should be unreachable in practice (parseLppManifest's
   *  own bounds check is the PRIMARY defense against exactly the
   *  RangeError-from-a-deeply-nested-configSchema failure mode this stage
   *  exists for), but this module's documented "never throws" contract now
   *  holds with no caveat at all. */
  | { ok: false; stage: "internal-error"; detail: string }
  | Extract<LppManifestParseResult, { ok: false }>;

/** Human-readable one-liner for any FetchManifestResult failure — mirrors
 *  plugin-protocol's describeLppManifestParseFailure for the staged-parse
 *  stages, and adds the transport/http-status/json/internal-error stages
 *  this module owns on top of it. Suitable to surface directly as a
 *  registration error (C2's "clear ... message" requirement extends to
 *  transport failures too, not just parse failures). */
export function describeFetchManifestFailure(result: Extract<FetchManifestResult, { ok: false }>): string {
  switch (result.stage) {
    case "circuit-open":
      return "this plugin's circuit breaker is currently open (too many recent failures) — the manifest endpoint was not contacted";
    case "transport":
      return `could not reach the plugin's manifest endpoint: ${result.detail}`;
    case "http-status":
      return `manifest endpoint returned HTTP ${result.status}: ${result.detail}`;
    case "json":
      return `manifest response was not valid JSON: ${result.detail}`;
    case "internal-error":
      return `unexpected internal error while processing this plugin's manifest: ${result.detail}`;
    default:
      return describeLppManifestParseFailure(result);
  }
}

/**
 * Fetches `GET <baseUrl>/lpp/manifest` through hardenedFetch (LD5: SSRF
 * guard, timeout, size cap) and runs it through plugin-protocol's staged
 * parseLppManifest. Never throws for an ordinary failure mode (M-2 fix
 * wave: this is now a literal guarantee) — every rejection, INCLUDING a
 * truly unexpected throw from `hardenedFetch` or `parseLppManifest`
 * themselves, is a typed `{ ok: false, ... }` result.
 */
export async function fetchPluginManifest(baseUrl: string, opts: FetchManifestOptions = {}): Promise<FetchManifestResult> {
  const manifestUrl = new URL("/lpp/manifest", baseUrl).toString();
  const clock = opts.clock ?? Date.now;
  const nowMs = clock();

  if (opts.breaker) {
    const admission = opts.breaker.beforeCall(nowMs);
    if (!admission.allowed) return { ok: false, stage: "circuit-open" };
  }

  let response;
  try {
    response = await hardenedFetch(
      manifestUrl,
      { method: "GET", headers: { accept: "application/json" } },
      {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs ?? LPP_MANIFEST_TIMEOUT_MS,
        maxResponseBytes: opts.maxResponseBytes ?? LPP_MANIFEST_MAX_BYTES,
        lanAllowlist: opts.lanAllowlist,
        dnsLookup: opts.dnsLookup,
      },
    );
  } catch (err) {
    if (err instanceof HardenedFetchError) {
      if (opts.breaker && BREAKER_COUNTED_REASONS.includes(err.reason)) {
        opts.breaker.onFailure(nowMs);
      }
      return { ok: false, stage: "transport", reason: err.reason, detail: err.message };
    }
    // H-3/M-2 fix wave: never rethrow — see this file's header.
    if (opts.breaker) {
      opts.breaker.onFailure(nowMs);
    }
    return { ok: false, stage: "internal-error", detail: err instanceof Error ? err.message : String(err) };
  }

  if (response.status < 200 || response.status >= 300) {
    // M-8 fix wave: a non-2xx status DOES count against the breaker now —
    // see call-plugin.ts's header (the identical fix for capability calls).
    // A manifest endpoint that fast-fails every health re-check with e.g.
    // HTTP 500 must be able to trip open exactly like a timeouting one.
    if (opts.breaker) {
      opts.breaker.onFailure(nowMs);
    }
    return {
      ok: false,
      stage: "http-status",
      status: response.status,
      // M-3 fix wave: NEVER echo the upstream response body into the error
      // detail. `POST /admin/plugins/preview` is reachable with an
      // admin-supplied `lanAllowlist` override (C7's intended LAN-plugin
      // support), which makes this endpoint a general-purpose "fetch the
      // first N bytes of any HTTP endpoint the host can reach" oracle if
      // the body is echoed back — combined with the transport/timeout
      // status distinction, a full port scanner. Report the status only.
      detail: `HTTP ${response.status}`,
    };
  }

  opts.breaker?.onSuccess();

  let raw: unknown;
  try {
    raw = JSON.parse(response.bodyText);
  } catch (err) {
    return { ok: false, stage: "json", detail: err instanceof Error ? err.message : String(err) };
  }

  let parsed: LppManifestParseResult;
  try {
    parsed = parseLppManifest(raw);
  } catch (err) {
    // M-2 fix wave, defense in depth: parseLppManifest's own bounds check
    // (packages/plugin-protocol) is the PRIMARY defense against a
    // stack-exhausting configSchema — this catch exists purely so an
    // unanticipated throw from THAT function can never escape THIS
    // function's own "never throws" contract either.
    return { ok: false, stage: "internal-error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed.ok) return parsed;
  return { ok: true, manifest: parsed.manifest, raw };
}
