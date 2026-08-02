// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/mail-credentials.service.ts
//
// Optional mail transport run (E5, M10): the SMTP username/password pair,
// stored via the EXISTING packages/secrets keyring backend — the A9
// pattern this file is a deliberate SIBLING of (provider-keys.service.ts),
// NOT a graft onto that file's closed ProviderName ("tmdb"|"tvdb") enum,
// per the brief's explicit instruction ("A9 pattern, NOT the tmdb/tvdb
// ProviderName enum — leave it untouched"). Credentials are secrets, not
// configuration (same A9 rule provider-keys.service.ts's header states) —
// never in server_settings, no encryption-at-rest story there.
//
// ONE keyring entry (`<dataDir>/secrets/mail-smtp-credentials`), a
// DOUBLE-nested envelope: the OUTER shape is the same {value, setAtMs}
// AD4 envelope provider-keys.service.ts uses (so `status()` can report
// `setAtMs` without a second store) — but here `value` is itself a JSON
// string of `{username, password}` (the brief's explicit "the envelope's
// value stays a string" instruction), never a bare credential string.
//
// M8: mail credentials are OPTIONAL overall — unauthenticated SMTP (a
// private-network relay) is a fully legal configuration; this service only
// covers the case where a real provider needs them. LOOMBRE_SMTP_USERNAME
// + LOOMBRE_SMTP_PASSWORD (both env vars, not in the settings registry —
// see settings-registry.ts's own header on scope:'ui' vs this class of
// A9-keyring-backed secret) win at resolution when BOTH are set and
// non-empty (a lone half-set var is not usable credentials and is treated
// as "not env-configured", falling through to the keyring the same way an
// unset var would).
//
// A9 audit events: every set/clear emits a redacted settings.updated event
// via @loombre/db's emitRedactedSettingsUpdated (key "mail.credentials",
// oldValue/newValue both the '[redacted]' sentinel) — same precedent as
// provider-keys.service.ts, never the real username/password anywhere in
// the payload.

import { Injectable } from "@nestjs/common";
import { detectSecretBackend, removeSecret, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import { emitRedactedSettingsUpdated } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, unprocessableEntity } from "../gateway/problem.exception.js";
import { resolveAppPaths } from "../cli/app-paths.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import type { MailCredentialsStatusDto } from "./settings.types.js";

const SMTP_USERNAME_ENV_VAR = "LOOMBRE_SMTP_USERNAME";
const SMTP_PASSWORD_ENV_VAR = "LOOMBRE_SMTP_PASSWORD";

interface MailCredentialsEnvelope {
  value: string;
  setAtMs: number;
}

interface MailCredentialsPayload {
  username: string;
  password: string;
}

function isMailCredentialsEnvelope(value: unknown): value is MailCredentialsEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).value === "string" &&
    typeof (value as Record<string, unknown>).setAtMs === "number"
  );
}

@Injectable()
export class MailCredentialsService {
  constructor(private readonly dbProvider: DbProvider) {}

  /** Mirrors provider-keys.service.ts's secretKeyFor exactly: file0600's
   *  universal fallback treats `key` as a literal filesystem path, every
   *  other backend treats it as an opaque account-name string. */
  private secretKey(): string {
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return `${dataDir}/secrets/mail-smtp-credentials`;
  }

  private async resolveBackend(): Promise<SecretBackend> {
    const detected = await detectSecretBackend();
    return detected.backend;
  }

  private envConfigured(): boolean {
    const username = process.env[SMTP_USERNAME_ENV_VAR];
    const password = process.env[SMTP_PASSWORD_ENV_VAR];
    return (username?.trim().length ?? 0) > 0 && (password?.trim().length ?? 0) > 0;
  }

  async status(): Promise<MailCredentialsStatusDto> {
    if (this.envConfigured()) {
      return { configured: true, setAtMs: null, source: "env" };
    }

    const backend = await this.resolveBackend();
    const raw = await tryResolveSecret({ backend, key: this.secretKey() });
    if (raw === null) {
      return { configured: false, setAtMs: null, source: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A stored value that isn't valid JSON is unreadable as an envelope
      // — treat it as "not configured" rather than throwing (A4's "never a
      // crash" discipline, same posture as provider-keys.service.ts).
      return { configured: false, setAtMs: null, source: null };
    }
    if (!isMailCredentialsEnvelope(parsed)) {
      return { configured: false, setAtMs: null, source: null };
    }
    return { configured: true, setAtMs: parsed.setAtMs, source: "keyring" };
  }

  async setCredentials(input: {
    username: string;
    password: string;
    actorUserId: string;
    nowMs: number;
    instancePath?: string;
  }): Promise<MailCredentialsStatusDto> {
    const instancePath = input.instancePath ?? "/v1/admin/mail/credentials";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    // F11a precedent (provider-keys.service.ts): an env-sourced credential
    // pair always wins (env precedence) — writing to the keyring underneath
    // it would be accepted but never take effect. Checked BEFORE the
    // empty-field validation below, same ordering as setProviderKey.
    const currentStatus = await this.status();
    if (currentStatus.source === "env") {
      throw conflict(
        `SMTP credentials are currently set by their environment variables (${SMTP_USERNAME_ENV_VAR}/${SMTP_PASSWORD_ENV_VAR}) and cannot be changed through the API. Remove them from the environment and restart to make this editable here.`,
        instancePath,
      );
    }

    const username = input.username.trim();
    // Deliberately NOT trimmed — a password's leading/trailing whitespace
    // may be significant and this endpoint has no way to know it isn't.
    const password = input.password;
    if (username.length === 0 || password.length === 0) {
      throw unprocessableEntity("Username and password must not be empty.", instancePath);
    }

    const backend = await this.resolveBackend();
    const payload: MailCredentialsPayload = { username, password };
    const envelope: MailCredentialsEnvelope = { value: JSON.stringify(payload), setAtMs: input.nowMs };
    await storeSecret(backend, this.secretKey(), JSON.stringify(envelope));

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: "mail.credentials",
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    return this.status();
  }

  async clearCredentials(input: { actorUserId: string; nowMs: number; instancePath?: string }): Promise<MailCredentialsStatusDto> {
    const instancePath = input.instancePath ?? "/v1/admin/mail/credentials";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const backend = await this.resolveBackend();
    await removeSecret({ backend, key: this.secretKey() });

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: "mail.credentials",
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    return this.status();
  }
}
