// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/sanitize-instance.ts
//
// P2.18: query-token auth (?token=<accessToken>) means a request URL can now
// carry a bearer credential in its query string on the two routes
// AllowQueryToken() marks. RFC 9457 problem responses conventionally echo
// the request path back as `instance` (see problem.exception.ts's notFound
// et al.) — every call site that builds one from `req.originalUrl` must
// strip `token` first, or a 401/404 error BODY (not just a log line) would
// hand the credential back in the response. This is the one shared helper
// every such call site uses instead of `req.originalUrl` directly, so the
// redaction can't silently regress on one call site while another remembers.
//
// F9 (opus adversarial review, fix wave): a query-string `?token=` is not
// the only way a secret rides along in `req.originalUrl` — the invite-claim
// route carries the raw token as a PATH SEGMENT
// (/invites/claim/{token}), which the ?token= stripping above never
// touches. TOKEN_PATH_TEMPLATES collapses a whole family of routes to
// their static route template (the token value itself never appears in
// the returned string) BEFORE the query-string handling runs — a
// tokenless path can't have a token-bearing query string appended by a
// legitimate client, but checking first costs nothing and is one fewer
// assumption.

import type { Request } from "express";

const TOKEN_PATH_TEMPLATES: ReadonlyArray<{ pattern: RegExp; template: string }> = [
  { pattern: /^\/invites\/claim\/[^/]+$/, template: "/invites/claim/{token}" },
  // STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
  // reachability proof + posture card" (R6/R9, Wave 0): GET /probe/{token}
  // carries the raw one-time reachability-proof token as a path segment,
  // same posture as the invite-claim route above — its 429 (rate-limited)
  // response must never echo the token back via `instance`.
  { pattern: /^\/probe\/[^/]+$/, template: "/probe/{token}" },
];

export function sanitizeInstancePath(req: Request): string {
  const [pathPart, queryPart] = req.originalUrl.split("?", 2);

  for (const { pattern, template } of TOKEN_PATH_TEMPLATES) {
    if (pattern.test(pathPart ?? req.originalUrl)) {
      return template;
    }
  }

  if (queryPart === undefined) return req.originalUrl;

  const params = new URLSearchParams(queryPart);
  if (!params.has("token")) return req.originalUrl;

  params.delete("token");
  const rest = params.toString();
  return rest.length > 0 ? `${pathPart}?${rest}` : String(pathPart);
}
