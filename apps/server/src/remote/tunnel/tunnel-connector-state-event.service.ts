// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/tunnel-connector-state-event.service.ts
//
// STATE.md "Loombre Remote ..." WG3 mission item 3 ("WIRE tunnel.connector.
// state — T2's flagged gap: the frozen event schema is emitted by NO ONE").
// Ground truth: the connector's health state transition is observable
// EXACTLY where CloudflaredConnectorManager.transitionTo() already lives
// (cloudflared-connector-manager.ts) — that class now calls every
// registered ConnectorManager.onStateChange listener there, and ONLY on a
// REAL transition (previous !== next), never on a poll and never for a
// call that leaves the state unchanged (e.g. stop() on an already-stopped
// manager). This service is the ONE production listener: it subscribes
// once at boot and translates + persists every transition it's told about.
//
// Same one-shot-registration shape as remote-tunnel-boot-resumer.service.ts
// (OnApplicationBootstrap, no setInterval — this is push-driven by the
// connector itself, not a periodic sweep like remote-posture-regression.
// scheduler.ts) — registering the listener is synchronous and does no I/O,
// so unlike those two files there is no STARTUP_DELAY_MS to worry about:
// nothing fires until a REAL transition happens, and the earliest that can
// occur in production is RemoteTunnelBootResumerService's own 60s-delayed
// resume (or a later admin enable/disable), both well after this listener
// is already registered.
//
// mapConnectorStateToContract (remote-tunnel.service.ts) is the SAME
// translation getRemoteTunnelStatus's own toStatusDto already applies to
// health().state for the status read — reused here so the event payload's
// `previousState`/`newState` can never drift from what an admin sees on
// GET /admin/remote/tunnel/status at the moment of the same transition.
//
// Never throws out of the listener callback (best-effort, matching every
// other background-writer's posture in this codebase, e.g. remote-posture-
// regression.scheduler.ts's own per-tick isolation): a DB hiccup while
// writing this one admin-only audit event must never crash the connector's
// own state machine or take down the process.

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { recordTunnelConnectorStateEvent } from "@loombre/db";
import { DbProvider } from "../../common/db.provider.js";
import { ConnectorManager, type ConnectorStateChange } from "./connector-manager.js";
import { mapConnectorStateToContract } from "./remote-tunnel.service.js";

@Injectable()
export class TunnelConnectorStateEventService implements OnApplicationBootstrap {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly connectorManager: ConnectorManager,
  ) {}

  onApplicationBootstrap(): void {
    this.connectorManager.onStateChange((change) => {
      void this.emit(change);
    });
  }

  private async emit(change: ConnectorStateChange): Promise<void> {
    try {
      await recordTunnelConnectorStateEvent(this.dbProvider.db, {
        previousState: mapConnectorStateToContract(change.previousState),
        newState: mapConnectorStateToContract(change.newState),
        changedAtMs: change.changedAtMs,
      });
    } catch (err) {
      console.error(
        `tunnel-connector-state-event: failed to write a tunnel.connector.state event (${change.previousState} -> ${change.newState}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
