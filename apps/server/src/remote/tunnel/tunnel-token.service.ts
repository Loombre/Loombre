// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/tunnel-token.service.ts
//
// STATE.md R4/R9: the admin's BYO Cloudflare API token, keyring-only via
// packages/secrets — the {value, setAtMs} envelope precedent apps/server/
// src/settings/provider-keys.service.ts establishes (AD4), NOT
// server_settings (A9: secrets are never configuration). Unlike provider
// keys/mail credentials, this token has no competing LOOMBRE_*_ env var
// (packages/shared/src/settings-registry.ts's `remote` category has NO
// token key — remote.wireguardPort/subnet/wireguardEndpointHost/
// cloudflaredPath/tunnelHostname are all non-secret config; the token
// itself is deliberately absent from the registry entirely, R9), so this
// service — unlike provider-keys.service.ts/mail-credentials.service.ts —
// has no env-precedence 409 branch to carry.
//
// R4/mission item 2: `setToken` validates via TunnelProvider BEFORE
// storing — an invalid or insufficient-scope token is NEVER written to the
// keyring. The stored envelope carries a THIRD field beyond AD4's
// `{value, setAtMs}`: `scopesOk` (always `true` for anything actually
// stored, since an invalid/insufficient token is rejected before storage
// ever happens) — carried explicitly rather than always inlined as a
// literal `true` so `status()` stays a single source of truth if a future
// change ever needs to store a token whose scopes could go stale without
// being re-validated inline (documented tradeoff below).
//
// getRemoteTunnelStatus's `tokenScopesOk` (this lane's own additive
// extension to RemoteTunnelStatus, see remote-tunnel.service.ts's header
// for the full drift-decision writeup) reports this STORED value, never a
// live re-check — Tier-0 (CLAUDE.md invariant 9: request paths do no
// CPU/IO-heavy work) and avoiding hammering Cloudflare's API on every
// status poll both argue against re-validating on every read. Documented
// tradeoff: if the token's Cloudflare-side scopes are revoked AFTER being
// stored here, `tokenScopesOk` keeps reporting `true` until the admin
// re-sets the token (at which point it is re-validated for real) — the
// SAME class of tradeoff provider-keys.service.ts's own header accepts for
// its backend-migration case. A real provisioning call failing later
// (enableRemoteTunnel) surfaces the true, current state honestly via its
// own error path regardless.
//
// Response DTO discipline (R4's "write-only masked semantics"): the
// envelope's `value` (the actual token) is NEVER placed on any type this
// service returns — RemoteTunnelTokenStatus has no field capable of
// carrying it, by construction, not by convention (provider-keys.service.
// ts's own header states the identical guarantee for its own status DTO).

import { Injectable } from "@nestjs/common";
import { detectSecretBackend, removeSecret, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import { emitRedactedSettingsUpdated } from "@loombre/db";
import { DbProvider } from "../../common/db.provider.js";
import { requireLiveAdmin } from "../../common/require-live-admin.js";
import { resolveAppPaths } from "../../cli/app-paths.js";
import { TunnelProvider } from "./tunnel-provider.js";

interface TunnelTokenEnvelope {
  value: string;
  setAtMs: number;
  scopesOk: boolean;
}

function isTunnelTokenEnvelope(value: unknown): value is TunnelTokenEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).value === "string" &&
    typeof (value as Record<string, unknown>).setAtMs === "number" &&
    typeof (value as Record<string, unknown>).scopesOk === "boolean"
  );
}

export interface RemoteTunnelTokenStatus {
  configured: boolean;
  setAtMs: number | null;
  scopesOk: boolean | null;
}

export interface SetTunnelTokenResult {
  valid: boolean;
  detail: string | null;
}

@Injectable()
export class TunnelTokenService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly provider: TunnelProvider,
  ) {}

  private secretKey(): string {
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return `${dataDir}/secrets/remote-tunnel-token`;
  }

  private async resolveBackend(): Promise<SecretBackend> {
    const detected = await detectSecretBackend();
    return detected.backend;
  }

  async status(): Promise<RemoteTunnelTokenStatus> {
    const backend = await this.resolveBackend();
    const raw = await tryResolveSecret({ backend, key: this.secretKey() });
    if (raw === null) return { configured: false, setAtMs: null, scopesOk: null };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A9/A4 "never a crash" discipline — same posture as provider-keys.
      // service.ts/mail-credentials.service.ts's own identical catch.
      return { configured: false, setAtMs: null, scopesOk: null };
    }
    if (!isTunnelTokenEnvelope(parsed)) return { configured: false, setAtMs: null, scopesOk: null };
    return { configured: true, setAtMs: parsed.setAtMs, scopesOk: parsed.scopesOk };
  }

  /** Resolves the raw token string for internal use by remote-tunnel.
   *  service.ts (provisioning/teardown calls) — NEVER exposed on any DTO
   *  returned to a caller outside this module's own package. */
  async resolveStoredToken(): Promise<string | null> {
    const backend = await this.resolveBackend();
    const raw = await tryResolveSecret({ backend, key: this.secretKey() });
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isTunnelTokenEnvelope(parsed)) return null;
    return parsed.value;
  }

  /**
   * R4/mission item 2: validates via TunnelProvider BEFORE storing.
   * Per packages/contract/openapi.yaml's frozen Wave-0 `setRemoteTunnelToken`
   * response shape (`RemoteTunnelTokenValidation {valid, detail}`, 200 —
   * NOT a 4xx problem+json for an invalid/insufficiently-scoped token, only
   * for a malformed request body), an invalid token is reported via THIS
   * return value, never thrown; the token is written to the keyring ONLY
   * when `valid` is true.
   *
   * An empty/whitespace-only token short-circuits BEFORE calling
   * TunnelProvider at all — no network call for input that is obviously
   * not a token (also what makes apps/server/test/conformance.spec.ts's
   * bodyless walk of this op network-free: a missing request body coerces
   * `token` to `""`, R11's "never the live API" rule extends to that
   * suite too, not just this lane's own tests).
   */
  async setToken(input: { token: string; actorUserId: string; nowMs: number; instancePath?: string }): Promise<SetTunnelTokenResult> {
    const instancePath = input.instancePath ?? "/admin/remote/tunnel/token";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    if (input.token.trim().length === 0) {
      return { valid: false, detail: "token must not be empty." };
    }

    const validation = await this.provider.validateToken(input.token);
    if (!validation.valid) {
      return { valid: false, detail: validation.detail };
    }

    const backend = await this.resolveBackend();
    const envelope: TunnelTokenEnvelope = { value: input.token, setAtMs: input.nowMs, scopesOk: true };
    await storeSecret(backend, this.secretKey(), JSON.stringify(envelope));

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: "remote.tunnelToken",
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    return { valid: true, detail: validation.detail };
  }

  async clearToken(input: { actorUserId: string; nowMs: number; instancePath?: string }): Promise<void> {
    const instancePath = input.instancePath ?? "/admin/remote/tunnel/token";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const backend = await this.resolveBackend();
    await removeSecret({ backend, key: this.secretKey() });

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: "remote.tunnelToken",
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });
  }
}
