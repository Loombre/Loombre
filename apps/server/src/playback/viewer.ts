// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/viewer.ts
//
// Local copy of apps/server/src/catalog/viewer.ts's resolveViewer() helper.
// NOT imported from catalog/ — dependency-cruiser forbids playback/
// importing catalog/ directly (D2, "share only IDs"), so this tiny helper
// (same body, same contract) lives here instead of being shared across the
// boundary. Keep both copies in lock-step if the resolution logic ever
// changes; the duplication is the price of the module boundary.

import { nowMs as clockNowMs } from "@loombre/shared";
import type { ViewerContext } from "@loombre/db";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";

export function resolveViewer(
  provider: ViewerContextProvider,
  req: AuthenticatedRequest,
): Promise<ViewerContext> {
  return provider.resolve(req.user!.userId, clockNowMs());
}
