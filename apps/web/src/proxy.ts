// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/proxy.ts
//
// Next 16 renamed the middleware convention: middleware.ts → proxy.ts,
// exported `middleware` → `proxy`, always the Node.js runtime (Edge is not
// supported in proxy — nothing here needed Edge). Content unchanged from
// the middleware.ts era otherwise.
//
// Phase 4 lane G1 deliverable 1 — closes the Phase 2 Open item ("CSP
// tightening: script-src carries 'unsafe-inline' until nonce middleware
// lands"). See src/lib/csp.ts's header for the full design rationale
// (why a nonce needs middleware at all, the strict-dynamic mechanism, the
// LOOMBRE_SERVER_ORIGIN <-> LOOMBRE_CORS_ORIGINS pairing). This file is
// deliberately thin — every decision lives in csp.ts, which is unit-tested
// without needing Next's runtime; this file is Next-specific WIRING only:
//
//   1. Generate a fresh nonce for this request.
//   2. Set the SAME Content-Security-Policy value (nonce included) on
//      BOTH the REQUEST headers passed into NextResponse.next() AND the
//      response headers — see the inline comment below for exactly why
//      both are required (this is the CRITICAL Phosphor W3 fidelity-audit
//      fix: the request-header half was missing, which meant Next's own
//      script-nonce-stamping pipeline never saw a nonce at all).
//   3. Also forward `x-nonce` as its own request header (a convenience
//      alias of the same value — some call sites may prefer reading a
//      single raw nonce string over parsing it back out of a CSP header).
//
// Runs on every route (matcher below excludes only Next's own static asset
// paths — nothing here is auth-gated, unlike a typical Next proxy
// example; that stays client-side in this app, see auth-store.ts) so every
// HTML response gets a fresh, unpredictable nonce — PROVIDED the route is
// actually dynamically rendered per request; see app/layout.tsx's header
// for the other half of this fix (a route Next statically prerenders has
// no request in scope at build time to read a nonce from at all).

import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce, resolveServerOrigins } from "./lib/csp.js";

const isDev = process.env.NODE_ENV !== "production";

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    isDev,
    serverOrigins: resolveServerOrigins(process.env.LOOMBRE_SERVER_ORIGIN),
  });

  // CRITICAL (Phosphor W3 fidelity-audit finding, pre-existing since Phase
  // 4 G1/b9f4d16): the CSP header must ALSO be set on the REQUEST headers
  // passed into NextResponse.next(), not just the response. Next's own
  // rendering pipeline (app-render.js's parseRequestHeaders ->
  // getScriptNonceFromHeader) reads the nonce from the Content-Security-
  // Policy header it sees on the INCOMING request WHILE IT IS ACTUALLY
  // RENDERING THE ROUTE — this is how it decides to stamp that same nonce
  // onto every script tag it injects itself (e.g. the self.__next_f RSC
  // bootstrap). Setting the header on the response alone (the previous
  // state of this file) means that pipeline never sees a nonce at all:
  // every route it renders ships script tags with NO nonce attribute,
  // which strict-dynamic + nonce (no unsafe-inline) then blocks outright
  // — zero working client JS. This is Next's own documented pattern
  // (https://nextjs.org/docs — "Content Security Policy"), not a Loombre
  // invention. NOTE: this alone only reaches routes Next actually
  // RE-RENDERS per request — a route it has classified as fully static is
  // pre-rendered once at build time (no request in scope, no nonce to
  // read) and served byte-identical from the Full Route Cache forever
  // after, this header rewrite notwithstanding. Making every route pick up
  // a fresh nonce also requires app/layout.tsx to call a Dynamic API (see
  // that file's header) — the other half of this same fix. Verified
  // end-to-end: `next build` (route table ○ -> ƒ) + `next start`, curl the
  // response, script tags carry a real matching nonce="..." value (see
  // proxy.test.ts's regression guard + this lane's freeze report for the
  // exact curl transcript).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match every route EXCEPT Next's own static asset paths — those are
     * fingerprinted, immutable build output (no inline scripts of their
     * own to nonce, and a CSP header on them is inert overhead).
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
