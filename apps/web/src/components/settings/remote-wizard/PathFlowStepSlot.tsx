// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PathFlowStepSlot.tsx
//
// THE SEAM U2 BUILDS AGAINST (STATE.md "Batch plan": "U2 lands the real
// per-path screens" — this lane's mission item 2 explicitly scopes
// PathFlowStage to a SHELL, "make the step-slot API clean for U2"). Every
// PathFlowStepId (packages/shared's wizard-state.ts PATH_FLOW_STEPS,
// FROZEN/law) maps to exactly one React component in PATH_FLOW_STEP_BODIES
// below; PathFlowStage.tsx never switches on the step id itself — it always
// renders PATH_FLOW_STEP_BODIES[step]. Landing a path's real screen is
// therefore a ONE-LINE change per step: replace that step's map entry with
// the real component. TypeScript's `Record<PathFlowStepId, ...>` makes the
// map exhaustive by construction — a future step id added to the frozen
// module is a compile error here until this file is updated, so a step can
// never silently fall through to nothing.
//
// The one exception: "direct-mode" (R5's one real branch point — acme vs.
// reverse-proxy) gets a light real chooser, DirectModeChoiceBody, rather
// than the generic placeholder — see its own comment below for why this
// stays within "shell, no API calls" while still exercising
// nextPathFlowStep's branch for real (a step is a placeholder because it
// doesn't call the real API yet, not because every UI decision it makes has
// to be fake too).

import type { PathFlowContext, PathFlowStepId, PathId } from "@loombre/shared/remote";
import { Button } from "../../ui/Button.js";
import styles from "./PathFlowStepSlot.module.css";

/** Props every step-body component receives — the same shape for today's
 *  placeholders and for whatever U2 substitutes. A step body that needs
 *  data beyond `path`/`step`/`context` (e.g. Direct's real acme-test call)
 *  owns that fetch itself, the same way every other Settings card in this
 *  codebase does — this slot only carries wizard-navigation plumbing. */
export interface PathFlowStepBodyProps {
  path: PathId;
  step: PathFlowStepId;
  /** Accumulated answers from earlier steps in THIS path-flow run (today
   *  only `directMode`, Direct's one branch point). */
  context: PathFlowContext;
  /** Advances to the next step (or leaves path-flow entirely once the
   *  path's last step completes — PathFlowStage owns that transition via
   *  the frozen nextPathFlowStep). Pass a context patch when the step
   *  collected something later steps (or nextPathFlowStep's own branch,
   *  e.g. Direct's mode choice) need to see. */
  onStepComplete: (contextPatch?: Partial<PathFlowContext>) => void;
  /** Always supplied by PathFlowStage today — even on a path's first step,
   *  where calling it exits path-flow entirely (back to recommendation, or
   *  interview if there was no interview run). Declared optional so a
   *  future embedding with no "leave path-flow" affordance can omit it. */
  onBack?: () => void;
}

export type PathFlowStepBody = (props: PathFlowStepBodyProps) => React.JSX.Element;

export const PATH_FLOW_STEP_LABELS: Record<PathFlowStepId, string> = {
  "remote-enable": "Enable Loombre Remote",
  "remote-enroll-first-device": "Enroll your first device",
  "tunnel-token": "Connect your Cloudflare account",
  "tunnel-enable": "Enable the Tunnel",
  "direct-mode": "Choose how Direct is set up",
  "direct-acme-test": "Test certificate issuance",
  "direct-enable": "Enable Direct access",
  "direct-router-instructions": "Forward a port on your router",
};

function StepFrame({
  title,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
}: {
  title: string;
  children: React.ReactNode;
  onBack?: (() => void) | undefined;
  onNext: () => void;
  nextLabel?: string;
}): React.JSX.Element {
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>{title}</p>
      {children}
      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

/** The default: every step except "direct-mode" (see header) renders this —
 *  honest placeholder copy, no fabricated progress or fake data, real
 *  Back/Continue navigation through the frozen step sequence. */
function PlaceholderStepBody({ step, onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  return (
    <StepFrame title={PATH_FLOW_STEP_LABELS[step]} onBack={onBack} onNext={() => onStepComplete()}>
      <p className={styles.placeholderBody}>
        This step's real screen isn't built in this preview yet — it lands in a follow-up pass. The controls below
        keep the wizard's step sequence real so you can see how the rest of the flow fits together.
      </p>
    </StepFrame>
  );
}

/** R5's one real branch point: acme (Loombre issues the certificate) vs.
 *  reverse-proxy (an existing proxy already terminates TLS). No network
 *  call here (still a shell) — but the CHOICE itself is real, because it's
 *  what lets nextPathFlowStep's reverse-proxy skip (module header:
 *  "reverse-proxy mode has nothing to test, so it skips 'direct-acme-test'
 *  entirely") actually be exercised by this UI instead of only by its unit
 *  tests. */
function DirectModeChoiceBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  return (
    <StepFrame title={PATH_FLOW_STEP_LABELS["direct-mode"]} onBack={onBack} onNext={() => onStepComplete({ directMode: "acme" })}>
      <p className={styles.placeholderBody}>Does Loombre issue the certificate itself, or does something else already handle TLS for you?</p>
      <div className={styles.choiceRow}>
        <Button type="button" variant="secondary" onClick={() => onStepComplete({ directMode: "acme" })}>
          Loombre issues it automatically
        </Button>
        <Button type="button" variant="secondary" onClick={() => onStepComplete({ directMode: "reverse-proxy" })}>
          I already have a reverse proxy
        </Button>
      </div>
    </StepFrame>
  );
}

/** THE SEAM. Every PathFlowStepId must have an entry (see header). */
export const PATH_FLOW_STEP_BODIES: Record<PathFlowStepId, PathFlowStepBody> = {
  "remote-enable": PlaceholderStepBody,
  "remote-enroll-first-device": PlaceholderStepBody,
  "tunnel-token": PlaceholderStepBody,
  "tunnel-enable": PlaceholderStepBody,
  "direct-mode": DirectModeChoiceBody,
  "direct-acme-test": PlaceholderStepBody,
  "direct-enable": PlaceholderStepBody,
  "direct-router-instructions": PlaceholderStepBody,
};
