// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/viewer.ts
//
// Local sibling of apps/server/src/catalog/viewer.ts's resolveViewer()
// helper. NOT imported from catalog/ — dependency-cruiser forbids playback/
// importing catalog/ directly (D2, "share only IDs"), so this tiny helper
// lives here instead of being shared across the boundary. The duplication
// is the price of the module boundary.
//
// RZI surface scoping (§6.4 as amended 2026-08-30, ruling RZI-D3): EVERY
// playback read is item-addressed and serves the player — including the
// zone's — so this helper resolves the RESTRICTED surface. Restricted rows
// still require the full five-gate clearance; the item is simply not
// invisible-by-surface to the one component whose job is to play it.
// grep-gates pass (f) allowlists this file for exactly this call.

import { nowMs as clockNowMs } from "@loombre/shared";
import type { ViewerContext } from "@loombre/db";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";

export function resolveViewer(
  provider: ViewerContextProvider,
  req: AuthenticatedRequest,
): Promise<ViewerContext> {
  return provider.resolveRestrictedSurface(req.user!.userId, clockNowMs());
}
