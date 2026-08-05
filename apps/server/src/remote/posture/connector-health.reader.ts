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
// T2 (lane T2, batch 2, RG7): reads through T1's `ConnectorManager` token
// (../tunnel/connector-manager.js), now that it exists on this integrated
// tree, instead of hardcoding "unknown" — the seam-unification integration
// note this file's header used to point at as future work. Public API
// (class name/constructor-DI-token identity, `read()`'s signature)
// UNCHANGED, so RemotePostureService's own constructor signature (and its
// unit test's `fakeReader` structural-typing convention,
// remote-posture.service.spec.ts) needed no changes.
//
// Reuses remote-tunnel.service.ts's OWN `mapConnectorStateToContract` —
// that function's output type (`stopped|starting|running|degraded|error`)
// is EXACTLY this file's `ConnectorHealthState` minus `"unknown"`, which a
// live ConnectorManager never actually produces (T1's ConnectorState union
// has no "unknown" member — see that file), so no cast/adaptation is
// needed beyond TypeScript's own narrower-union-into-wider-union subtyping.
// "unknown" remains reachable in THIS class's return type only for a
// hypothetical future ConnectorManager implementation that can't determine
// its own state — gradeConnectorHealth("unknown") -> warn, never a faked
// pass, exactly as this file's default used to document for its OWN
// unconditional "unknown".

import { Injectable } from "@nestjs/common";
import { ConnectorManager } from "../tunnel/connector-manager.js";
import { mapConnectorStateToContract } from "../tunnel/remote-tunnel.service.js";
import type { ConnectorHealthState } from "./checks/connector-health.js";

@Injectable()
export class ConnectorHealthReaderService {
  constructor(private readonly connectorManager: ConnectorManager) {}

  async read(): Promise<ConnectorHealthState> {
    return mapConnectorStateToContract(this.connectorManager.health().state);
  }
}
