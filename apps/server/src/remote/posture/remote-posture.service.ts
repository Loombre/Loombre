// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/remote-posture.service.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7, S1 lane). The impure shell:
// gathers real input for each of the seven POSTURE_CHECK_KEYS (packages/
// shared/src/remote/posture-model.ts, frozen) and hands it to this
// directory's pure grading functions (./checks/*.ts), then composes the
// result through posture-model.ts's own frozen deriveCardState/
// applicableChecks so applicability/fix-action-linking/overall-grade
// composition is never re-implemented here.
//
// Read-only and side-effect-free by design: `evaluate()` never writes
// anything (no baseline, no events) — GET /admin/remote/posture
// (../remote-posture.controller.ts) is a plain "evaluate now" read.
// ../remote-posture-regression.scheduler.ts is the ONLY writer of the
// regression baseline / posture.regressed/recovered events; it calls this
// SAME evaluate() so the card and the background sweep can never disagree
// about what a check currently reads.

import { Injectable } from "@nestjs/common";
import {
  applicableChecks,
  deriveCardState,
  nowMs as clockNowMs,
  type PostureActivePath,
  type PostureCardState,
  type PostureCheckKey,
  type PostureGrade,
} from "@loombre/shared";
import { countStaleAccountsAdmin, hasUnclaimedInvites } from "@loombre/db";
import { crypto as acmeCrypto } from "acme-client";
import { DbProvider } from "../../common/db.provider.js";
import { SettingsService } from "../../settings/settings.service.js";
import { loadTlsConfig } from "../../tls/config.js";
import { readManualCertificate } from "../../tls/manual-provider.js";
import { loadPersistedCertificate } from "../../tls/acme/cert-store.js";
import { gradeTlsValidity } from "./checks/tls-validity.js";
import { gradeRateLimitersActive } from "./checks/rate-limiters-active.js";
import { gradeStaleAccounts } from "./checks/stale-accounts.js";
import { gradeInviteLinksReachable } from "./checks/invite-links-reachable.js";
import { gradeWgPortSilence } from "./checks/wg-port-silence.js";
import { gradeConnectorHealth } from "./checks/connector-health.js";
import { gradePublicUrlCoherence } from "./checks/public-url-coherence.js";
import { ConnectorHealthReaderService } from "./connector-health.reader.js";
import { WireguardStatusReaderService } from "./wireguard-status.reader.js";
import { RemoteActivePathReaderService } from "./active-path.reader.js";

export interface PostureCheckOutcomeWithKey {
  checkKey: PostureCheckKey;
  grade: PostureGrade;
  detail: string;
}

export interface RemotePostureEvaluation {
  card: PostureCardState;
  /** checkKey -> human-readable detail sentence. Empty when the card is
   *  inactive (path 'none' — deriveCardState's own early return means no
   *  check is ever surfaced in that state). */
  details: ReadonlyMap<PostureCheckKey, string>;
}

/** Never throws — same "constructor-time SettingsService cache may not be
 *  loaded yet" lifecycle hazard every other settings-reading service in
 *  this codebase documents (surface-rate-limiter.service.ts's own
 *  safeEffectiveNumber, auth-rate-limiter.service.ts's own header) — this
 *  service is a plain per-request read, never called during bootstrap, but
 *  the never-throws posture costs nothing and keeps the same defensive
 *  shape as its siblings. */
function safeEffectiveNumber(settingsService: SettingsService, key: string, fallback: number): number {
  try {
    const effective = settingsService.getEffective(key);
    return effective !== undefined ? (effective.value as number) : fallback;
  } catch {
    return fallback;
  }
}

function safeEffectiveString(settingsService: SettingsService, key: string, fallback: string): string {
  try {
    const effective = settingsService.getEffective(key);
    return effective !== undefined ? (effective.value as string) : fallback;
  } catch {
    return fallback;
  }
}

@Injectable()
export class RemotePostureService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
    private readonly connectorHealthReader: ConnectorHealthReaderService,
    private readonly wireguardStatusReader: WireguardStatusReaderService,
    private readonly activePathReader: RemoteActivePathReaderService,
  ) {}

  async resolveActivePath(): Promise<PostureActivePath> {
    return this.activePathReader.read();
  }

  async evaluate(path: PostureActivePath, nowMs: number = clockNowMs()): Promise<RemotePostureEvaluation> {
    if (path === "none") {
      return { card: deriveCardState(path, new Map()), details: new Map() };
    }

    const keys = applicableChecks(path);
    const outcomes = await Promise.all(keys.map((key) => this.evaluateOne(key, path, nowMs)));
    const results = new Map<PostureCheckKey, PostureGrade>(outcomes.map((o) => [o.checkKey, o.grade]));
    const details = new Map<PostureCheckKey, string>(outcomes.map((o) => [o.checkKey, o.detail]));
    const card = deriveCardState(path, results);
    return { card, details };
  }

  private async evaluateOne(key: PostureCheckKey, path: PostureActivePath, nowMs: number): Promise<PostureCheckOutcomeWithKey> {
    switch (key) {
      case "tlsValidity": {
        const outcome = await this.evalTlsValidity(nowMs);
        return { checkKey: key, ...outcome };
      }
      case "rateLimitersActive": {
        const outcome = this.evalRateLimitersActive();
        return { checkKey: key, ...outcome };
      }
      case "staleAccounts": {
        const outcome = await this.evalStaleAccounts();
        return { checkKey: key, ...outcome };
      }
      case "inviteLinksReachable": {
        const outcome = await this.evalInviteLinksReachable(nowMs);
        return { checkKey: key, ...outcome };
      }
      case "wgPortSilence": {
        const outcome = await this.evalWgPortSilence();
        return { checkKey: key, ...outcome };
      }
      case "connectorHealth": {
        const outcome = await this.evalConnectorHealth();
        return { checkKey: key, ...outcome };
      }
      case "publicUrlCoherence": {
        const outcome = this.evalPublicUrlCoherence(path);
        return { checkKey: key, ...outcome };
      }
    }
  }

  private async evalTlsValidity(nowMs: number) {
    // loadTlsConfig itself throws TlsConfigError on a broken manual-mode
    // env combination (e.g. LOOMBRE_TLS_CERT_PATH points nowhere — config.ts's
    // own eager existence check). A broken TLS config is exactly the kind
    // of thing this check exists to surface — it must degrade to `fail`,
    // NOT let the throw propagate and take down every OTHER check in the
    // same evaluate() call (Promise.all in evaluate() would otherwise
    // reject the whole batch over one bad env var).
    let config: ReturnType<typeof loadTlsConfig>;
    try {
      config = loadTlsConfig(process.env);
    } catch (err) {
      return {
        grade: "fail" as const,
        detail: `The Direct path's TLS configuration is invalid: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (config.mode === "off") {
      return gradeTlsValidity({ mode: "off", cert: undefined, nowMs });
    }

    let cert: { notAfterMs: number } | undefined;
    try {
      if (config.mode === "manual") {
        const material = readManualCertificate(config);
        const info = acmeCrypto.readCertificateInfo(material.cert);
        cert = { notAfterMs: info.notAfter.getTime() };
      } else {
        const persisted = loadPersistedCertificate(config.dataDir);
        cert = persisted ? { notAfterMs: persisted.notAfterMs } : undefined;
      }
    } catch {
      cert = undefined;
    }

    return gradeTlsValidity({ mode: config.mode, cert, nowMs });
  }

  private evalRateLimitersActive() {
    return gradeRateLimitersActive({
      probe: safeEffectiveNumber(this.settingsService, "rateLimit.probe", 10),
      login: safeEffectiveNumber(this.settingsService, "rateLimit.login", 10),
      refresh: safeEffectiveNumber(this.settingsService, "rateLimit.refresh", 30),
      unlock: safeEffectiveNumber(this.settingsService, "rateLimit.unlock", 5),
    });
  }

  private async evalStaleAccounts() {
    const count = await countStaleAccountsAdmin(this.dbProvider.db);
    return gradeStaleAccounts(count);
  }

  private async evalInviteLinksReachable(nowMs: number) {
    const has = await hasUnclaimedInvites(this.dbProvider.db, nowMs);
    return gradeInviteLinksReachable(has);
  }

  private async evalWgPortSilence() {
    const status = await this.wireguardStatusReader.read();
    return gradeWgPortSilence(status);
  }

  private async evalConnectorHealth() {
    const state = await this.connectorHealthReader.read();
    return gradeConnectorHealth(state);
  }

  private evalPublicUrlCoherence(path: PostureActivePath) {
    return gradePublicUrlCoherence({
      path,
      publicUrl: safeEffectiveString(this.settingsService, "network.publicUrl", ""),
      tunnelHostname: safeEffectiveString(this.settingsService, "remote.tunnelHostname", ""),
    });
  }
}
