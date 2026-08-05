// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteEnrollStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R2/R3, Lane U2's mission item 2) — the
// wizard's own path-flow step slot for the QR CEREMONY (pick a user +
// device name -> POST /admin/remote/wireguard/devices -> the ONE-TIME
// provisioning payload -> confirm). This is packages/shared/src/remote/
// wizard-state.ts's LAST step of PATH_FLOW_STEPS.remote — completing it
// advances the wizard straight to the "proof" stage (R6).
//
// WG3 (STATE.md mission item 2, "POST-WIZARD ENROLLMENT ENTRY POINT"):
// the ceremony itself moved to RemoteEnrollCeremony.tsx so
// RemoteDevicesPanel.tsx's own "Enroll a device" admin action can open the
// SAME ceremony without duplicating it — this file is now a thin adapter
// from PathFlowStepBodyProps' wizard-navigation shape (onStepComplete/
// onBack) onto RemoteEnrollCeremony's generic onDone/onCancel, registered
// unchanged in PathFlowStepSlot.tsx's PATH_FLOW_STEP_BODIES. See that
// file's own header for the MEMORY-ONLY discipline (still enforced —
// nothing here or in RemoteEnrollCeremony persists configText anywhere but
// React state) and RemoteEnrollStepBody.test.tsx for the coverage, kept
// exercising this exact wrapper end to end.

import { RemoteEnrollCeremony } from "./RemoteEnrollCeremony.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";

export function RemoteEnrollStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  return <RemoteEnrollCeremony onDone={() => onStepComplete()} onCancel={onBack} cancelLabel="Back" />;
}
