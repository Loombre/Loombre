// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/wireguard-status.reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 wgPortSilence, S1 lane; WIRED at
// integration per V-SEC finding F1).
//
// CROSS-LANE SEAM: S1 authored this against a base without WG1's listener,
// so it originally returned "unknown" (undefined) unconditionally. WG1 has
// since landed RemoteWireguardService, whose status() reports the real
// persisted-intent (`enabled`) + live-listener (`listening`) truth — this
// reader now delegates to it, exactly as the original header said
// integration would. A genuine failure to read (native lib absent, DB
// unreachable) still collapses to undefined → gradeWgPortSilence returns
// `warn`, never a faked pass and never a faked healthy `info`: the honest
// "could not confirm" posture is preserved for the error path only, while
// the real enabled/listening states now drive the grade.

import { Injectable } from "@nestjs/common";
import { RemoteWireguardService } from "../wireguard/remote-wireguard.service.js";
import type { WireguardStatusSnapshot } from "./checks/wg-port-silence.js";

@Injectable()
export class WireguardStatusReaderService {
  constructor(private readonly wireguard: RemoteWireguardService) {}

  async read(): Promise<WireguardStatusSnapshot> {
    try {
      const status = await this.wireguard.status();
      return { enabled: status.enabled, listening: status.listening };
    } catch {
      // Honest "unknown" — never fabricate an enabled/listening pair we
      // could not actually observe (gradeWgPortSilence(undefined) → warn).
      return undefined;
    }
  }
}
