// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/StageStepper.tsx
//
// The wizard's 5-stage progress indicator — the same pill row as
// apps/web/src/app/setup/_components/PillProgress.tsx (the named precedent),
// generalized over packages/shared's FROZEN StageId/STAGE_ORDER
// (wizard-state.ts, law) instead of the onboarding wizard's own local StepId.
// It is still not a copy-paste of PillProgress the COMPONENT: that one is
// typed against setup's own StepId and lives under app/setup/_components, a
// route-private directory, so this stays a separate small component rather
// than an import across that boundary.
//
// L2 (UIFIX-2026-08-29): the two components no longer duplicate the STYLING,
// though. The shared recipe now lives in ../../ui/StepPills.module.css and
// both sides compose it — components/ui is importable from either directory,
// so the route-privacy argument above never applied to the stylesheet half.
// Keeping two copies had already cost a real drift: only this one had grown
// the phone-width block, which composition now hands to PillProgress too.

import { Check } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { STAGE_ORDER, stageIndex, type StageId } from "@loombre/shared/remote";
import styles from "./StageStepper.module.css";

const STAGE_LABELS: Record<StageId, string> = {
  interview: "Interview",
  recommendation: "Recommendation",
  "path-flow": "Set up",
  proof: "Prove it works",
  "posture-handoff": "Done",
};

export function StageStepper({ current }: { current: StageId }): React.JSX.Element {
  const currentIdx = stageIndex(current);

  return (
    <ol className={styles.track} aria-label="Remote access setup progress">
      {STAGE_ORDER.map((stage) => {
        const idx = stageIndex(stage);
        const state = idx < currentIdx ? "done" : idx === currentIdx ? "current" : "upcoming";
        return (
          <li key={stage} className={styles.pill} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            {state === "done" ? (
              <span className={styles.check}>
                <Icon icon={Check} size="dense" />
              </span>
            ) : null}
            <span className={styles.label}>{STAGE_LABELS[stage]}</span>
          </li>
        );
      })}
    </ol>
  );
}
