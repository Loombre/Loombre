// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/settings/remote-wizard/path-flow-step-types.ts
//
// PathFlowStepBodyProps/PathFlowStepBody live here, NOT in
// PathFlowStepSlot.tsx (which originally defined them) — depcruise's
// no-circular rule (dependency-cruiser.config.cjs) caught the cycle the
// moment PathFlowStepSlot.tsx started importing real step-body components
// (this lane, U2): PathFlowStepSlot.tsx -> RemoteEnableStepBody.tsx (etc.)
// -> back to PathFlowStepSlot.tsx for the very types those components
// need. Splitting the shared TYPE surface into its own leaf module (no
// imports of its own) makes the graph one-directional: every step-body
// file imports from HERE, and PathFlowStepSlot.tsx imports both this file
// AND every step-body component, with nothing pointing back.

import type { PathFlowContext, PathFlowStepId, PathId } from "@loombre/shared/remote";

/** Props every step-body component receives — the same shape for every
 *  entry in PathFlowStepSlot.tsx's PATH_FLOW_STEP_BODIES. A step body that
 *  needs data beyond `path`/`step`/`context` (e.g. Direct's real acme-test
 *  call) owns that fetch itself, the same way every other Settings card in
 *  this codebase does — this slot only carries wizard-navigation plumbing. */
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
