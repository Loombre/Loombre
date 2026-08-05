// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/active-path-reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15: "at most one of remote/tunnel/
// direct can be enabled at a time, enforced by each path's staged enable
// flow returning 409 against another active path").
//
// CROSS-LANE SEAM (T1 adjudication, flagged): each path's own "enabled"
// state lives in that path's OWN table/settings — remote_wireguard_state
// (migrations/0029, WG1's reservation, STATE.md DRIFT DECISION #2) for
// WireGuard, remote_tunnel_state (migrations/0032, this lane) for Tunnel,
// and (per RG12) the existing tls.* settings-registry keys for Direct —
// but WG1/T1/P1/S1/D1/U1 are SIBLING Batch-1 worktrees off the SAME base
// commit (STATE.md "Batch plan"), so none of them can see another lane's
// table at dispatch time. There is no single canonical cross-subsystem
// query any one lane can honestly author today.
//
// Resolution, mirroring the ALREADY-ESTABLISHED ConnectorManager/
// ConnectorHealthReader seam (STATE.md "Cross-lane seams (orchestrator-
// set)"): an INJECTABLE interface + a no-op default that this lane wires
// into RemoteTunnelController's own 409 check (`packages/contract/
// openapi.yaml`'s `enableRemoteTunnel` 409: "A different remote-access path
// is already active..."). The no-op always reports 'none' — so in
// isolation this lane can only ever truly enforce its OWN subsystem's
// self-conflict (tunnel already enabled, checked separately against
// remote_tunnel_state itself, see remote-tunnel.service.ts). Integration
// replaces this binding with a real implementation that queries
// remote_wireguard_state.enabled and Direct's own active signal once both
// exist in the assembled tree — exactly like T2 replacing
// NoopConnectorManager. Placed at the apps/server/src/remote/ level (not
// under tunnel/) because it is inherently cross-path — WG1's and D1's own
// enable flows need the identical seam for their own 409 checks, not just
// this lane's.
//
// An ABSTRACT CLASS, not a Symbol/@Inject token: this codebase's existing
// NestJS providers are all plain injectable classes (no @Inject/token
// precedent anywhere in apps/server) — an abstract class is itself a valid
// Nest DI token via plain constructor injection, so this stays consistent
// with house style while still being swappable (`{ provide:
// RemoteActivePathReader, useClass: ... }`, remote.module.ts).

import { Injectable } from "@nestjs/common";

export type RemotePathId = "none" | "remote" | "tunnel" | "direct";

export abstract class RemoteActivePathReader {
  /** The currently DERIVED active path across ALL THREE remote-access
   *  subsystems (RG15) — a caller enabling path X compares this against
   *  'none' and X itself; anything else is a conflict. */
  abstract activePath(): Promise<RemotePathId>;
}

/**
 * The no-op default this lane registers (remote.module.ts). Exposes a
 * mutable `activePathOverride` field purely for tests (mirrors
 * ServerPowerService.arm()'s own test-injection shape) — production code
 * never sets it; only integration's REAL replacement binding is ever wired
 * into a booted server.
 */
@Injectable()
export class NoopRemoteActivePathReader implements RemoteActivePathReader {
  /** Test-only seam — see this class's own doc comment. */
  activePathOverride: RemotePathId = "none";

  async activePath(): Promise<RemotePathId> {
    return this.activePathOverride;
  }
}
