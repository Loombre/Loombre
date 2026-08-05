// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PostureCardSlot.tsx
//
// R7's exposure-aware posture card is U3's build (STATE.md Batch plan —
// U3 lands after Batch 1). This lane's mission item 1 asks for "a clean
// composition seam + placeholder" in TWO places: the management view
// (PathManagementCard.tsx) and the wizard's posture-handoff stage
// (PostureHandoffStage.tsx) — both render THIS one component so U3 has a
// single place to swap in the real card rather than two copies to keep in
// sync. `data-testid` exists purely so this lane's own tests (and U3's,
// later) can assert the seam is actually mounted without depending on its
// placeholder copy.

import { PATH_LABELS } from "./path-labels.js";
import type { PathId } from "@loombre/shared/remote";
import styles from "./PostureCardSlot.module.css";

export function PostureCardSlot({ activePath }: { activePath: PathId }): React.JSX.Element {
  return (
    <div className={styles.slot} data-testid="posture-card-slot">
      <p className={styles.slotLabel}>Security posture</p>
      <p className={styles.slotBody}>
        The exposure-aware posture card lands in a follow-up pass — it will grade {PATH_LABELS[activePath]}'s TLS,
        rate limiting, stale-account, and exposure checks here, with links to fix anything it flags.
      </p>
    </div>
  );
}
