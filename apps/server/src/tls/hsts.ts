// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/hsts.ts
//
// HSTS (P4.4 / docs/PLAN.md §10 "HSTS on by default when TLS is terminated
// internally"). The rule is deliberately narrow — Strict-Transport-Security
// is set if and only if BOTH:
//
//   1. `tlsInternal` — this process itself is terminating TLS (LOOMBRE_TLS_MODE
//      is "manual" or "acme"; a browser's connection to Loombre really is
//      HTTPS all the way to this process).
//   2. `!trustProxyEnabled` — LOOMBRE_TRUST_PROXY is NOT set.
//
// Why #2 overrides even a "yes, TLS is on" answer: LOOMBRE_TRUST_PROXY (P2.2)
// is the operator's explicit declaration that a reverse proxy sits in front
// of Loombre and that Loombre should trust *that proxy's* X-Forwarded-* — the
// same signal doubles as "there's a proxy in this request's path". In that
// topology the proxy is the actual HTTPS terminator the browser talks to
// (Caddy/nginx/Traefik per docs/ops/remote-access/reverse-proxy.md); it owns the
// Strict-Transport-Security header for two concrete reasons: (a) the proxy
// may reasonably run Loombre itself over plain HTTP on the loopback/LAN hop
// behind it, so a header written here describing "the connection to ME is
// HTTPS" would be actively false for that hop, and (b) sending HSTS from
// two layers with two different `max-age`/`includeSubDomains` opinions is a
// same-origin conflict an operator did not ask for. Concretely: Loombre
// itself is NEVER the one deciding HSTS policy for a reverse-proxied
// install — that setup's HSTS story is entirely the proxy config's job
// (each docs/ops/remote-access/reverse-proxy.md recipe says so explicitly).
//
// It would in principle be possible for BOTH `tlsInternal` and
// `trustProxyEnabled` to be true at once (TLS mode=manual/acme AND
// LOOMBRE_TRUST_PROXY set) — an unusual "double TLS termination" setup. The
// rule above still applies: the proxy signal wins, no HSTS from Loombre.
// This is intentional, not an oversight, per the reasoning above.

import type { INestApplication } from "@nestjs/common";
import type { Express, NextFunction, Request, Response } from "express";

/** ~180 days — long enough to be meaningfully "sticky" for a browser,
 *  short enough that a misconfigured cert/DNS mistake self-heals inside
 *  half a year rather than requiring a manual browser HSTS-cache clear.
 *  NOT operator-overridable: applyHsts's only call site (src/main.ts)
 *  never passes `maxAgeSeconds`, so every internally-terminated install
 *  sends exactly `max-age=<this>; includeSubDomains` — never `preload`.
 *  Loombre never submits to the HSTS preload list itself (D14: no
 *  phone-home, and preload submission is an irreversible-by-Loombre act
 *  against a domain we don't own) — an operator who wants the longer
 *  preload-eligible value (31536000, one year+) and a `preload`
 *  directive terminates TLS at their own reverse proxy and sets the
 *  header there, documented in docs/ops/remote-access/acme.md's "HSTS"
 *  section. */
export const DEFAULT_HSTS_MAX_AGE_SECONDS = 15_552_000;

export interface HstsOptions {
  tlsInternal: boolean;
  trustProxyEnabled: boolean;
  maxAgeSeconds?: number;
}

export function shouldEnableHsts(opts: HstsOptions): boolean {
  return opts.tlsInternal && !opts.trustProxyEnabled;
}

export function resolveHstsMaxAgeSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HSTS_MAX_AGE_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HSTS_MAX_AGE_SECONDS;
}

/** Registers the HSTS middleware, or does nothing at all when
 *  shouldEnableHsts() is false — no middleware is added in that case, so
 *  this is a true no-op (matches applySecurityHeaders/applyCors's pattern
 *  in src/main.ts: off-path behavior stays byte-identical). */
export function applyHsts(app: INestApplication, opts: HstsOptions): void {
  if (!shouldEnableHsts(opts)) return;
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_HSTS_MAX_AGE_SECONDS;
  const value = `max-age=${maxAge}; includeSubDomains`;
  const httpAdapter = app.getHttpAdapter().getInstance() as Express;
  httpAdapter.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Strict-Transport-Security", value);
    next();
  });
}
