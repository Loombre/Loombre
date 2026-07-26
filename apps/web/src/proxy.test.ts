// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/proxy.test.ts
//
// Regression test for the CRITICAL pre-existing bug the Phosphor W3
// fidelity audit surfaced:
// proxy.ts used to set the Content-Security-Policy header on the
// RESPONSE only. Next's automatic script-nonce stamping (the mechanism
// that puts a matching nonce="..." attribute on every script tag Next
// itself injects — the self.__next_f RSC bootstrap, chunk-loader scripts,
// etc.) reads the nonce from the CSP header it sees on the REQUEST that
// reaches its own rendering pipeline, not from the response. Missing that
// meant every statically-rendered route shipped script tags with NO
// nonce, which nonce+strict-dynamic (no unsafe-inline) then blocked
// outright — zero working client JS under `next start`. csp.test.ts
// proves the STRING is correct; this file proves it actually reaches the
// request-header channel Next's pipeline reads.
//
// How the assertion works: NextResponse.next({ request: { headers } })
// doesn't expose the rewritten request object directly (there is no
// downstream handler in a unit test to hand it to) — Next instead encodes
// the override onto the RESPONSE via two headers so its own server
// machinery can reconstruct the request further down the pipeline:
//   x-middleware-override-headers: a comma-separated list of header names
//     that were added/changed on the request.
//   x-middleware-request-<name>: the actual value for each overridden
//     header.
// Asserting on `x-middleware-request-content-security-policy` is
// asserting on the exact channel Next's own pipeline consumes — this is
// Next's documented middleware/proxy contract, not an implementation
// detail this test invented (the same shape webpack-internal Next test
// suites and community nonce-middleware writeups assert against).

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy.js";

function extractNonce(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  if (!match) throw new Error(`no nonce found in CSP: ${csp}`);
  return match[1] as string;
}

describe("proxy", () => {
  it("sets the Content-Security-Policy header on the RESPONSE (pre-existing behavior, must keep working)", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login"));
    const csp = response.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
  });

  it("REGRESSION GUARD: also propagates the SAME CSP (nonce included) onto the REQUEST headers Next's pipeline reads — the fix for the CRITICAL zero-client-JS bug", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login"));

    // The override-list must name content-security-policy as a header the
    // request received (not just the response) — this is what makes Next
    // render the route dynamically and read the nonce for its own script
    // stamping. Missing this entry is exactly the bug the audit found.
    const overrideList = response.headers.get("x-middleware-override-headers");
    expect(overrideList).toBeTruthy();
    expect(overrideList?.split(",")).toContain("content-security-policy");

    const responseCsp = response.headers.get("content-security-policy");
    const requestCsp = response.headers.get("x-middleware-request-content-security-policy");
    expect(requestCsp).toBeTruthy();

    // Same nonce on both sides — the request-header CSP isn't a second,
    // independently generated policy; it's the identical value the
    // response carries (one nonce per request, used everywhere).
    expect(extractNonce(requestCsp as string)).toBe(extractNonce(responseCsp as string));
  });

  it("also propagates x-nonce onto the request headers (read back by app/layout.tsx's headers() for the one inline <script> this app renders itself)", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login"));
    const overrideList = response.headers.get("x-middleware-override-headers")?.split(",") ?? [];
    expect(overrideList).toContain("x-nonce");

    const requestNonce = response.headers.get("x-middleware-request-x-nonce");
    const cspNonce = extractNonce(response.headers.get("content-security-policy") as string);
    expect(requestNonce).toBe(cspNonce);
  });

  it("generates a fresh nonce (and therefore a fresh request-propagated CSP) on every call — never a cached/static value", () => {
    const first = proxy(new NextRequest("http://localhost:3000/login"));
    const second = proxy(new NextRequest("http://localhost:3000/login"));
    const firstNonce = requestPropagatedNonce(first);
    const secondNonce = requestPropagatedNonce(second);
    expect(firstNonce).not.toBe(secondNonce);
  });
});

function requestPropagatedNonce(response: ReturnType<typeof proxy>): string {
  return extractNonce(response.headers.get("x-middleware-request-content-security-policy") as string);
}
