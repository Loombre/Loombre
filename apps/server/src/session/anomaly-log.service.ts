// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/anomaly-log.service.ts
//
// fail2ban-compatible single-line auth anomaly log (STATE.md P2.1/P2.12,
// docs/PLAN.md §10). Appended to a LOCAL file only — never a network call
// of any kind (CLAUDE.md invariant 7, D14: no telemetry/phone-home, ever).
// Path from LOOMBRE_AUTH_LOG_FILE, default <cwd>/logs/auth-anomaly.log; the
// directory (and any missing parents) is created at construction.
//
// Line format (stable, greppable, one event per line):
//   <ISO-8601 UTC timestamp> loombre-auth <EVENT_KIND> key=value key=value...
// e.g.
//   2026-07-23T12:00:00.000Z loombre-auth FAILED_LOGIN ip=1.2.3.4 user=alice
//
// Example fail2ban filter (failregex), for an operator's jail.local:
//   [Definition]
//   failregex = ^\S+ loombre-auth (FAILED_LOGIN|PIN_FAILURE|RATE_LIMITED) .*ip=<HOST>
//   ignoreregex =
//
// Fields are a closed, non-secret vocabulary (ip/user/device/op) —
// passwords and PINs are never accepted as loggable fields by this
// service's type signature, so a call site cannot accidentally leak one.
// Values are sanitized (embedded newlines/control characters stripped) so
// a malicious username/device name can never forge extra log lines.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): gated on
// SettingsService's security.loginAnomalyLogEnabled (packages/shared/src/
// settings-registry.ts), read fresh on every log() call (the natural
// per-use boundary — this is a fire-and-forget append, not a long-lived
// resource that needs a restart to retarget) rather than once at
// construction, so a toggle takes effect on the very next anomaly without
// a restart (requiresRestart:false). The FILE PATH (LOOMBRE_AUTH_LOG_FILE)
// stays a plain env-only read at construction — it is not an Addendum A
// registry entry (no A3/AD1 UI-editable key names it), so it is out of
// this lane's migration scope.

import { Injectable } from "@nestjs/common";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsService } from "../settings/settings.service.js";

export type AnomalyEventKind = "FAILED_LOGIN" | "REFRESH_REUSE" | "PIN_FAILURE" | "RATE_LIMITED";

/** Closed, non-secret vocabulary — deliberately excludes anything
 *  password/PIN-shaped so a caller cannot pass a secret through even by
 *  mistake. */
export interface AnomalyLogFields {
  ip?: string;
  user?: string;
  device?: string;
  op?: string;
}

function sanitize(value: string): string {
  // Strips anything that could inject a line break or otherwise corrupt
  // the one-event-per-line invariant; collapses to a single token-safe
  // string. Also strips whitespace so `key=value` pairs stay unambiguous.
  return value.replace(/[\s\r\n]+/g, "_");
}

@Injectable()
export class AnomalyLogService {
  readonly filePath: string;

  constructor(private readonly settingsService: SettingsService) {
    this.filePath = process.env["LOOMBRE_AUTH_LOG_FILE"] ?? join(process.cwd(), "logs", "auth-anomaly.log");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  log(kind: AnomalyEventKind, fields: AnomalyLogFields, nowMs: number = Date.now()): void {
    const enabled = (this.settingsService.getEffective("security.loginAnomalyLogEnabled")?.value as boolean | undefined) ?? true;
    if (!enabled) return;

    const timestamp = new Date(nowMs).toISOString();
    const kv = Object.entries(fields)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${sanitize(value)}`)
      .join(" ");
    const line = kv.length > 0 ? `${timestamp} loombre-auth ${kind} ${kv}` : `${timestamp} loombre-auth ${kind}`;
    appendFileSync(this.filePath, line + "\n", "utf8");
  }
}
