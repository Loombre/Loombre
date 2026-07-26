// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-lifecycle.service.ts
//
// Everything about an already-registered plugin that ISN'T the LD6
// registration/re-fetch/re-approval state machine (plugin-registration.service.ts):
// manual admin enable/disable, HMAC rotation (LD1), non-secret config
// updates, and removal (LD9: every keyring entry a plugin owns is removed
// alongside its row — nothing survives).

import { Injectable } from "@nestjs/common";
import { listTopLevelSecretFieldNames, parseLppManifest } from "@loombre/plugin-protocol";
import {
  getPluginById,
  removePluginAndEmit,
  setPluginEnabledAndEmit,
  touchPluginHmacRotatedAndEmit,
  updatePluginConfigAndEmit,
  type PluginRow,
} from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { validatePluginConfig } from "./plugin-config.js";
import { removeAllPluginSecrets, rotatePluginHmac, storePluginConfigSecret } from "./plugin-keyring.js";
import { PluginHealthService } from "./plugin-health.service.js";

@Injectable()
export class PluginLifecycleService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly healthService: PluginHealthService,
  ) {}

  /** Manual admin enable/disable. A plugin currently disabled for
   *  `disabled_reason='scope-change'` cannot be flipped back on through
   *  this path — reapprovePlugin (plugin-registration.service.ts) is the
   *  only door out of that state, since re-enabling blindly would apply
   *  none of the new grant validation that state exists to force. */
  async setEnabled(pluginId: string, enabled: boolean, actorUserId: string, nowMs = Date.now()): Promise<PluginRow> {
    const instancePath = `/plugins/${pluginId}`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    if (enabled && plugin.disabled_reason === "scope-change") {
      throw conflict(
        "This plugin was disabled for a manifest scope change and requires re-approval (reapprovePlugin), not a plain re-enable.",
        instancePath,
      );
    }

    const updated = await setPluginEnabledAndEmit(this.dbProvider.db, {
      pluginId,
      enabled,
      ...(enabled ? {} : { reason: "admin" as const }),
      actorUserId,
      nowMs,
    });

    if (enabled) {
      // LD8: "manual re-enable service method resets the count."
      this.healthService.resetBreaker(pluginId);
    }

    return updated;
  }

  /** LD1: re-mint + return once + plugin.updated event. The new value is
   *  returned by VALUE exactly here — callers must surface it to the admin
   *  immediately; it is never re-readable afterward. */
  async rotateHmac(pluginId: string, actorUserId: string, nowMs = Date.now()): Promise<string> {
    const instancePath = `/plugins/${pluginId}`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    const secret = await rotatePluginHmac(pluginId);
    await touchPluginHmacRotatedAndEmit(this.dbProvider.db, { pluginId, actorUserId, nowMs });
    return secret;
  }

  async updateConfig(pluginId: string, configValues: Record<string, unknown>, actorUserId: string, nowMs = Date.now()): Promise<PluginRow> {
    const instancePath = `/plugins/${pluginId}`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    const parsedManifest = parseLppManifest(plugin.manifest);
    if (!parsedManifest.ok) {
      throw new Error(`updateConfig: the stored manifest for plugin ${pluginId} no longer parses.`);
    }

    const configResult = validatePluginConfig(parsedManifest.manifest.configSchema, configValues);
    if (!configResult.ok) {
      throw unprocessableEntity(`Config validation failed: ${configResult.errors}`, instancePath);
    }

    for (const [fieldName, value] of Object.entries(configResult.secrets)) {
      await storePluginConfigSecret(pluginId, fieldName, value);
    }

    return updatePluginConfigAndEmit(this.dbProvider.db, {
      pluginId,
      config: configResult.nonSecret,
      actorUserId,
      nowMs,
    });
  }

  /** LD9: removes the DB row (plugin_event_grants CASCADE) AND every
   *  keyring entry this plugin owns (the HMAC, every secret config
   *  field) — nothing keyring-side survives a removal. */
  async removePlugin(pluginId: string, actorUserId: string, nowMs = Date.now()): Promise<void> {
    const instancePath = `/plugins/${pluginId}`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    // L-3 fix wave: a stored manifest that no longer parses (e.g. it was
    // written before a frozen-contract narrowing landed, or is simply
    // corrupted) used to fall back to `[]` here, leaving every config
    // secret this plugin ever stored ORPHANED on disk — LD9 says nothing
    // keyring-side survives removal, unconditionally. Fall back to a
    // lenient, shape-only walk of the raw manifest (deriveSecretFieldNamesDefensively)
    // that needs nothing more than `configSchema.properties[key].secret ===
    // true` to still find the field names registerPlugin/updateConfig
    // actually wrote to the keyring.
    const parsedManifest = parseLppManifest(plugin.manifest);
    const secretFieldNames = parsedManifest.ok
      ? listTopLevelSecretFieldNames(parsedManifest.manifest.configSchema)
      : deriveSecretFieldNamesDefensively(plugin.manifest);

    await removePluginAndEmit(this.dbProvider.db, { pluginId, actorUserId, nowMs });
    await removeAllPluginSecrets(pluginId, secretFieldNames);
    this.healthService.removeBreaker(pluginId);
  }
}

/**
 * L-3 fix wave: a lenient, non-throwing, shape-only walk of a RAW (not
 * necessarily `parseLppManifest`-valid) manifest value, looking only for
 * `configSchema.properties[key] = { type: "string", secret: true }` at the
 * TOP level — exactly the shape registerPlugin/updateConfig ever actually
 * route to the keyring (plugin-config.ts's `validatePluginConfig`), so this
 * recovers the real field names even when the manifest fails the full
 * strict parse. Never throws — any unexpected shape along the way simply
 * yields `[]` rather than propagating, so a removal can never be blocked by
 * this best-effort recovery attempt.
 */
export function deriveSecretFieldNamesDefensively(manifest: unknown): string[] {
  try {
    if (manifest === null || typeof manifest !== "object") return [];
    const configSchema = (manifest as { configSchema?: unknown }).configSchema;
    if (configSchema === null || typeof configSchema !== "object") return [];
    const properties = (configSchema as { properties?: unknown }).properties;
    if (properties === null || typeof properties !== "object") return [];
    const names: string[] = [];
    for (const [key, field] of Object.entries(properties as Record<string, unknown>)) {
      if (field !== null && typeof field === "object" && (field as { type?: unknown }).type === "string" && (field as { secret?: unknown }).secret === true) {
        names.push(key);
      }
    }
    return names;
  } catch {
    return [];
  }
}
