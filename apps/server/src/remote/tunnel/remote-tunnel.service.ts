// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/remote-tunnel.service.ts
//
// STATE.md R4/R9/RG7/RG10/RG15: enable/disable/status/logs orchestration
// for the Tunnel path — staged validate -> commit (RG10, plugin-
// registration.service.ts's own registerPlugin shape: validate -> external
// side effects -> ONE atomic state-plus-events write at the very end,
// never the other way around).
//
// DRIFT DECISION (T1, flagged): packages/contract/openapi.yaml's Wave-0
// frozen `RemoteTunnelStatus` schema (required: [enabled, connectorState,
// hostname, backoffMs, lastErrorMessage]) has NO field for token status —
// but this lane's mission explicitly requires "the token portion of
// getRemoteTunnelStatus ({configured, setAtMs, scopesOk})", and no OTHER
// operation in the frozen 6-op Tunnel surface can carry it either
// (`setRemoteTunnelToken`'s 200 is an ephemeral validation-at-write-time
// response, not an ongoing status read). Resolution: an ADDITIVE contract
// edit — three new REQUIRED properties on RemoteTunnelStatus
// (`tokenConfigured`/`tokenSetAtMs`/`tokenScopesOk`) — landed in THIS
// lane's own commit alongside the regenerated+rebuilt SDK, mirroring
// exactly how S1 was authorized to add a whole new operation
// (getRemotePosture) at this same freeze. Adding new properties to a
// RESPONSE-only object schema is additive (existing consumers ignore
// unknown fields; oasdiff's own additive-vs-breaking classification agrees
// — verified at this lane's own gate run). RemoteTunnelController is the
// ONLY controller that returns this schema, so no other Batch-1 lane's
// work can conflict with this edit.
//
// SECOND DRIFT (T1, flagged): the mission's own ConnectorManager.health()
// shape ({state, lastError, restartCount, sinceMs}) has no `backoffMs`
// field, but RemoteTunnelStatus.backoffMs is REQUIRED by the Wave-0 frozen
// contract and RG7 explicitly calls out full-jitter backoff as a real
// connector state T2's implementation must report. Since T1 (this lane) is
// the one authoring/freezing the ConnectorManager seam for T2 to later
// implement against (mission: "you own... and define the seam"),
// `ConnectorHealth` gained one field beyond the mission's literal text:
// `backoffMs: number | null` — see connector-manager.ts. Left for a
// PRE-EXISTING gap to surface at T2 rather than closing it now would have
// meant T2 either breaking this interface or duplicating a backoff-ms
// concept outside it; closing it here costs nothing (NoopConnectorManager
// always reports `null`) and keeps the seam genuinely complete.
//
// `connectorState` translation: packages/contract/openapi.yaml's frozen
// enum (`stopped|starting|running|degraded|error`) is DELIBERATELY
// different vocabulary from ConnectorManager.health()'s own
// (`stopped|starting|healthy|unhealthy|backoff`, the mission brief's exact
// wording) — mapConnectorStateToContract below is the one-way translation,
// never a shared enum, because the contract's vocabulary reads naturally
// to an admin ("running", "degraded") while the connector's own internal
// vocabulary needs to distinguish 'backoff' (mid-restart-wait) from a
// generic 'unhealthy' (the health check itself is failing) — two different
// facts an admin-facing status field collapses to one 'degraded'/'error'
// pair on purpose.

import { Injectable } from "@nestjs/common";
import { detectSecretBackend, removeSecret, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import {
  disableTunnelStateAndEmit,
  enableTunnelStateAndEmit,
  getRemoteTunnelState,
  type RemoteTunnelStateRow,
} from "@loombre/db";
import { DbProvider } from "../../common/db.provider.js";
import { requireLiveAdmin } from "../../common/require-live-admin.js";
import { resolveAppPaths } from "../../cli/app-paths.js";
import { conflict, unprocessableEntity } from "../../gateway/problem.exception.js";
import { RemoteActivePathReader } from "../active-path-reader.js";
import { ConnectorManager, type ConnectorState } from "./connector-manager.js";
import { TunnelProvider, TunnelProviderError, type DnsRouteResult, type ProvisionTunnelResult } from "./tunnel-provider.js";
import { TunnelTokenService } from "./tunnel-token.service.js";

export type RemoteTunnelConnectorContractState = "stopped" | "starting" | "running" | "degraded" | "error";

export interface RemoteTunnelStatusDto {
  enabled: boolean;
  connectorState: RemoteTunnelConnectorContractState;
  hostname: string | null;
  backoffMs: number | null;
  lastErrorMessage: string | null;
  /** T1's additive extension — see this file's header DRIFT DECISION. */
  tokenConfigured: boolean;
  tokenSetAtMs: number | null;
  tokenScopesOk: boolean | null;
}

export function mapConnectorStateToContract(state: ConnectorState): RemoteTunnelConnectorContractState {
  switch (state) {
    case "stopped":
      return "stopped";
    case "starting":
      return "starting";
    case "healthy":
      return "running";
    case "unhealthy":
      return "error";
    case "backoff":
      return "degraded";
  }
}

@Injectable()
export class RemoteTunnelService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly provider: TunnelProvider,
    private readonly tokenService: TunnelTokenService,
    private readonly connectorManager: ConnectorManager,
    private readonly activePathReader: RemoteActivePathReader,
  ) {}

  private connectorCredentialsSecretKey(): string {
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return `${dataDir}/secrets/remote-tunnel-connector-credentials`;
  }

  private async resolveBackend(): Promise<SecretBackend> {
    const detected = await detectSecretBackend();
    return detected.backend;
  }

  private async storeConnectorCredentials(value: string): Promise<void> {
    const backend = await this.resolveBackend();
    await storeSecret(backend, this.connectorCredentialsSecretKey(), value);
  }

  private async clearConnectorCredentials(): Promise<void> {
    const backend = await this.resolveBackend();
    await removeSecret({ backend, key: this.connectorCredentialsSecretKey() });
  }

  /** Mirrors tunnel-token.service.ts's own resolveStoredToken (same "raw
   *  keyring read, never exposed on any DTO" posture) — used ONLY by
   *  resumeConnectorIfEnabled() below (server boot / remote-tunnel-boot-
   *  resumer.service.ts, T2). */
  private async resolveStoredConnectorCredentials(): Promise<string | null> {
    const backend = await this.resolveBackend();
    return tryResolveSecret({ backend, key: this.connectorCredentialsSecretKey() });
  }

  /**
   * T2/RG7 "server resumes the connector on boot if the tunnel state row
   * says enabled" — mirrors HOW this service persists state (the same
   * singleton remote_tunnel_state row enableRemoteTunnel/disableRemoteTunnel
   * read/write) rather than inventing a second source of truth.
   * Best-effort and NEVER throws: a boot-time resume failure (keyring
   * unavailable, credential missing) must not crash server startup — it is
   * logged and the connector simply stays 'stopped'/'backoff' until an
   * admin notices via the posture card or the tunnel status endpoint and
   * intervenes (disable+re-enable). Called from
   * remote-tunnel-boot-resumer.service.ts's own OnApplicationBootstrap
   * timer, never directly from main.ts (that timer's startup-delay is what
   * keeps this from firing real process spawns during the test suite).
   */
  async resumeConnectorIfEnabled(): Promise<void> {
    try {
      const row = await getRemoteTunnelState(this.dbProvider.db);
      if (!row.enabled || row.tunnel_id === null || row.hostname === null) return;

      const credential = await this.resolveStoredConnectorCredentials();
      if (credential === null) {
        console.error(
          "remote-tunnel-boot-resumer: the Tunnel path is enabled but no connector credential is stored in the keyring — cannot resume the connector. An admin must disable and re-enable the Tunnel path.",
        );
        return;
      }

      await this.connectorManager.start({ tunnelId: row.tunnel_id, hostname: row.hostname, credential });
    } catch (err) {
      console.error(`remote-tunnel-boot-resumer: failed to resume the connector on boot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Never echoes the raw provider error's message assumption — TunnelProviderError's
   *  `detail` is already safe to surface (see tunnel-provider.ts's own doc
   *  comment: never echoes the token, never echoes an upstream response
   *  body verbatim beyond a status code). */
  private describeProviderError(err: unknown, action: string): string {
    if (err instanceof TunnelProviderError) return `Failed to ${action}: ${err.detail}`;
    return `Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`;
  }

  private async toStatusDto(row: RemoteTunnelStateRow): Promise<RemoteTunnelStatusDto> {
    const health = this.connectorManager.health();
    const tokenStatus = await this.tokenService.status();
    return {
      enabled: row.enabled,
      connectorState: mapConnectorStateToContract(health.state),
      hostname: row.hostname,
      backoffMs: health.backoffMs,
      lastErrorMessage: health.lastError,
      tokenConfigured: tokenStatus.configured,
      tokenSetAtMs: tokenStatus.setAtMs,
      tokenScopesOk: tokenStatus.scopesOk,
    };
  }

  async getRemoteTunnelStatus(): Promise<RemoteTunnelStatusDto> {
    const row = await getRemoteTunnelState(this.dbProvider.db);
    return this.toStatusDto(row);
  }

  getRemoteTunnelLogs(limit: number): { lines: string[] } {
    return { lines: this.connectorManager.logsTail(limit) };
  }

  /**
   * Staged validate -> commit (RG10): every precondition (409s) checked
   * BEFORE any external side effect; every external side effect (provider
   * calls, keyring write, ConnectorManager.start) BEFORE the one atomic
   * DB-state-plus-events write. A failure partway through a provider call
   * throws 422 with NOTHING persisted yet — remote_tunnel_state stays
   * enabled=false, so a retried enable starts clean (no partial state to
   * reconcile).
   */
  async enableRemoteTunnel(input: { hostname: string; actorUserId: string; nowMs?: number; instancePath?: string }): Promise<RemoteTunnelStatusDto> {
    const nowMs = input.nowMs ?? Date.now();
    const instancePath = input.instancePath ?? "/admin/remote/tunnel/enable";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const hostname = input.hostname.trim();
    if (hostname.length === 0) {
      throw unprocessableEntity("hostname must not be empty.", instancePath);
    }

    // RG15: 409 against a DIFFERENT active path. The real cross-subsystem
    // check is a Batch-1 seam this lane cannot fully wire alone — see
    // active-path-reader.ts's own header.
    const otherPath = await this.activePathReader.activePath();
    if (otherPath !== "none" && otherPath !== "tunnel") {
      throw conflict(`The ${otherPath} path is already active — disable it before enabling the Tunnel path.`, instancePath);
    }

    const current = await getRemoteTunnelState(this.dbProvider.db);
    if (current.enabled) {
      throw conflict("The Tunnel path is already enabled — disable it first to change the hostname.", instancePath);
    }

    const token = await this.tokenService.resolveStoredToken();
    if (!token) {
      throw conflict("No Cloudflare API token is stored — set one first (POST /admin/remote/tunnel/token).", instancePath);
    }

    const validation = await this.provider.validateToken(token);
    if (!validation.valid || !validation.accountId) {
      throw conflict(`The stored Cloudflare API token is no longer valid: ${validation.detail ?? "unknown reason"}`, instancePath);
    }
    const accountId = validation.accountId;

    const localPort = process.env["PORT"] ?? "3001";
    const localTargetUrl = `http://127.0.0.1:${localPort}`;

    let provisioned: ProvisionTunnelResult;
    try {
      provisioned = await this.provider.provisionTunnel({ token, accountId, hostname, localTargetUrl });
    } catch (err) {
      throw unprocessableEntity(this.describeProviderError(err, "provision the tunnel"), instancePath);
    }

    let dnsRoute: DnsRouteResult;
    try {
      dnsRoute = await this.provider.createDnsRoute({ token, accountId, tunnelId: provisioned.tunnelId, hostname });
    } catch (err) {
      // Best-effort rollback: the tunnel was created but the DNS route
      // failed. Leaving an orphaned tunnel behind is worse than trying to
      // clean it up; a second failure here is swallowed so it never masks
      // the ORIGINAL (more actionable) error below.
      try {
        await this.provider.deprovisionTunnel({ token, accountId, tunnelId: provisioned.tunnelId });
      } catch {
        // deliberately swallowed — see comment above.
      }
      throw unprocessableEntity(this.describeProviderError(err, "create the DNS route"), instancePath);
    }

    await this.storeConnectorCredentials(provisioned.connectorCredentials);
    await this.connectorManager.start({ tunnelId: provisioned.tunnelId, hostname, credential: provisioned.connectorCredentials });

    const row = await enableTunnelStateAndEmit(this.dbProvider.db, {
      hostname,
      tunnelId: provisioned.tunnelId,
      accountId,
      zoneId: dnsRoute.zoneId,
      dnsRecordId: dnsRoute.dnsRecordId,
      actorUserId: input.actorUserId,
      nowMs,
    });

    return this.toStatusDto(row);
  }

  /**
   * R8 "verified teardown": stop the connector, THEN remove the DNS route,
   * THEN delete the tunnel, THEN clear the connector credentials — each
   * one a real external call, not a flag flip — and only once every one of
   * those has independently succeeded does the DB row (+ events) get
   * written. Idempotent: already-disabled is a true no-op, matching
   * disableRemoteWireguard's own stated posture (RG15).
   */
  async disableRemoteTunnel(input: { actorUserId: string; nowMs?: number; instancePath?: string }): Promise<RemoteTunnelStatusDto> {
    const nowMs = input.nowMs ?? Date.now();
    const instancePath = input.instancePath ?? "/admin/remote/tunnel/disable";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const current = await getRemoteTunnelState(this.dbProvider.db);
    if (!current.enabled) {
      return this.toStatusDto(current);
    }

    await this.connectorManager.stop();

    const token = await this.tokenService.resolveStoredToken();
    if (!token) {
      // The admin cleared the token (a legal, independent action) after
      // enabling. R8 requires a VERIFIED teardown — proceeding without a
      // token would mean silently abandoning a live tunnel + DNS record on
      // Cloudflare's side with no way to prove otherwise. Nothing local
      // has been mutated yet (the connector was already stopped above,
      // which is safe to repeat), so this is a clean, retryable refusal.
      throw unprocessableEntity(
        "Cannot verify teardown — no Cloudflare API token is stored. Set the token again, then disable.",
        instancePath,
      );
    }

    if (current.zone_id && current.dns_record_id) {
      try {
        await this.provider.removeDnsRoute({ token, zoneId: current.zone_id, dnsRecordId: current.dns_record_id });
      } catch (err) {
        throw unprocessableEntity(this.describeProviderError(err, "remove the DNS route"), instancePath);
      }
    }

    if (current.account_id && current.tunnel_id) {
      try {
        await this.provider.deprovisionTunnel({ token, accountId: current.account_id, tunnelId: current.tunnel_id });
      } catch (err) {
        throw unprocessableEntity(this.describeProviderError(err, "delete the tunnel"), instancePath);
      }
    }

    await this.clearConnectorCredentials();

    const row = await disableTunnelStateAndEmit(this.dbProvider.db, { actorUserId: input.actorUserId, nowMs });
    return this.toStatusDto(row);
  }
}
