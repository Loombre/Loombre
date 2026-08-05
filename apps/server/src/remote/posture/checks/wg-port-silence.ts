// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/wg-port-silence.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 wgPortSilence, S1 lane). Pure
// grading function; the impure "read the listener's live state" half is
// ../wireguard-status.reader.ts's WireguardStatusReaderService (a narrow
// seam — WG1 wires the real read; see that file's header).
//
// R7's OWN wording: "WG port silence (Remote: the card explains scanners
// see nothing)". This is a STRUCTURAL fact, not a probe result: WireGuard
// is silent-by-protocol to any packet that isn't a valid handshake
// initiation (RG9's own security law — verified by WG1's own containment
// test suite, not this check), which means NO vantage point inside the
// server process can ever distinguish "listening and correctly silent"
// from "not listening at all" from the outside. Loombre cannot probe
// itself externally.
//
// THE DELIBERATE DESIGN: this check can therefore NEVER return `pass` —
// there is no state in which S1 is entitled to say "confirmed secure from
// outside". Grades:
//   - `warn`  — status genuinely unknown (reader not wired yet, or a read
//     failure) — cannot even confirm the listener's OWN internal state.
//   - `fail`  — status IS known, and the listener is NOT bound despite
//     being enabled — a real, internally-verifiable problem (enrolled
//     devices literally cannot connect), not an external-exposure claim.
//   - `info`  — status IS known and the listener IS bound — the honest
//     ceiling: "as far as Loombre itself can tell, it's up; whether it
//     LOOKS silent from outside is unverifiable from here — use the
//     reachability proof or an external port scanner."
// NEVER FAKE A PASS (R9/V-SEC's own hunting brief) — this check is the
// canonical example of that rule; a reviewer should find it structurally
// impossible for this function to emit `pass`, not merely unlikely to.

import type { PostureCheckOutcome } from "./types.js";

/** undefined = status genuinely unknown (the reader could not observe it —
 *  see this file's header). Defined = a real read of the listener state. */
export type WireguardStatusSnapshot = { enabled: boolean; listening: boolean } | undefined;

export function gradeWgPortSilence(status: WireguardStatusSnapshot): PostureCheckOutcome {
  if (status === undefined) {
    return {
      grade: "warn",
      detail: "The WireGuard listener's status could not be read — this check cannot confirm anything about it right now.",
    };
  }

  if (!status.listening) {
    return {
      grade: "fail",
      detail: "Loombre Remote is enabled but its WireGuard listener is not currently bound — enrolled devices cannot connect.",
    };
  }

  return {
    grade: "info",
    detail:
      "The WireGuard listener is bound. Loombre cannot verify from outside that unsolicited packets receive no reply — by design, a server can never probe its own external exposure. WireGuard is silent-by-protocol to invalid packets; use the reachability proof or an independent external port scan to confirm.",
  };
}
