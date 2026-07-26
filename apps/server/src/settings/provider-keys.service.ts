// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/provider-keys.service.ts
//
// STATE.md Addendum A, decision A9 (backend half — apps/web's UI half is
// lane S2's): TMDB/TVDB provider API keys, stored via the EXISTING
// packages/secrets keyring backend, NEVER in server_settings (A9: keys are
// secrets, not configuration — server_settings has no encryption-at-rest
// story and this addendum does not add one).
//
// Real env vars an operator-set key competes with (A8 precedence: env still
// wins), verified at apps/worker/src/metadata/keys.ts's resolveApiKey call
// sites (apps/worker/src/metadata/providers/tmdb.ts / tvdb.ts):
//   tmdb -> LOOMBRE_TMDB_API_KEY
//   tvdb -> LOOMBRE_TVDB_API_KEY
//
// AD4: the keyring's stored value is a JSON envelope `{value, setAtMs}`,
// not the bare key string, so providerKeyStatus() can report `lastSetMs`
// without a second store. Status/read paths NEVER return or log `value`
// (A9) — providerKeyStatus()'s return type (ProviderKeyStatusDto) has no
// field capable of carrying it at all, by construction, not by convention.
//
// Backend selection: this service always uses detectSecretBackend()'s
// CURRENTLY DETECTED backend, both to store and to read back. Unlike
// packages/secrets/src/jwt-secret.ts's own resolution (which migrates a
// pre-existing file0600 secret to a newly-available native store on
// first boot), this service does NOT implement that migration dance —
// there is no legacy provider-key data anywhere to migrate FROM (this
// addendum is the first thing that ever writes one), so the extra
// complexity was deliberately left out. Documented tradeoff: if an
// instance's detected backend ever CHANGES after a key was stored (e.g. a
// native keyring becomes unavailable), providerKeyStatus() will report
// `set: false` until the key is re-entered — same class of tradeoff
// jwt-secret.ts's own header accepts for the cases it doesn't migrate.
//
// A9 audit events: every set/clear emits a settings.updated-shaped outbox
// event via @loombre/db's emitRedactedSettingsUpdated — key name only
// ('providerKey.<provider>'), the value is NEVER placed in the event
// (redacted sentinel for both oldValue/newValue, matching
// packages/contract/event-schemas/settings.updated.schema.json).
//
// Security review F11a: PUT while the provider's env var is set used to
// silently write a keyring value that providerKeyStatus() would never
// surface (env is checked FIRST and returned on immediately — see that
// method below), because env always wins (A8 precedence, same as
// settings.service.ts's own env-pin). setProviderKey() now 409s instead,
// the SAME shape as settings.service.ts's env-pin conflict — a submitted
// key may be perfectly valid, it simply cannot take effect while the pin
// is active. clearProviderKey() is intentionally NOT given this check:
// removing whatever (if anything) sits inertly in the keyring underneath
// an active env pin is harmless and never changes what providerKeyStatus()
// reports (env still wins either way).

import { Injectable } from "@nestjs/common";
import { detectSecretBackend, removeSecret, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import { emitRedactedSettingsUpdated } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { resolveAppPaths } from "../cli/app-paths.js";
import { requireLiveAdmin } from "./require-live-admin.js";
import type { ProviderKeyStatusDto, ProviderName } from "./settings.types.js";

const PROVIDER_ENV_VAR: Record<ProviderName, string> = {
  tmdb: "LOOMBRE_TMDB_API_KEY",
  tvdb: "LOOMBRE_TVDB_API_KEY",
};

const PROVIDER_NAMES: readonly ProviderName[] = ["tmdb", "tvdb"];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

interface ProviderKeyEnvelope {
  value: string;
  setAtMs: number;
}

function isProviderKeyEnvelope(value: unknown): value is ProviderKeyEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).value === "string" &&
    typeof (value as Record<string, unknown>).setAtMs === "number"
  );
}

@Injectable()
export class ProviderKeysService {
  constructor(private readonly dbProvider: DbProvider) {}

  /** file0600 (packages/secrets's universal fallback) treats its `key`
   *  argument as a literal filesystem path (packages/secrets/src/
   *  jwt-secret.ts's header) — every other backend treats it as an opaque
   *  account-name string, for which an absolute path serves just as well.
   *  Mirrors main.ts's own resolveAndSeedJwtSecret construction exactly:
   *  `<dataDir>/secrets/<stable-name>`. */
  private secretKeyFor(provider: ProviderName): string {
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return `${dataDir}/secrets/provider-key-${provider}`;
  }

  private async resolveBackend(): Promise<SecretBackend> {
    const detected = await detectSecretBackend();
    return detected.backend;
  }

  async providerKeyStatus(provider: ProviderName): Promise<ProviderKeyStatusDto> {
    const envValue = process.env[PROVIDER_ENV_VAR[provider]];
    if (envValue !== undefined && envValue.trim().length > 0) {
      return { provider, set: true, source: "env" };
    }

    const backend = await this.resolveBackend();
    const raw = await tryResolveSecret({ backend, key: this.secretKeyFor(provider) });
    if (raw === null) {
      return { provider, set: false, source: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A stored value that isn't valid JSON is unreadable as an envelope
      // — treat it as "not set" rather than throwing (A4's "never a
      // crash" discipline extends here too), never surfacing the raw text.
      return { provider, set: false, source: null };
    }
    if (!isProviderKeyEnvelope(parsed)) {
      return { provider, set: false, source: null };
    }
    return { provider, set: true, source: "keyring", lastSetMs: parsed.setAtMs };
  }

  async setProviderKey(input: {
    provider: string;
    key: string;
    actorUserId: string;
    nowMs: number;
    instancePath?: string;
  }): Promise<ProviderKeyStatusDto> {
    const instancePath = input.instancePath ?? `/v1/admin/provider-keys/${input.provider}`;
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    if (!isProviderName(input.provider)) {
      throw notFound("Unknown provider.", instancePath);
    }

    // F11a: an env-sourced key always wins (A8 precedence) — writing to the
    // keyring underneath it would be accepted but never take effect, which
    // is exactly the "silently inert write" this finding calls out. Checked
    // BEFORE the empty-key validation below, mirroring settings.service.ts's
    // updateSetting() ordering (env-pin conflict before schema validation):
    // the pin makes the write impossible regardless of whether the
    // submitted value would otherwise be valid.
    const currentStatus = await this.providerKeyStatus(input.provider);
    if (currentStatus.source === "env") {
      const envVar = PROVIDER_ENV_VAR[input.provider];
      throw conflict(
        `This provider key is currently set by its environment variable (${envVar}) and cannot be changed through the API. Remove ${envVar} from the environment and restart to make it editable here.`,
        instancePath,
      );
    }

    const trimmed = input.key.trim();
    if (trimmed.length === 0) {
      throw unprocessableEntity("Provider key must not be empty.", instancePath);
    }

    const backend = await this.resolveBackend();
    const envelope: ProviderKeyEnvelope = { value: trimmed, setAtMs: input.nowMs };
    await storeSecret(backend, this.secretKeyFor(input.provider), JSON.stringify(envelope));

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: `providerKey.${input.provider}`,
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    return this.providerKeyStatus(input.provider);
  }

  async clearProviderKey(input: {
    provider: string;
    actorUserId: string;
    nowMs: number;
    instancePath?: string;
  }): Promise<ProviderKeyStatusDto> {
    const instancePath = input.instancePath ?? `/v1/admin/provider-keys/${input.provider}`;
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    if (!isProviderName(input.provider)) {
      throw notFound("Unknown provider.", instancePath);
    }

    const backend = await this.resolveBackend();
    await removeSecret({ backend, key: this.secretKeyFor(input.provider) });

    await emitRedactedSettingsUpdated(this.dbProvider.db, {
      key: `providerKey.${input.provider}`,
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    return this.providerKeyStatus(input.provider);
  }

  async allProviderKeyStatuses(): Promise<ProviderKeyStatusDto[]> {
    return Promise.all(PROVIDER_NAMES.map((provider) => this.providerKeyStatus(provider)));
  }
}
