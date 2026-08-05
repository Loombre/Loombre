// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PostureCardSlot.tsx
//
// U1's seam, now filled (STATE.md "Loombre Remote ...", mission item 1,
// lane U3): PathManagementCard.tsx and PostureHandoffStage.tsx both render
// THIS one component, so the real posture card (PostureCard.tsx) lands in
// exactly one place despite being visible from two surfaces. The
// `data-testid` U1 put here for exactly this purpose is kept unchanged —
// PathManagementCard.test.tsx's "always renders the posture-card seam for
// U3" assertion depends on it still being present.

import { PostureCard } from "./PostureCard.js";
import type { PathId } from "@loombre/shared/remote";

export function PostureCardSlot({ activePath }: { activePath: PathId }): React.JSX.Element {
  return (
    <div data-testid="posture-card-slot">
      <PostureCard activePath={activePath} />
    </div>
  );
}
