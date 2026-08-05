// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/connector-manager.ts
//
// STATE.md R4/RG7: the supervised-cloudflared-child seam. T1 (this lane)
// owns the API/provider/token layer and defines this interface; T2 (a
// LATER Batch-2 lane, per STATE.md's Batch plan) owns the REAL
// implementation — the actual child-process supervision (EmbeddedPostgres
// supervisor class shape + spawnFfmpegRun handle semantics: SIGTERM ->
// timeout -> SIGKILL, stderr ring buffer, injectable spawnFn +
// computeBackoffMs full-jitter backoff, RG7). This file registers ONLY the
// no-op default (remote.module.ts) so remote-tunnel.service.ts has a real,
// working DI token to depend on today; T2 replaces the `useClass` binding
// with its real supervisor, changing nothing at any call site (STATE.md
// "Cross-lane seams (orchestrator-set): ConnectorManager/
// ConnectorHealthReader are INTERFACES defined by T1/P1 with no-op
// defaults; T2 (batch 2) provides the real implementation — integration
// wires it").
//
// An ABSTRACT CLASS, not a Symbol/@Inject token — see active-path-reader.ts's
// header for why.

import { Injectable } from "@nestjs/common";

/**
 * T1's OWN vocabulary (mission brief) — deliberately DIFFERENT from
 * packages/contract/openapi.yaml's frozen RemoteTunnelStatus.connectorState
 * enum (`stopped|starting|running|degraded|error`, Wave-0 frozen shape,
 * RG15). remote-tunnel.service.ts's own `mapConnectorStateToContract`
 * translates between the two — see that file's header for the exact
 * mapping and why a translation layer, not a shared enum, was the right
 * call here (this vocabulary also has to describe RG7's backoff state,
 * which the contract enum folds into 'degraded').
 */
export type ConnectorState = "stopped" | "starting" | "healthy" | "unhealthy" | "backoff";

export interface ConnectorHealth {
  state: ConnectorState;
  lastError: string | null;
  restartCount: number;
  /** ms timestamp this `state` was entered — NOT "since the connector was
   *  first started". */
  sinceMs: number;
  /** Current restart backoff (full jitter, RG7) — non-null only while
   *  `state === "backoff"`. Added beyond the mission brief's literal
   *  ConnectorManager.health() shape because packages/contract/openapi.
   *  yaml's frozen RemoteTunnelStatus.backoffMs is REQUIRED and RG7
   *  explicitly calls out full-jitter backoff as a real state T2's
   *  implementation must report — see remote-tunnel.service.ts's header
   *  for the full writeup. */
  backoffMs: number | null;
}

export interface ConnectorStartConfig {
  tunnelId: string;
  hostname: string;
  /** The opaque Cloudflare connector run credential (TunnelProvider.
   *  provisionTunnel's connectorCredentials) — passed through untouched;
   *  T2's real implementation hands this to `cloudflared tunnel run
   *  --token <credential>`. NEVER logged (R9) — a real implementation must
   *  keep this out of its own stderr ring buffer / logsTail() output too. */
  credential: string;
}

export abstract class ConnectorManager {
  abstract start(config: ConnectorStartConfig): Promise<void>;
  abstract stop(): Promise<void>;
  abstract health(): ConnectorHealth;
  /** Bounded tail of the connector's stderr ring buffer (RG7) — backs GET
   *  /admin/remote/tunnel/logs, `lines` query param 1-500 default 200
   *  (packages/contract/openapi.yaml). Newest-last, same convention a
   *  ring-buffer tail normally reads. */
  abstract logsTail(limit: number): string[];
}

/**
 * The registered default (remote.module.ts) until T2 lands. `start`/`stop`
 * record what they were called with (test-only fields, same shape as
 * ServerPowerService.arm()'s FakeTriggers convention in server-power.e2e.
 * spec.ts) but do nothing real — health() always reports 'stopped', logs
 * are always empty, exactly matching this lane's mission ("a registered
 * NoopConnectorManager default (health 'stopped', empty logs)").
 */
@Injectable()
export class NoopConnectorManager implements ConnectorManager {
  private startedWith: ConnectorStartConfig | null = null;
  private startCalls = 0;
  private stopCalls = 0;
  private logsTailCalls: number[] = [];

  async start(config: ConnectorStartConfig): Promise<void> {
    this.startedWith = config;
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.startedWith = null;
    this.stopCalls += 1;
  }

  health(): ConnectorHealth {
    return { state: "stopped", lastError: null, restartCount: 0, sinceMs: 0, backoffMs: null };
  }

  logsTail(limit: number): string[] {
    this.logsTailCalls.push(limit);
    return [];
  }

  /** Test-only introspection — see this class's own doc comment. */
  getTestState(): { startedWith: ConnectorStartConfig | null; startCalls: number; stopCalls: number; logsTailCalls: number[] } {
    return { startedWith: this.startedWith, startCalls: this.startCalls, stopCalls: this.stopCalls, logsTailCalls: this.logsTailCalls };
  }
}
