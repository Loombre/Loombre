// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-direct.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5, RG12, RG15, this lane's own
// mission, lane/remote-base). Three ops (tag `remote`,
// packages/contract/openapi.yaml):
//   - POST /admin/remote/direct/acme-test   testRemoteDirectAcme
//   - POST /admin/remote/direct/enable      enableRemoteDirect
//   - POST /admin/remote/direct/disable     disableRemoteDirect
//
// RG12 FEASIBILITY GROUND TRUTH (this lane's hard part, per the brief):
// apps/server/src/tls/acme/issue-certificate.ts's issueCertificate() runs
// perfectly well OUTSIDE main.ts's boot path — it takes a plain
// TlsConfigAcme object + an optional Http01ChallengeServer/log/test-only
// deps, with NO hidden dependency on anything main.ts sets up first (no
// Nest DI, no app instance). testRemoteDirectAcme below constructs an AD
// HOC TlsConfigAcme from the admin-supplied domain (the frozen contract's
// TestRemoteDirectAcmeRequest carries `domain` ONLY — no challengeType
// field — so the wizard's guided Direct flow is fixed to http-01, the
// simpler of the two challenge types and the one docs/ops/remote-access/acme.md
// recommends whenever port 80 is reachable; dns-01 remains available as an
// ADVANCED env-only path outside the wizard, unaffected), spins up its OWN
// short-lived Http01ChallengeServer bound to LOOMBRE_HTTP_PORT (default 80
// — the SAME privileged-port story docs/ops/remote-access/acme.md already documents
// honestly; this endpoint does not and cannot change that), runs the real
// issuance, and on success calls persistIssuedCertificate() — THE SAME
// file apps/server/src/tls/runtime.ts's boot-time createTlsRuntime() reads
// via loadPersistedCertificate() — so a staged test that succeeds leaves a
// real, valid, ready-to-serve certificate sitting exactly where the real
// ACME runtime will look for it at the next restart, with NO re-issuance
// needed. NEVER touches tls.mode (RG12's lockout-risk mitigation).
//
// enableRemoteDirect(mode: acme) requires exactly that already-persisted,
// still-valid, domain-matching certificate to exist (loadPersistedCertificate
// + a real X509 checkHost — never trusts "a cert exists" alone) before
// committing tls.acmeDomains/tls.acmeChallengeType/tls.acmeTosAgreed/
// tls.mode through SettingsService (which independently re-verifies live
// admin AND RG12's cross-field invariants — see settings.service.ts).
// mode: reverse-proxy validates that network.trustProxy is ALREADY
// configured (the frozen EnableRemoteDirectRequest carries no trustProxy
// field of its own — "set network.trustProxy per admin input" reads, on
// the frozen contract, as "via the general settings screen this lane also
// promoted it into", not a field on this request; flagged in this lane's
// final report as an adjudication).
//
// disableRemoteDirect reverts tls.mode/network.trustProxy to whatever they
// were immediately before the FIRST enable in the current streak (a
// re-entry/mode-switch within Direct reuses the ORIGINAL snapshot rather
// than clobbering it with Direct's own already-applied values — see
// packages/db/src/query/remote-direct.ts's header). Idempotent: disabling
// an already-disabled Direct path is a no-op 200, never an error.
//
// EVENTS: `remote.path.changed` only, NOT `remote.enabled`/`remote.disabled`
// — ground-truthed against the FROZEN event-schema JSON files (not the
// mission's own prose), see packages/db/src/query/remote-direct.ts's
// header for the full reasoning. Both enable and disable route through
// enableRemoteDirectStateAndEmit/disableRemoteDirectStateAndEmit (ONE
// transaction: the internal state row + the event, together).
//
// HONEST requiresRestart (mission: "do NOT restart from this endpoint"):
// this controller never calls ServerPowerService — it commits settings and
// returns; apps/server/src/tls/settings-boot-bridge.ts (wired into
// main.ts's bootstrap()) is what makes the NEXT restart actually pick up
// the committed values, and GET /admin/settings' own restartPendingKeys
// (unchanged machinery, now exercised by these 5 promoted keys for the
// first time) is what tells the wizard UI a restart is owed — this
// controller's own response shape (RemoteDirectStatus, frozen, no
// restart-related field) carries none of that by design; see this lane's
// final report for the full chain.

import { X509Certificate } from "node:crypto";
import { Body, Controller, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import {
  disableRemoteDirectStateAndEmit,
  enableRemoteDirectStateAndEmit,
  getRemoteDirectInternalState,
  RemotePathConflictError,
  type RemoteDirectMode,
  type RemotePathId,
} from "@loombre/db";
import { ACME_DOMAIN_SCHEMA, nowMs as clockNowMs } from "@loombre/shared";
import { conflict, unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { SettingsService } from "../settings/settings.service.js";
import { RemoteActivePathReader } from "./active-path-reader.js";
import {
  DEFAULT_ACME_DIRECTORY_URL_PRODUCTION,
  DEFAULT_ACME_DIRECTORY_URL_STAGING,
  DEFAULT_DNS_PROPAGATION_TIMEOUT_MS,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  DEFAULT_RENEW_CHECK_INTERVAL_MS,
  DEFAULT_RENEW_WINDOW_DAYS,
  type TlsConfigAcme,
} from "../tls/config.js";
import { resolveDataDir } from "../tls/storage.js";
import { loadPersistedCertificate, persistIssuedCertificate } from "../tls/acme/cert-store.js";
import { issueCertificate } from "../tls/acme/issue-certificate.js";
import { Http01ChallengeServer } from "../tls/acme/http01-server.js";

const ACME_TEST_BODY_KEYS = new Set(["domain"]);
const ENABLE_BODY_KEYS = new Set(["mode", "domain"]);
const ENABLE_MODES = new Set(["acme", "reverse-proxy"]);

function normalizeDomain(raw: unknown, instance: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw unprocessableEntity('"domain" is required.', instance);
  }
  const domain = raw.trim().toLowerCase();
  const parsed = ACME_DOMAIN_SCHEMA.safeParse(domain);
  if (!parsed.success) {
    throw unprocessableEntity(`"domain" must be a real domain name (e.g. media.example.com): ${parsed.error.issues[0]?.message ?? "invalid"}`, instance);
  }
  return domain;
}

function readTruthyEnvFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lowered = raw.trim().toLowerCase();
  return lowered === "1" || lowered === "true" || lowered === "on" || lowered === "yes";
}

/** Builds the AD HOC TlsConfigAcme used for the staged test (RG12) — fixed
 *  http-01 (see this file's header), production Let's Encrypt unless the
 *  ADVANCED env-only LOOMBRE_ACME_DIRECTORY_URL/LOOMBRE_ACME_STAGING
 *  overrides are set (an operator layering advanced config underneath the
 *  wizard, same as every other advanced ACME knob this lane does NOT
 *  promote — see RG12's "minimum key set" scoping). Everything else is
 *  either a sane fixed default or the SAME env vars production issuance
 *  already reads (LOOMBRE_HTTP_PORT/LOOMBRE_HTTPS_PORT/LOOMBRE_DATA_DIR/
 *  LOOMBRE_ACME_EMAIL), so a staged test and the eventual real boot-time
 *  issuance resolve identically. */
function buildAdHocAcmeConfig(domain: string): TlsConfigAcme {
  const env = process.env;
  const httpPortRaw = env["LOOMBRE_HTTP_PORT"];
  const httpsPortRaw = env["LOOMBRE_HTTPS_PORT"];
  const httpPort = httpPortRaw ? Number.parseInt(httpPortRaw, 10) : DEFAULT_HTTP_PORT;
  const httpsPort = httpsPortRaw ? Number.parseInt(httpsPortRaw, 10) : DEFAULT_HTTPS_PORT;
  const directoryUrl =
    env["LOOMBRE_ACME_DIRECTORY_URL"]?.trim() ||
    (readTruthyEnvFlag(env["LOOMBRE_ACME_STAGING"]) ? DEFAULT_ACME_DIRECTORY_URL_STAGING : DEFAULT_ACME_DIRECTORY_URL_PRODUCTION);
  const email = env["LOOMBRE_ACME_EMAIL"]?.trim() || undefined;

  return {
    mode: "acme",
    httpPort: Number.isFinite(httpPort) ? httpPort : DEFAULT_HTTP_PORT,
    httpsPort: Number.isFinite(httpsPort) ? httpsPort : DEFAULT_HTTPS_PORT,
    domains: [domain],
    challengeType: "http-01",
    directoryUrl,
    ...(email !== undefined ? { email } : {}),
    renewWindowDays: DEFAULT_RENEW_WINDOW_DAYS,
    renewCheckIntervalMs: DEFAULT_RENEW_CHECK_INTERVAL_MS,
    dataDir: resolveDataDir(env["LOOMBRE_DATA_DIR"]),
    dnsPropagationTimeoutMs: DEFAULT_DNS_PROPAGATION_TIMEOUT_MS,
  };
}

/** True when `cert` is unexpired and covers `domain` — the same "never
 *  trust that SOME cert exists, verify it's the RIGHT one" check
 *  apps/server/test/tls/acme-http01-pebble.integration.spec.ts's own
 *  connectAndReadCert + X509Certificate#checkHost proof uses, applied here
 *  to a persisted PEM instead of a live TLS peer certificate. Exported
 *  (WG2): remote-state.controller.ts's getRemoteState composition reuses
 *  this exact check rather than re-deriving cert validity a second way. */
export function certCoversDomain(certPem: string, notAfterMs: number, domain: string, nowMsValue: number): boolean {
  if (notAfterMs <= nowMsValue) return false;
  const x509 = new X509Certificate(certPem);
  return x509.checkHost(domain) !== undefined;
}

export interface RemoteDirectStatusDto {
  enabled: boolean;
  mode: RemoteDirectMode | null;
  domain: string | null;
  certValid: boolean | null;
  certExpiresAtMs: number | null;
}

/**
 * WG2 (getRemoteState composition, item 6): the Direct path has NO
 * dedicated status op (the frozen Wave-0 surface is acme-test/enable/
 * disable only — see this file's header) so this is the one place a
 * point-in-time status READ (as opposed to enable/disable's own inline
 * response bodies above) is derived. `domain` is read from the
 * tls.acmeDomains setting (the ONLY place it survives past the original
 * enable call — RemoteDirectInternalState itself does not store it, see
 * packages/db/src/query/remote-direct.ts's header) rather than from any
 * request; `certValid`/`certExpiresAtMs` re-check the SAME persisted
 * certificate enableRemoteDirect itself verified at enable time, using the
 * SAME certCoversDomain check above, so a getRemoteState read can never
 * disagree with what enabling Direct actually required.
 */
export async function buildRemoteDirectStatus(db: LoombreDb, settingsService: SettingsService): Promise<RemoteDirectStatusDto> {
  const state = await getRemoteDirectInternalState(db);
  if (!state.enabled) {
    return { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null };
  }
  if (state.mode === "acme") {
    const domains = (settingsService.getEffective("tls.acmeDomains")?.value as string[] | undefined) ?? [];
    const domain = domains[0] ?? null;
    const dataDir = resolveDataDir(process.env["LOOMBRE_DATA_DIR"]);
    const persisted = loadPersistedCertificate(dataDir);
    const certValid = persisted !== undefined && domain !== null && certCoversDomain(persisted.certPem, persisted.notAfterMs, domain, clockNowMs());
    return { enabled: true, mode: "acme", domain, certValid, certExpiresAtMs: persisted?.notAfterMs ?? null };
  }
  return { enabled: true, mode: "reverse-proxy", domain: null, certValid: null, certExpiresAtMs: null };
}

@Controller()
export class RemoteDirectController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
    private readonly activePathReader: RemoteActivePathReader,
  ) {}

  @Post("admin/remote/direct/acme-test")
  @HttpCode(HttpStatus.OK)
  async testRemoteDirectAcme(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const instance = req.originalUrl;
    const body = rawBody ?? {};

    for (const key of Object.keys(body)) {
      if (!ACME_TEST_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    const domain = normalizeDomain(body["domain"], instance);

    const config = buildAdHocAcmeConfig(domain);
    const http01Server = new Http01ChallengeServer({ redirectHttpsPort: config.httpsPort });

    try {
      await http01Server.listen(config.httpPort);
      const issued = await issueCertificate(config, { http01Server, log: () => {} });
      persistIssuedCertificate(config.dataDir, issued);
      return {
        success: true,
        detail: `Certificate issued for ${domain}, valid until ${new Date(issued.notAfterMs).toISOString()}.`,
      };
    } catch (err) {
      return { success: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      await http01Server.close().catch(() => {});
    }
  }

  @Post("admin/remote/direct/enable")
  @HttpCode(HttpStatus.OK)
  async enableRemoteDirect(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const instance = req.originalUrl;
    const body = rawBody ?? {};
    const actorUserId = req.user!.userId;
    const nowMsValue = clockNowMs();

    for (const key of Object.keys(body)) {
      if (!ENABLE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (typeof body["mode"] !== "string" || !ENABLE_MODES.has(body["mode"])) {
      throw unprocessableEntity('"mode" must be one of: acme, reverse-proxy.', instance);
    }
    const mode = body["mode"] as "acme" | "reverse-proxy";

    // RG15: 409 against another ACTIVE path — the REAL canonical resolver
    // (WG2 integration unification), replacing this lane's own
    // isolated-worktree WG-only defensive raw-SQL check (see packages/db/
    // src/query/remote-direct.ts's isRemoteWireguardActive doc comment for
    // why that existed and what it did and did not cover). Every path is
    // checked now, not just WireGuard.
    //
    // LD-9 (V-SEC F2): this is a FAIL-FAST, not the enforcement. It cannot
    // see a path that becomes active between here and the commit below;
    // enableRemoteDirectStateAndEmit's own transaction re-reads all three
    // paths under a shared advisory lock and throws RemotePathConflictError
    // rather than committing a second active path (packages/db/src/query/
    // remote-path-guard.ts). commitDirectEnable below handles that loss.
    const otherPath = await this.activePathReader.activePath();
    if (otherPath !== "none" && otherPath !== "direct") {
      throw conflict(`The ${otherPath} path is already active — disable it before enabling the Direct path.`, instance, "remote-path-active");
    }

    const currentState = await getRemoteDirectInternalState(db);
    // A re-entry/mode-switch WITHIN Direct reuses the ORIGINAL pre-enable
    // snapshot rather than re-snapshotting Direct's own already-applied
    // values (which would make disable revert to the wrong thing).
    const preEnableTlsMode = currentState.enabled
      ? currentState.preEnableTlsMode!
      : ((this.settingsService.getEffective("tls.mode")?.value as string | undefined) ?? "off");
    const preEnableTrustProxy = currentState.enabled
      ? currentState.preEnableTrustProxy!
      : ((this.settingsService.getEffective("network.trustProxy")?.value as string | undefined) ?? "");
    const previousActivePath: RemotePathId = currentState.enabled ? "direct" : "none";

    if (mode === "acme") {
      const domain = normalizeDomain(body["domain"], instance);
      const dataDir = resolveDataDir(process.env["LOOMBRE_DATA_DIR"]);
      const persisted = loadPersistedCertificate(dataDir);
      if (!persisted || !certCoversDomain(persisted.certPem, persisted.notAfterMs, domain, nowMsValue)) {
        throw unprocessableEntity(
          `No valid, unexpired certificate for "${domain}" was found — run the staged ACME test for this exact domain first (POST /admin/remote/direct/acme-test).`,
          instance,
        );
      }

      await this.settingsService.updateSetting({ key: "tls.acmeDomains", value: [domain], actorUserId, nowMs: nowMsValue, instancePath: instance });
      await this.settingsService.updateSetting({ key: "tls.acmeChallengeType", value: "http-01", actorUserId, nowMs: nowMsValue, instancePath: instance });
      await this.settingsService.updateSetting({ key: "tls.acmeTosAgreed", value: true, actorUserId, nowMs: nowMsValue, instancePath: instance });
      await this.settingsService.updateSetting({ key: "tls.mode", value: "acme", actorUserId, nowMs: nowMsValue, instancePath: instance });

      await this.commitDirectEnable(
        db,
        {
          mode: "acme",
          preEnableTlsMode,
          preEnableTrustProxy,
          previousActivePath,
          actorUserId,
          nowMs: nowMsValue,
        },
        instance,
      );

      return { enabled: true, mode: "acme", domain, certValid: true, certExpiresAtMs: persisted.notAfterMs };
    }

    // mode === "reverse-proxy": the frozen EnableRemoteDirectRequest carries
    // no trustProxy input field (see this file's header) — "validate" means
    // confirming network.trustProxy is ALREADY configured via the general
    // settings screen (this lane promoted it to ui-scope precisely so that
    // screen can set it); "domain" is accepted but ignored per the contract.
    const trustProxyValue = (this.settingsService.getEffective("network.trustProxy")?.value as string | undefined) ?? "";
    if (trustProxyValue.trim() === "") {
      throw unprocessableEntity(
        'network.trustProxy is not configured — set it from Settings before enabling the Direct path in reverse-proxy mode.',
        instance,
      );
    }

    await this.commitDirectEnable(
      db,
      {
        mode: "reverse-proxy",
        preEnableTlsMode,
        preEnableTrustProxy,
        previousActivePath,
        actorUserId,
        nowMs: nowMsValue,
      },
      instance,
    );

    return { enabled: true, mode: "reverse-proxy", domain: null, certValid: null, certExpiresAtMs: null };
  }

  /**
   * LD-9: the guarded commit, plus the compensation a loser owes.
   *
   * enableRemoteDirectStateAndEmit throws RemotePathConflictError when
   * another path won the race after this request's own fail-fast check
   * passed. Nothing of Direct's own state was written (that transaction
   * rolled back), but in `acme` mode the four tls.* settings writes above
   * ALREADY landed — they are separate, already-committed per-key writes,
   * not part of the guarded transaction. So tls.mode is put back exactly the
   * way disableRemoteDirect puts it back: toward the pre-enable snapshot,
   * never toward "acme", so RG12's cross-field invariant can never reject
   * the revert. tls.acmeDomains/tls.acmeTosAgreed are deliberately left, the
   * same as on disable (see this file's header).
   */
  private async commitDirectEnable(
    db: LoombreDb,
    input: {
      mode: RemoteDirectMode;
      preEnableTlsMode: string;
      preEnableTrustProxy: string;
      previousActivePath: RemotePathId;
      actorUserId: string;
      nowMs: number;
    },
    instance: string,
  ): Promise<void> {
    try {
      await enableRemoteDirectStateAndEmit(db, input);
    } catch (err) {
      if (err instanceof RemotePathConflictError) {
        if (input.mode === "acme") {
          await this.settingsService.updateSetting({
            key: "tls.mode",
            value: input.preEnableTlsMode,
            actorUserId: input.actorUserId,
            nowMs: input.nowMs,
            instancePath: instance,
          });
        }
        throw conflict(
          `The ${err.activePath} path is already active — disable it before enabling the Direct path.`,
          instance,
          "remote-path-active",
        );
      }
      throw err;
    }
  }

  @Post("admin/remote/direct/disable")
  @HttpCode(HttpStatus.OK)
  async disableRemoteDirect(@Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const instance = req.originalUrl;
    const actorUserId = req.user!.userId;
    const nowMsValue = clockNowMs();

    const currentState = await getRemoteDirectInternalState(db);
    if (!currentState.enabled) {
      // Idempotent (contract description) — nothing to revert, nothing to emit.
      return { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null };
    }

    // tls.mode FIRST, always toward "off"/"manual" — never toward "acme",
    // so RG12's cross-field invariant (acme requires domains+tosAgreed) can
    // never reject this specific write regardless of what those two keys
    // currently hold. tls.acmeDomains/tls.acmeTosAgreed are deliberately
    // left as-is (see this file's header) — only tls.mode/network.trustProxy
    // are the mission's named revert targets.
    if (currentState.preEnableTlsMode !== null) {
      await this.settingsService.updateSetting({
        key: "tls.mode",
        value: currentState.preEnableTlsMode,
        actorUserId,
        nowMs: nowMsValue,
        instancePath: instance,
      });
    }
    if (currentState.preEnableTrustProxy !== null) {
      await this.settingsService.updateSetting({
        key: "network.trustProxy",
        value: currentState.preEnableTrustProxy,
        actorUserId,
        nowMs: nowMsValue,
        instancePath: instance,
      });
    }

    await disableRemoteDirectStateAndEmit(db, { actorUserId, nowMs: nowMsValue });

    return { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null };
  }
}
