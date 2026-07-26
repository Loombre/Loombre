// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/csp.ts
//
// Phase 4 lane G1 deliverable 1 (closes the Phase 2 Open item: "CSP
// tightening: script-src carries 'unsafe-inline' until nonce middleware
// lands"). Pure, framework-free CSP-building logic — proxy.ts (nee middleware.ts) is the
// thin Next-specific glue that calls generateNonce()/buildCsp() and wires
// the result into request/response headers; everything decision-worthy
// lives here so it's unit-testable without booting Next's dev/edge runtime.
//
// WHY THIS REPLACES next.config.mjs's static CSP (that file's own header,
// left in place as the historical record of the tradeoff this closes):
// Next 15's App Router injects MANY inline `<script>` tags per response
// (the `self.__next_f` RSC-payload bootstrap) whose content is dynamic —
// per route, per build, per request — so a build-time STATIC CSP can never
// hash them; the only CSP-spec-compliant fix is a PER-REQUEST nonce, which
// requires middleware (headers() are evaluated once at build/start, not
// per request, per that file's own note). This module + proxy.ts are
// that fix.
//
// script-src: 'nonce-<random>' 'strict-dynamic' — NO 'unsafe-inline'.
// 'strict-dynamic' is what makes this actually work with Next's own
// script-injection pattern: a nonce'd (or already-trusted) script may
// itself inject further `<script>` tags (exactly what Next's hydration/
// route-chunk loading does), and those inherit trust WITHOUT each needing
// its own nonce — this is the Next-documented production CSP pattern, not
// a Loombre invention. CSP-Level-3-aware browsers IGNORE host-source/
// scheme-source AND 'unsafe-inline' in a directive that also carries a
// nonce/strict-dynamic (verified this exact rule bit the previous
// hash-based attempt — see next.config.mjs's header), so `'unsafe-inline'`
// would be dead weight for modern browsers and is simply not included.
//
// connect/img/media-src: 'self' + explicit LOOMBRE_SERVER_ORIGIN pairing
// (documented below) replacing the previous blanket `http: https:` scheme
// wildcard — task-mandated tightening. blob: is KEPT on media-src
// unconditionally: hls.js attaches MediaSource via a blob: object URL
// (STATE.md Phase 3 step 7's own scar tissue — "the P3 lesson: it broke
// playback once" — this is the regression this module must never
// reintroduce; see csp.test.ts's dedicated regression-guard assertion and
// this task's browser checklist for the orchestrator).
//
// LOOMBRE_SERVER_ORIGIN <-> LOOMBRE_CORS_ORIGINS pairing (documented, task
// spec): apps/server's LOOMBRE_CORS_ORIGINS (apps/server/src/main.ts)
// allow-lists which WEB origins may call the API; this web app's
// LOOMBRE_SERVER_ORIGIN is the INVERSE — which API/server origin(s) THIS
// web build is allowed to fetch/stream from. They are set by the SAME
// operator, pointing at each other:
//   apps/server: LOOMBRE_CORS_ORIGINS=https://loombre.example.com
//   apps/web:    LOOMBRE_SERVER_ORIGIN=https://api.loombre.example.com
// Comma-separated, same parsing convention as apps/server's
// resolveCorsOrigins (trim, strip trailing slash, drop empties). This is
// OPTIONAL: the documented v1 deployment shape (docs/PLAN.md — the login
// screen takes an arbitrary server URL, persisted client-side,
// auth-store.ts's `serverUrl`) means a single public web build often talks
// to MANY different operator-run servers with NO single origin known at
// request time — exactly why the PREVIOUS scheme-wildcard tradeoff existed
// (next.config.mjs's header explains it as "a build-time static CSP has no
// way to know it in advance"). Middleware doesn't change that structural
// fact (the origin lives in the BROWSER's localStorage, invisible to a
// server-side request handler) — LOOMBRE_SERVER_ORIGIN only tightens the
// CSP for the (increasingly common, and the one where tightening matters
// most) case of a SINGLE-TENANT deployment where the operator runs web+
// server together and knows the pairing at deploy time. When unset, this
// falls back to the SAME scheme-wildcard posture as before (documented,
// not silently reintroduced) — still real tightening vs. the OLD
// 'unsafe-inline' script-src, and still closes this wave's mandated gap.

const NONCE_BYTE_LENGTH = 16;

/** A fresh, cryptographically random nonce for THIS request only —
 *  base64-encoded 16 random bytes (128 bits), the standard CSP nonce
 *  shape. Uses the Web Crypto API (`crypto.getRandomValues`/`btoa`), which
 *  Next's middleware runtime (Edge by default, but also plain Node) both
 *  expose as globals — no Node-only `node:crypto` import, which would
 *  break under the Edge runtime. */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Same parsing convention as apps/server/src/main.ts's resolveCorsOrigins
 *  (comma-separated, trimmed, trailing slash stripped, empties dropped) —
 *  deliberately mirrored so operators reason about ONE parsing rule for
 *  both env vars in the pairing. */
export function resolveServerOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
}

export interface BuildCspOptions {
  nonce: string;
  isDev: boolean;
  /** Parsed via resolveServerOrigins — empty means "no explicit origin
   *  configured", which falls back to the scheme-wildcard posture. */
  serverOrigins: string[];
}

/** Builds connect-src/img-src/media-src's origin allowance: explicit
 *  origins (+ their ws(s):// siblings on connect-src, for events-socket.ts)
 *  when LOOMBRE_SERVER_ORIGIN is set, else the documented scheme-wildcard
 *  fallback (http:/https: — and ws:/wss: for connect-src specifically). */
function resolveDataOrigins(serverOrigins: string[], includeWebSocketSchemes: boolean): string[] {
  if (serverOrigins.length === 0) {
    return includeWebSocketSchemes ? ["http:", "https:", "ws:", "wss:"] : ["http:", "https:"];
  }
  const wsEquivalents = includeWebSocketSchemes
    ? serverOrigins.map((origin) => origin.replace(/^http/, "ws"))
    : [];
  return [...serverOrigins, ...wsEquivalents];
}

export function buildCsp(opts: BuildCspOptions): string {
  const scriptSrc = [`'nonce-${opts.nonce}'`, "'strict-dynamic'", ...(opts.isDev ? ["'unsafe-eval'"] : [])].join(" ");

  const connectSrc = ["'self'", ...resolveDataOrigins(opts.serverOrigins, true)].join(" ");
  const imgSrc = ["'self'", "data:", "blob:", ...resolveDataOrigins(opts.serverOrigins, false)].join(" ");
  // blob: — REQUIRED for hls.js's MediaSource attach (see this module's
  // header — Phase 3's real regression). Never drop it.
  const mediaSrc = ["'self'", "blob:", ...resolveDataOrigins(opts.serverOrigins, false)].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // style-src 'unsafe-inline': STILL required (next.config.mjs's own
    // header — VERIFIED, not assumed: 13 files use inline `style={{`
    // props, which CSP gates identically to inline <style> blocks). Style
    // injection has a fundamentally smaller blast radius than script
    // injection (no code execution), and CSP has no nonce/strict-dynamic
    // equivalent workaround for the style ATTRIBUTE case the way it does
    // for scripts — a per-element style nonce isn't a real spec mechanism.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `connect-src ${connectSrc}`,
    // font-src 'self': Phosphor (U6) self-hosts Archivo + IBM Plex Mono as
    // static assets under apps/web/public/fonts/ — no runtime font CDN, so
    // this never needs (and must never gain) a fonts.googleapis.com/
    // fonts.gstatic.com allowance. See csp.test.ts's dedicated regression
    // guard (same pattern as the media-src blob: guard above).
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
