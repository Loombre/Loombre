// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PathFlowStepSlot.tsx
//
// THE SEAM U1 BUILT, U2 LANDS ON (STATE.md "Batch plan": "U2 lands the real
// per-path screens"). Every PathFlowStepId (packages/shared's wizard-
// state.ts PATH_FLOW_STEPS, FROZEN/law) maps to exactly one React
// component in PATH_FLOW_STEP_BODIES below; PathFlowStage.tsx never
// switches on the step id itself — it always renders
// PATH_FLOW_STEP_BODIES[step]. TypeScript's `Record<PathFlowStepId, ...>`
// makes the map exhaustive by construction — a future step id added to the
// frozen module is a compile error here until this file is updated, so a
// step can never silently fall through to nothing.
//
// U2 (this lane, mission items 2-4): every entry below is now a real
// screen — own file per step body (RemoteEnableStepBody.tsx,
// RemoteEnrollStepBody.tsx, TunnelTokenStepBody.tsx,
// TunnelEnableStepBody.tsx, DirectAcmeTestStepBody.tsx,
// DirectEnableStepBody.tsx, DirectRouterInstructionsStepBody.tsx — each
// with its own tests). "direct-mode" keeps U1's own DirectModeChoiceBody
// unchanged (R5's one real branch point — acme vs. reverse-proxy — already
// landed real, no network call needed there).
//
// PathFlowStepBodyProps/PathFlowStepBody moved OUT to
// path-flow-step-types.ts (U2): depcruise's no-circular rule caught the
// cycle the moment this file started importing real step-body components
// that themselves needed those types FROM here — see that file's own
// header for the full reasoning. Re-exported below so every existing
// import site (`from "./PathFlowStepSlot.js"`) keeps working unchanged.

import type { PathFlowStepId } from "@loombre/shared/remote";
import { Button } from "../../ui/Button.js";
import type { PathFlowStepBody, PathFlowStepBodyProps } from "./path-flow-step-types.js";
import { RemoteEnableStepBody } from "./RemoteEnableStepBody.js";
import { RemoteEnrollStepBody } from "./RemoteEnrollStepBody.js";
import { TunnelTokenStepBody } from "./TunnelTokenStepBody.js";
import { TunnelEnableStepBody } from "./TunnelEnableStepBody.js";
import { DirectAcmeTestStepBody } from "./DirectAcmeTestStepBody.js";
import { DirectEnableStepBody } from "./DirectEnableStepBody.js";
import { DirectRouterInstructionsStepBody } from "./DirectRouterInstructionsStepBody.js";
import styles from "./PathFlowStepSlot.module.css";

export type { PathFlowStepBody, PathFlowStepBodyProps } from "./path-flow-step-types.js";

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
  "remote-enable": RemoteEnableStepBody,
  "remote-enroll-first-device": RemoteEnrollStepBody,
  "tunnel-token": TunnelTokenStepBody,
  "tunnel-enable": TunnelEnableStepBody,
  "direct-mode": DirectModeChoiceBody,
  "direct-acme-test": DirectAcmeTestStepBody,
  "direct-enable": DirectEnableStepBody,
  "direct-router-instructions": DirectRouterInstructionsStepBody,
};
