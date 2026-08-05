// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/wireguard-status.reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 wgPortSilence, S1 lane).
//
// CROSS-LANE SEAM, same shape and same reasoning as
// ./connector-health.reader.ts's own header: WG1 (batch 1, a sibling
// worktree off the same base commit — not merged into this branch) owns
// the real embedded-WireGuard listener and its persisted enabled/listening
// state (migrations/0029, DRIFT DECISION #2). Nothing on THIS branch can
// observe that state yet, so this default implementation honestly reports
// "unknown" (undefined) — gradeWgPortSilence(undefined) -> warn, never a
// faked pass. WG1 (or integration) wires the real read either by replacing
// this class's method body or by providing a subclass in RemoteModule's
// `providers` array.

import { Injectable } from "@nestjs/common";
import type { WireguardStatusSnapshot } from "./checks/wg-port-silence.js";

@Injectable()
export class WireguardStatusReaderService {
  async read(): Promise<WireguardStatusSnapshot> {
    return undefined;
  }
}
