// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/connector-health.reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 connectorHealth, S1 lane).
//
// CROSS-LANE SEAM: the orchestrator's own dispatch note says
// "ConnectorHealthReader are INTERFACES defined by T1/P1 with no-op
// defaults; T2 provides the real implementation at integration" — but T1
// has not landed on lane/remote-base at the point this lane branched (each
// batch-1 lane works off the SAME base commit in an isolated worktree), so
// no such interface exists on this branch to reuse. Defined here instead,
// narrowly scoped to exactly what gradeConnectorHealth
// (./checks/connector-health.js) needs.
//
// A CONCRETE, @Injectable() class — NOT an interface-typed constructor
// param — on purpose: this codebase's own standing lesson (see e.g.
// auth-rate-limiter.service.ts's header, "why an INTERFACE-typed
// constructor param would silently break Nest's DI resolution") is that
// TypeScript interfaces carry no runtime type, so Nest's reflection-based
// DI cannot resolve one; a plain class with a real constructor is the
// correct injectable shape, and downstream lanes wire the real behavior by
// either replacing this class's method body or providing a subclass in
// RemoteModule's `providers` array — either way, RemotePostureService's own
// constructor signature never needs to change.
//
// This default implementation ALWAYS reports "unknown" — honest for this
// branch's actual state (no supervised cloudflared child process exists
// anywhere yet; T1/T2 own that). gradeConnectorHealth("unknown") -> warn,
// never a faked pass.

import { Injectable } from "@nestjs/common";
import type { ConnectorHealthState } from "./checks/connector-health.js";

@Injectable()
export class ConnectorHealthReaderService {
  async read(): Promise<ConnectorHealthState> {
    return "unknown";
  }
}
