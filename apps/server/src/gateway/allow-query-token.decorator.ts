// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/allow-query-token.decorator.ts
//
// P2.18 media-fetch auth: browser <img>/<video>/<audio> elements cannot
// send an Authorization header, so a small, explicitly opted-in set of
// GET-only media routes additionally accepts the access JWT via `?token=`.
// AuthGuard (the only reader of this metadata) is the sole enforcement
// point — a route must be decorated here for the query-token fallback to
// be considered at all; every other route stays header-auth only, even if
// a caller appends `?token=` to the URL.

import { SetMetadata } from "@nestjs/common";

export const ALLOW_QUERY_TOKEN_KEY = "loombre:allowQueryToken";

/** Apply to a controller method to allow `?token=<accessToken>` as a
 *  fallback when no (or no valid) Authorization header is present. Scoped
 *  to exactly GET /images/{entityType}/{id}/{kind} and
 *  GET /playback/sessions/{id}/file (STATE.md P2.18) — do not add this to
 *  any other route without a matching STATE.md decision. */
export function AllowQueryToken(): MethodDecorator {
  return SetMetadata(ALLOW_QUERY_TOKEN_KEY, true);
}
