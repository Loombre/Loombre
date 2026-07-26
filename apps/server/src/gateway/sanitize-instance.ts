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

import type { Request } from "express";

export function sanitizeInstancePath(req: Request): string {
  const [pathPart, queryPart] = req.originalUrl.split("?", 2);
  if (queryPart === undefined) return req.originalUrl;

  const params = new URLSearchParams(queryPart);
  if (!params.has("token")) return req.originalUrl;

  params.delete("token");
  const rest = params.toString();
  return rest.length > 0 ? `${pathPart}?${rest}` : String(pathPart);
}
