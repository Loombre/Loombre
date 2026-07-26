// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/call-plugin.ts
//
// LD2/LD8: "callPlugin wrappers that apply timeout+breaker+SSRF uniformly
// (the seam W3/W4 call through)". This is that seam — every capability
// call (metadata-provider search/details/images, event-subscriber
// delivery) is meant to go through this function, never a raw fetch. The
// breaker is CALLER-OWNED (a `PluginCircuitBreaker` instance the caller
// constructs/persists per plugin — this package holds no module-level
// state of its own, keeping it pure per LD2) and OPTIONAL: a caller that
// has no breaker yet for this plugin (e.g. the very first manifest fetch
// during registration, before any row exists) may omit it and simply skip
// breaker gating for that one call.
//
// Failure classification for breaker purposes (a lane decision, not pinned
// by the rails — see this lane's final report): only `timeout` and
// `network-error` HardenedFetchError reasons count against the breaker.
// Every OTHER rejection reason (`unsupported-scheme`, `invalid-url`,
// `dns-resolution-failed`, `disallowed-address`, `redirect-not-followed`,
// `response-too-large`) reflects either a caller/config bug or a plugin
// actively misbehaving in a way LD8's "no plugin can stall anything"
// timeout/breaker pairing was never meant to paper over — none of those
// should push an otherwise-healthy plugin toward auto-disable, and
// `dns-resolution-failed`/`disallowed-address` in particular must never be
// retried into "maybe it'll resolve differently next time".
//
// M-8 fix wave: an ordinary NON-2xx HTTP status (the call transported fine,
// the plugin just answered with e.g. 500) now counts as a breaker FAILURE
// too — before this fix, `hardenedFetch` resolving at all (any status
// outside the 3xx-redirect range) unconditionally called `onSuccess()`, so
// a plugin that fast-failed every single call with HTTP 500 accumulated
// NOTHING: the breaker stayed closed at zero forever and
// PluginHealthService's auto-disable predicate (which requires
// `snapshot().state === "open"`) never fired. LD8's "N failures ->
// auto-disable" reads as failure-of-any-kind, not transport-only.
//
// H-3 fix wave: this function's documented contract ("never throws for an
// ordinary rejection... only a genuine programmer error propagates", see
// below) is now genuinely true — an unexpected throw from `hardenedFetch`
// that is NOT a `HardenedFetchError` (a host bug, or a caller-supplied
// `fetchImpl` misbehaving in some way `hardenedFetch` itself does not
// classify) is mapped to a COUNTED `network-error` result instead of being
// rethrown. This closes the actual H-3 failure mode at a second, defensive
// layer: `ssrf.ts`'s own H-3 fix (classifying an abort during the response
// body read the same way an abort during the initial fetch already was)
// closes the SPECIFIC known cause, but a delivery loop or metadata adapter
// that trusted "callPlugin never throws" to mean exactly that should never
// have that assumption violated by any FUTURE untyped throw either.

import { hardenedFetch, HardenedFetchError, type DnsLookupFn, type SsrfRejectionReason } from "./ssrf.js";
import type { PluginCircuitBreaker } from "./breaker.js";

/** HardenedFetchError reasons that count as a breaker failure — see this
 *  file's header for the rationale. Exported so callers/tests can assert
 *  against the same list rather than duplicating it. */
export const BREAKER_COUNTED_REASONS: readonly SsrfRejectionReason[] = ["timeout", "network-error"];

export interface CallPluginOptions {
  fetchImpl?: typeof fetch;
  /** Defaults to Date.now — injected for deterministic breaker tests. */
  clock?: () => number;
  timeoutMs: number;
  maxResponseBytes: number;
  lanAllowlist?: readonly string[];
  dnsLookup?: DnsLookupFn;
  /** Extra headers merged over anything in `init.headers` (typically
   *  headers.ts's buildPluginRequestHeaders output). */
  headers?: Record<string, string>;
  /** Omit to skip breaker gating entirely for this one call. */
  breaker?: PluginCircuitBreaker;
}

export type CallPluginResult =
  | { ok: true; status: number; headers: Headers; bodyText: string }
  | { ok: false; reason: "circuit-open" }
  | { ok: false; reason: SsrfRejectionReason; detail: string };

/**
 * Composes breaker admission -> hardenedFetch (SSRF guard + timeout + size
 * cap) -> breaker outcome recording into one call. NEVER throws (H-3 fix
 * wave — this is now a literal guarantee, not just a documentation claim):
 * every ordinary rejection (breaker-open, any HardenedFetchError reason, a
 * non-2xx HTTP status, or any OTHER unexpected throw) comes back as a typed
 * `CallPluginResult`.
 */
export async function callPlugin(url: string, init: RequestInit, opts: CallPluginOptions): Promise<CallPluginResult> {
  const clock = opts.clock ?? Date.now;
  const nowMs = clock();

  if (opts.breaker) {
    const admission = opts.breaker.beforeCall(nowMs);
    if (!admission.allowed) {
      return { ok: false, reason: "circuit-open" };
    }
  }

  const mergedHeaders: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    ...opts.headers,
  };

  try {
    const result = await hardenedFetch(
      url,
      { ...init, headers: mergedHeaders },
      {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        maxResponseBytes: opts.maxResponseBytes,
        lanAllowlist: opts.lanAllowlist,
        dnsLookup: opts.dnsLookup,
      },
    );
    // M-8 fix wave: a non-2xx status is a breaker FAILURE, not a success —
    // see this file's header.
    const isHttpSuccess = result.status >= 200 && result.status < 300;
    if (isHttpSuccess) {
      opts.breaker?.onSuccess();
    } else {
      opts.breaker?.onFailure(nowMs);
    }
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof HardenedFetchError) {
      if (opts.breaker && BREAKER_COUNTED_REASONS.includes(err.reason)) {
        opts.breaker.onFailure(nowMs);
      }
      return { ok: false, reason: err.reason, detail: err.message };
    }
    // H-3 fix wave: never rethrow — see this file's header. Treated exactly
    // like a `network-error` HardenedFetchError for breaker-counting
    // purposes (the one unexpected-throw case this branch exists for is,
    // definitionally, a transport-layer failure of some kind).
    if (opts.breaker) {
      opts.breaker.onFailure(nowMs);
    }
    return { ok: false, reason: "network-error", detail: err instanceof Error ? err.message : String(err) };
  }
}
