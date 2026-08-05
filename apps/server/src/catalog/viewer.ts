// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/viewer.ts
//
// Shared "resolve a ViewerContext for this request" helper — every catalog
// controller needs exactly this, always the same way (AuthGuard guarantees
// req.user on any non-public route, so `req.user!` is safe here).

import { nowMs as clockNowMs } from "@loombre/shared";
import type { ViewerContext } from "@loombre/db";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { parseLimitParam } from "../common/limit-param.js";

export function resolveViewer(
  provider: ViewerContextProvider,
  req: AuthenticatedRequest,
): Promise<ViewerContext> {
  return provider.resolve(req.user!.userId, clockNowMs());
}

const VALID_SORTS = new Set(["title", "added", "rating", "year"]);
const VALID_ORDERS = new Set(["asc", "desc"]);

export interface ListQuery {
  cursor?: string;
  limit?: number;
  libraryId?: string;
  /** Gap-closure lane: browse Sort control (packages/contract/openapi.yaml's
   *  Sort/Order query parameters). */
  sort?: "title" | "added" | "rating" | "year";
  order?: "asc" | "desc";
}

/** Parses the common list-endpoint query params Express hands controllers
 *  as `Record<string, unknown>` (querystring values are always strings,
 *  but Express types them loosely). Malformed `limit`/`sort`/`order` are
 *  ignored (fall through to each query function's own default) rather than
 *  422'd — same lenient posture the contract already documents for `limit`
 *  (no dedicated error path for an unrecognized enum value either). */
export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const result: ListQuery = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  if (typeof query["libraryId"] === "string") result.libraryId = query["libraryId"];
  {
    const limit = parseLimitParam(query["limit"]);
    if (limit !== undefined) result.limit = limit;
  }
  if (typeof query["sort"] === "string" && VALID_SORTS.has(query["sort"])) {
    result.sort = query["sort"] as "title" | "added" | "rating" | "year";
  }
  if (typeof query["order"] === "string" && VALID_ORDERS.has(query["order"])) {
    result.order = query["order"] as "asc" | "desc";
  }
  return result;
}
