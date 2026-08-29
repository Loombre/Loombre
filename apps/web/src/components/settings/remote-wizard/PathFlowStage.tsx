// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PathFlowStage.tsx
//
// R8's "chosen path's guided flow" — renders the frozen PATH_FLOW_STEPS[path]
// (packages/shared's wizard-state.ts, law), with each step's body coming from
// PATH_FLOW_STEP_BODIES (./PathFlowStepSlot.tsx, the seam U2 replaces entries
// in). This lane never hand-writes per-path UI itself — only the sequencing
// chrome (progress indicator + Back/Continue wiring) around whatever
// PATH_FLOW_STEP_BODIES[step] renders.
//
// J1 (UIFIX-2026-08-29): that indicator used to be a second pill stepper,
// rendered inside StageStepper's pill stepper. It is now a counter + step
// title + hairline instead — a deliberately DIFFERENT form, so the stage
// sequence (pills, outer) and the path sequence (counter, inner) are
// legible as a hierarchy. See PathFlowStage.module.css for the full note.

import { useState } from "react";
import { nextPathFlowStep, PATH_FLOW_STEPS, type PathFlowContext, type PathFlowStepId, type PathId } from "@loombre/shared/remote";
import { PATH_FLOW_STEP_BODIES, PATH_FLOW_STEP_LABELS } from "./PathFlowStepSlot.js";
import { PATH_LABELS } from "./path-labels.js";
import styles from "./PathFlowStage.module.css";

export interface PathFlowStageProps {
  path: PathId;
  initialStep?: PathFlowStepId | undefined;
  /** The path's flow reached its end (nextPathFlowStep returned null) — the
   *  wizard advances to the "proof" stage (R6). */
  onComplete: () => void;
  /** Backed out of the path's FIRST step — the wizard returns to
   *  recommendation (or interview, if there was no interview run — see
   *  RemoteWizard.tsx). */
  onExit: () => void;
}

export function PathFlowStage({ path, initialStep, onComplete, onExit }: PathFlowStageProps): React.JSX.Element {
  const steps = PATH_FLOW_STEPS[path];
  const [step, setStep] = useState<PathFlowStepId>(initialStep ?? steps[0]!);
  const [context, setContext] = useState<PathFlowContext>({});
  // ACTUALLY-visited steps, not "everything before the current index" — R5's
  // reverse-proxy branch SKIPS direct-acme-test entirely (nextPathFlowStep's
  // documented skip), and marking a skipped step "done" would claim it was
  // completed when it never ran. A history stack also makes Back correct:
  // it returns to the step actually visited before this one, not merely
  // "one array slot earlier" (which would land ON the skipped step).
  const [history, setHistory] = useState<readonly PathFlowStepId[]>([]);

  const StepBody = PATH_FLOW_STEP_BODIES[step];

  function handleStepComplete(contextPatch?: Partial<PathFlowContext>): void {
    const nextContext = contextPatch ? { ...context, ...contextPatch } : context;
    if (contextPatch) setContext(nextContext);
    const next = nextPathFlowStep(path, step, nextContext);
    if (next === null) {
      onComplete();
      return;
    }
    setHistory((h) => [...h, step]);
    setStep(next);
  }

  function handleBack(): void {
    if (history.length === 0) {
      onExit();
      return;
    }
    const previous = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    setStep(previous);
  }

  // Position within the frozen PATH_FLOW_STEPS list — the same basis the old
  // pill row indexed on, so a skipped step (nextPathFlowStep's documented
  // reverse-proxy skip) still counts against the path's real length rather
  // than renumbering the flow mid-run.
  const position = Math.max(0, steps.indexOf(step)) + 1;
  const stepTitle = PATH_FLOW_STEP_LABELS[step];

  return (
    <div className={styles.stage}>
      <p className={styles.pathTitle}>Setting up {PATH_LABELS[path]}</p>
      <div className={styles.progress}>
        <p className={styles.progressCount}>
          Step {position} of {steps.length}
        </p>
        <p className={styles.progressTitle}>{stepTitle}</p>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={`${PATH_LABELS[path]} setup progress`}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={position}
          aria-valuetext={`Step ${position} of ${steps.length}: ${stepTitle}`}
        >
          <div className={styles.progressFill} style={{ transform: `scaleX(${position / steps.length})` }} />
        </div>
      </div>
      <div className={styles.body}>
        <StepBody path={path} step={step} context={context} onStepComplete={handleStepComplete} onBack={handleBack} />
      </div>
    </div>
  );
}
