// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/EnrollDeviceSheet.tsx
//
// STATE.md "Loombre Remote ..." WG3 mission item 2 ("POST-WIZARD ENROLLMENT
// ENTRY POINT"): RemoteDevicesPanel.tsx's "Enroll a device" action opens
// THIS — U2's own enrollment ceremony (RemoteEnrollCeremony.tsx, lifted out
// of RemoteEnrollStepBody.tsx for exactly this reuse), embedded in
// SheetOrModal.js, the SAME both-breakpoints primitive CreateInviteSheet.tsx
// (admin invite creation, an analogous "admin-initiated, one-time-reveal"
// flow) already uses for this exact shape.
//
// Controlled-open, same convention as every other *Sheet component in this
// codebase (open/onClose props, SheetOrModal unmounts its children on
// close — see that file's own header) — no internal "am I open" state here.
// onEnrolled fires once the ceremony's own onDone fires (the admin checked
// "I've added it to the device"), so the caller can refresh its device
// list; the sheet then closes itself via the same onClose the caller
// passed in, matching CreateInviteSheet's own "Done" -> handleClose shape.

import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { RemoteEnrollCeremony } from "./RemoteEnrollCeremony.js";

export function EnrollDeviceSheet({
  open,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  onClose: () => void;
  /** The ceremony completed (admin confirmed the device was added) —
   *  caller should refresh its device list. Called BEFORE onClose. */
  onEnrolled: () => void;
}): React.JSX.Element {
  function handleDone(): void {
    onEnrolled();
    onClose();
  }

  return (
    <SheetOrModal open={open} onClose={onClose} title="Enroll a device">
      <RemoteEnrollCeremony onDone={handleDone} onCancel={onClose} cancelLabel="Cancel" />
    </SheetOrModal>
  );
}
