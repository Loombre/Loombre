// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteWizard.tsx
//
// R8/RG10: the three-path wizard, INLINE inside the Remote Access settings
// section (not a modal/sheet — RemoteAccessSection.tsx swaps this in for
// its own body while open). Pure client-side state machine driven by the
// FROZEN packages/shared/src/remote/wizard-state.ts (StageId/PathId/
// transitions are law, per STATE.md freeze decision 4) — this component
// only holds the React state a real server never needs to see (RG10: "the
// server persists only outcomes... never step state").
//
// Deep-linking (STATE.md freeze decision 5 — "make
// /settings/remote-access?path=... REAL"): RemoteAccessSection resolves the
// query params against the last-known GET /admin/remote/state read and
// passes the result down as initialStage/initialPath/initialStep, so this
// component itself stays free of URL/searchParams concerns — it only
// consumes the resolved starting point.

import { useState } from "react";
import type { InterviewAnswers, PathFlowStepId, PathId, StageId } from "@loombre/shared/remote";
import { StageStepper } from "./StageStepper.js";
import { InterviewStage } from "./InterviewStage.js";
import { RecommendationStage } from "./RecommendationStage.js";
import { PathFlowStage } from "./PathFlowStage.js";
import { ProofStage } from "./ProofStage.js";
import { PostureHandoffStage } from "./PostureHandoffStage.js";
import { Button } from "../../ui/Button.js";
import styles from "./RemoteWizard.module.css";

export interface RemoteWizardProps {
  /** Deep-link / re-entry seed. Omit both to start a fresh run at
   *  "interview". Pass initialPath (+ optionally initialStep) to land
   *  directly on path-flow; pass initialStage explicitly to override the
   *  derived default entirely (RemoteAccessSection uses this for the
   *  "target path is already active" deep-link case — deriveEntryStage
   *  says posture-handoff, not path-flow, once nothing is left to
   *  configure). */
  initialStage?: StageId | undefined;
  initialPath?: PathId | null | undefined;
  initialStep?: PathFlowStepId | null | undefined;
  /** Leaves the wizard without having reached posture-handoff (the
   *  header's "Cancel" control). */
  onCancel: () => void;
  /** Reached posture-handoff and the admin clicked "Done". */
  onFinished: () => void;
}

export function RemoteWizard({ initialStage, initialPath, initialStep, onCancel, onFinished }: RemoteWizardProps): React.JSX.Element {
  const [stage, setStage] = useState<StageId>(initialStage ?? (initialPath ? "path-flow" : "interview"));
  const [answers, setAnswers] = useState<InterviewAnswers | null>(null);
  const [chosenPath, setChosenPath] = useState<PathId | null>(initialPath ?? null);

  function handleInterviewComplete(a: InterviewAnswers): void {
    setAnswers(a);
    setStage("recommendation");
  }

  function handlePathChosen(path: PathId): void {
    setChosenPath(path);
    setStage("path-flow");
  }

  // R5's CGNAT routing (ProofStage.tsx, Lane U2): a failed reachability
  // proof classified as CGNAT offers switching to Tunnel straight from the
  // proof stage — restarts path-flow with "tunnel" as the chosen path,
  // same shape as handlePathChosen (a fresh flow, not a resume: Tunnel's
  // own steps have never been visited in this wizard run).
  function handleSwitchToTunnel(): void {
    setChosenPath("tunnel");
    setStage("path-flow");
  }

  return (
    <div className={styles.wizard}>
      <div className={styles.header}>
        <StageStepper current={stage} />
        <Button type="button" variant="ghost" className={styles.cancelButton} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className={styles.body}>
        {stage === "interview" && <InterviewStage onComplete={handleInterviewComplete} />}

        {stage === "recommendation" && answers && (
          <RecommendationStage answers={answers} onChoose={handlePathChosen} onBack={() => setStage("interview")} />
        )}

        {stage === "path-flow" && chosenPath && (
          <PathFlowStage
            path={chosenPath}
            initialStep={initialStep ?? undefined}
            onComplete={() => setStage("proof")}
            onExit={() => setStage(answers ? "recommendation" : "interview")}
          />
        )}

        {stage === "proof" && chosenPath && (
          <ProofStage
            path={chosenPath}
            onComplete={() => setStage("posture-handoff")}
            onBack={() => setStage("path-flow")}
            onSwitchToTunnel={handleSwitchToTunnel}
          />
        )}

        {stage === "posture-handoff" && chosenPath && <PostureHandoffStage path={chosenPath} onFinish={onFinished} />}
      </div>
    </div>
  );
}
