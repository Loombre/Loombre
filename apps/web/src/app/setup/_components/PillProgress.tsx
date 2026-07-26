// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/_components/PillProgress.tsx
//
// The wizard's step indicator — a row of pills (P2.7: --radius-pill is the
// ONLY allowed radius for progress indicators), one per step excluding
// "done" (the destination, not a step you sit on). Purely presentational;
// all sequencing logic lives in ../wizard-state.ts.

import { Check } from "lucide-react";
import { Icon } from "../../../components/icon/Icon.js";
import { STEP_ORDER, stepIndex, type StepId } from "../wizard-state.js";
import styles from "./PillProgress.module.css";

const VISIBLE_STEPS: readonly StepId[] = STEP_ORDER.filter((step) => step !== "done");

export interface PillProgressProps {
  current: StepId;
  labels: Record<StepId, string>;
}

export function PillProgress({ current, labels }: PillProgressProps): React.JSX.Element {
  const currentIdx = stepIndex(current);

  return (
    <ol className={styles.track} aria-label="Setup progress">
      {VISIBLE_STEPS.map((step) => {
        const idx = stepIndex(step);
        const state = idx < currentIdx ? "done" : idx === currentIdx ? "current" : "upcoming";
        return (
          <li key={step} className={styles.pill} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            {state === "done" ? (
              <span className={styles.check}>
                <Icon icon={Check} size="dense" />
              </span>
            ) : null}
            <span className={styles.label}>{labels[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}
