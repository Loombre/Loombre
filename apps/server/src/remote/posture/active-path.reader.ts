// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/active-path.reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7/RG15, S1 lane).
//
// ADJUDICATION BEYOND R/RG LAW (flagged in this lane's report): R7's card
// needs to know the active path to pick which checks apply
// (posture-model.ts's applicableChecks). RG15's law is that activePath is
// DERIVED from the three subsystems' own enabled state, never stored — but
// deriving it for real means reading WG1's/T1's/the Direct-enable flow's
// persisted "am I enabled" state, and NONE of that exists on this branch:
// GET /admin/remote/state (RemoteStateController, the "wizard re-entry
// read" RG15 names as the derivation's natural home) is still a 501 shell
// here, WG1's remote_wireguard_state table (migration 0029) hasn't landed
// on this branch, and neither has any Tunnel/Direct enabled-state.
//
// So today, on THIS branch, the truthful answer to "which path is active"
// is unconditionally 'none' — not because this reader is faking anything,
// but because literally no path CAN be turned on yet anywhere in this
// codebase state (every enable endpoint besides the ones S1 itself touches
// is still 501). Treating that as a real, swappable seam (same pattern as
// ConnectorHealthReaderService/WireguardStatusReaderService) rather than
// hardcoding 'none' inline in RemotePostureService means integration (or
// whichever lane lands the real GET /admin/remote/state) only has to
// replace THIS class's one method — ideally by extracting ONE canonical
// resolveActivePath() helper that RemoteStateController and this reader
// both call, so the derivation can never drift between the wizard's
// re-entry read and the posture card. That extraction is left to
// integration; this lane does not touch RemoteStateController.

import { Injectable } from "@nestjs/common";
import type { PostureActivePath } from "@loombre/shared";

@Injectable()
export class RemoteActivePathReaderService {
  async read(): Promise<PostureActivePath> {
    return "none";
  }
}
