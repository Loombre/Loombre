// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-registration.service.ts
//
// LD6's registration state machine, and its re-fetch/re-approval siblings:
//
//   registerPlugin:  validateUrl -> hardenedFetch manifest -> staged parse
//                     (unknown-capability-type => typed rejection) ->
//                     validate requested eventTypes against the outbox
//                     taxonomy -> caller-supplied GRANTED subset (capability
//                     set <= declared, event grants <= requested) + config
//                     values -> ajv config validation -> non-secret config
//                     to plugins.config, secret fields to keyring -> HMAC
//                     minted + returned once -> per-capability health check
//                     (LD7, via PluginHealthService) -> row committed
//                     enabled with granted scope + plugin.registered.
//
//   refreshPlugin:   fetch current manifest, diff vs the stored snapshot
//                     (manifest-diff.ts's diffManifestForExpansion) -> ANY
//                     expansion auto-disables (reason='scope-change') and
//                     leaves the STORED snapshot untouched (so
//                     reapprovePlugin has something meaningful to
//                     "accept"); a non-expanding diff updates the snapshot
//                     (narrowed grants applied automatically) +
//                     plugin.updated.
//
//   reapprovePlugin: re-fetches the manifest fresh (time may have passed
//                     since the scope-change was detected), validates the
//                     CALLER's newly-supplied grant against it exactly like
//                     registration does, and re-enables.
//
// Every user-facing rejection is a ProblemException (mirrors
// apps/server/src/settings/provider-keys.service.ts's own pattern of
// throwing 409/422/404 directly from the service layer, ahead of any
// controller — W5's controllers just let these propagate through Nest's
// existing exception filter).

import { Injectable } from "@nestjs/common";
import { uuidv7 } from "@loombre/shared";
import {
  describeFetchManifestFailure,
  fetchPluginManifest,
} from "@loombre/plugin-host";
import {
  describeLppManifestParseFailure,
  parseLppManifest,
  type LppEventSubscriberCapability,
  type LppManifest,
} from "@loombre/plugin-protocol";
import {
  getPluginByBaseUrl,
  getPluginById,
  getPluginEventGrants,
  insertPluginAndEmit,
  reapprovePluginAndEmit,
  setPluginEnabledAndEmit,
  updatePluginManifestAndEmit,
  type PluginEventGrantRow,
  type PluginRow,
} from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { getOutboxEventTaxonomy } from "./event-taxonomy.js";
import { validatePluginConfig } from "./plugin-config.js";
import { mintPluginHmac, removeAllPluginSecrets, storePluginConfigSecret } from "./plugin-keyring.js";
import { computeAggregateContentClass, diffManifestForExpansion } from "./manifest-diff.js";
import { computeManifestDigest } from "./manifest-digest.js";
import { PluginHealthService } from "./plugin-health.service.js";

export interface PluginGrantInput {
  /** Subset of the manifest's declared capability `type` values to enable
   *  (LD6 "capability set <= declared"). */
  grantedCapabilityTypes: string[];
  /** Subset of the union of every event-subscriber capability's requested
   *  `eventTypes` to actually grant (LD6 "event grants <= requested"). */
  eventTypeGrants: string[];
  /** C-2 fix wave: the `manifestDigest` a prior `POST /admin/plugins/preview`
   *  returned for this exact manifest. ENFORCED as required by
   *  registerPlugin/reapprovePlugin (a 422 if absent) even though the wire
   *  DTOs keep it schema-optional for additivity — see admin-plugin-dto.ts. */
  manifestDigest?: string;
}

export interface RegisterPluginRequest extends PluginGrantInput {
  baseUrl: string;
  /** Explicit hosts (LD5) — defaults to none. */
  lanAllowlist?: string[];
  /** Raw submitted values keyed by configSchema property name, BOTH secret
   *  and non-secret fields together — split internally (plugin-config.ts). */
  configValues: Record<string, unknown>;
  actorUserId: string;
}

export interface RegisterPluginOutcome {
  plugin: PluginRow;
  eventGrants: PluginEventGrantRow[];
  /** LD1: the delivery-signing HMAC, returned by VALUE exactly once. */
  hmacSecret: string;
}

export interface RefreshPluginOutcome {
  plugin: PluginRow;
  expanded: boolean;
  reasons: string[];
}

/**
 * C-2 fix wave: the choke point every register/reapprove call routes
 * through after its OWN fresh manifest fetch. Requires `expectedDigest` to
 * be present (a caller that skipped `POST /admin/plugins/preview` gets a
 * 422, not a silent bypass) and to match `computeManifestDigest(manifest)`
 * exactly (a mismatch — the plugin served different bytes to preview vs.
 * register/reapprove — is a 409, forcing the admin back through preview
 * before this manifest can be approved).
 */
function assertManifestDigestMatches(manifest: LppManifest, expectedDigest: string | undefined, instancePath: string): void {
  if (!expectedDigest) {
    throw unprocessableEntity(
      "manifestDigest is required — preview this plugin (POST /admin/plugins/preview) before registering/re-approving it.",
      instancePath,
    );
  }
  const actualDigest = computeManifestDigest(manifest);
  if (actualDigest !== expectedDigest) {
    throw conflict(
      "This plugin's manifest changed since it was last previewed — preview it again and confirm the new manifest before proceeding.",
      instancePath,
    );
  }
}

/** The one 409 registration can reach two ways: the pre-check below, and
 *  the losing side of a concurrent register() for the same origin. */
function baseUrlAlreadyRegistered(baseUrl: string, instancePath: string): never {
  throw conflict(
    `A plugin is already registered at ${baseUrl}. Use the refresh/re-approval flow instead of registering again.`,
    instancePath,
  );
}

/** The base_url pre-check and the insert run in different transactions with
 *  a manifest fetch between them, so two concurrent register() calls for the
 *  same origin both pass the pre-check and the loser is stopped only by
 *  plugins_base_url_unique (packages/db/migrations/0014_plugins.sql). Matched
 *  by constraint NAME, never by code alone: the same transaction also inserts
 *  plugin_event_grants, whose own unique violations must stay internal
 *  errors rather than a misleading "already registered". */
function isBaseUrlUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === "plugins_base_url_unique";
}

function validateBaseUrl(baseUrl: string, instancePath: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw unprocessableEntity("baseUrl must be an absolute URL.", instancePath);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw unprocessableEntity("baseUrl must use the http or https scheme.", instancePath);
  }
  return parsed;
}

@Injectable()
export class PluginRegistrationService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly healthService: PluginHealthService,
  ) {}

  /** Throws on any invalid grant; returns the union of eventTypes any
   *  event-subscriber capability in `manifest` requests (used by both
   *  registerPlugin and reapprovePlugin, and by the caller to sanity-check
   *  the taxonomy independent of what's actually granted). */
  private validateGrantAgainstManifest(manifest: LppManifest, grant: PluginGrantInput, instancePath: string): string[] {
    if (grant.grantedCapabilityTypes.length === 0) {
      throw unprocessableEntity("At least one capability must be granted.", instancePath);
    }

    const declaredCapabilityTypes: string[] = manifest.capabilities.map((c) => c.type);
    const unknownGranted = grant.grantedCapabilityTypes.filter((t) => !declaredCapabilityTypes.includes(t));
    if (unknownGranted.length > 0) {
      throw unprocessableEntity(
        `grantedCapabilityTypes includes type(s) the manifest does not declare: ${unknownGranted.join(", ")}`,
        instancePath,
      );
    }

    const eventSubscriberCapabilities = manifest.capabilities.filter(
      (c): c is LppEventSubscriberCapability => c.type === "event-subscriber",
    );
    const requestedEventTypes = [...new Set(eventSubscriberCapabilities.flatMap((c) => c.eventTypes))];
    const taxonomy = new Set(getOutboxEventTaxonomy());
    const untaxonomized = requestedEventTypes.filter((t) => !taxonomy.has(t));
    if (untaxonomized.length > 0) {
      throw unprocessableEntity(
        `This plugin's manifest requests event type(s) Loombre does not publish: ${untaxonomized.join(", ")}`,
        instancePath,
      );
    }

    if (!grant.grantedCapabilityTypes.includes("event-subscriber") && grant.eventTypeGrants.length > 0) {
      throw unprocessableEntity("eventTypeGrants were supplied without granting the event-subscriber capability.", instancePath);
    }
    const invalidGrants = grant.eventTypeGrants.filter((t) => !requestedEventTypes.includes(t));
    if (invalidGrants.length > 0) {
      throw unprocessableEntity(
        `eventTypeGrants includes type(s) not requested by the manifest: ${invalidGrants.join(", ")}`,
        instancePath,
      );
    }

    return requestedEventTypes;
  }

  async registerPlugin(input: RegisterPluginRequest, nowMs = Date.now()): Promise<RegisterPluginOutcome> {
    const instancePath = "/plugins";
    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const parsedUrl = validateBaseUrl(input.baseUrl, instancePath);
    const baseUrl = parsedUrl.origin;

    const existing = await getPluginByBaseUrl(this.dbProvider.db, baseUrl);
    if (existing) baseUrlAlreadyRegistered(baseUrl, instancePath);

    const lanAllowlist = input.lanAllowlist ?? [];
    const manifestResult = await fetchPluginManifest(baseUrl, { lanAllowlist });
    if (!manifestResult.ok) {
      throw unprocessableEntity(describeFetchManifestFailure(manifestResult), instancePath);
    }
    const { manifest, raw } = manifestResult;

    // C-2 fix wave: prove this fetch is byte-for-byte (structurally)
    // identical to whatever manifest the admin's confirmation screen
    // rendered via POST /admin/plugins/preview — see
    // assertManifestDigestMatches's doc comment. MUST run before any grant
    // validation/config split below, which are otherwise exactly the two
    // TOCTOU escalations C-2 documented (content-class escalation,
    // secret-downgrade-to-plaintext).
    assertManifestDigestMatches(manifest, input.manifestDigest, instancePath);

    this.validateGrantAgainstManifest(manifest, input, instancePath);
    const contentClass = computeAggregateContentClass(manifest, input.grantedCapabilityTypes);

    // H-1 note: secret/non-secret resolution below is against THIS fetch's
    // manifest.configSchema — which the digest check above just proved is
    // identical to the schema the admin was shown at preview time, so this
    // satisfies C-2's "resolve secret/non-secret against the APPROVED
    // schema" without threading the preview-time object across two
    // unrelated HTTP requests.
    const configResult = validatePluginConfig(manifest.configSchema, input.configValues);
    if (!configResult.ok) {
      throw unprocessableEntity(`Config validation failed: ${configResult.errors}`, instancePath);
    }

    const pluginId = uuidv7(nowMs);
    const hmacSecret = await mintPluginHmac(pluginId);
    const secretFieldNames = Object.keys(configResult.secrets);
    for (const [fieldName, value] of Object.entries(configResult.secrets)) {
      await storePluginConfigSecret(pluginId, fieldName, value);
    }

    // L-2 fix wave: an insert failure must not orphan keyring material
    // under a pluginId no row will ever reference — roll the HMAC/secrets
    // back on ANY failure from the row insert itself.
    let inserted: { plugin: PluginRow; eventGrants: PluginEventGrantRow[] };
    try {
      inserted = await insertPluginAndEmit(this.dbProvider.db, {
        id: pluginId,
        name: manifest.name,
        baseUrl,
        version: manifest.version,
        protocolVersion: manifest.protocolVersion,
        contentClass,
        grantedCapabilityTypes: input.grantedCapabilityTypes,
        eventTypes: input.eventTypeGrants,
        lanAllowlist,
        manifest: raw as Record<string, unknown>,
        config: configResult.nonSecret,
        actorUserId: input.actorUserId,
        nowMs,
      });
    } catch (err) {
      await removeAllPluginSecrets(pluginId, secretFieldNames);
      if (isBaseUrlUniqueViolation(err)) baseUrlAlreadyRegistered(baseUrl, instancePath);
      throw err;
    }
    const { plugin, eventGrants } = inserted;

    const healthChecked = await this.healthService.runHealthCheck(plugin.id, nowMs);

    return { plugin: healthChecked, eventGrants, hmacSecret };
  }

  async refreshPlugin(pluginId: string, actorUserId: string | null, nowMs = Date.now()): Promise<RefreshPluginOutcome> {
    const instancePath = `/plugins/${pluginId}`;
    if (actorUserId) await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    const breaker = this.healthService.getBreaker(pluginId);
    const manifestResult = await fetchPluginManifest(plugin.base_url, {
      lanAllowlist: plugin.lan_allowlist,
      breaker,
      clock: () => nowMs,
    });
    if (!manifestResult.ok) {
      throw unprocessableEntity(describeFetchManifestFailure(manifestResult), instancePath);
    }
    const { manifest: newManifest, raw: newRaw } = manifestResult;

    const oldManifestParsed = parseLppManifest(plugin.manifest);
    if (!oldManifestParsed.ok) {
      throw new Error(
        `refreshPlugin: the STORED manifest snapshot for plugin ${pluginId} no longer parses (this should be impossible — it was validated at write time): ${describeLppManifestParseFailure(oldManifestParsed)}`,
      );
    }

    const eventGrantRows = await getPluginEventGrants(this.dbProvider.db, pluginId);
    const diff = diffManifestForExpansion(
      oldManifestParsed.manifest,
      newManifest,
      plugin.granted_capability_types,
      eventGrantRows.map((r) => r.event_type),
    );

    if (diff.expanded) {
      const updated = await setPluginEnabledAndEmit(this.dbProvider.db, {
        pluginId,
        enabled: false,
        reason: "scope-change",
        actorUserId,
        nowMs,
      });
      return { plugin: updated, expanded: true, reasons: diff.reasons };
    }

    const contentClass = computeAggregateContentClass(newManifest, diff.narrowedGrantedCapabilityTypes);
    const { plugin: updated } = await updatePluginManifestAndEmit(this.dbProvider.db, {
      pluginId,
      manifest: newRaw as Record<string, unknown>,
      version: newManifest.version,
      protocolVersion: newManifest.protocolVersion,
      contentClass,
      grantedCapabilityTypes: diff.narrowedGrantedCapabilityTypes,
      eventTypes: diff.narrowedEventGrants,
      actorUserId,
      nowMs,
    });

    return { plugin: updated, expanded: false, reasons: [] };
  }

  async reapprovePlugin(pluginId: string, grant: PluginGrantInput, actorUserId: string, nowMs = Date.now()): Promise<PluginRow> {
    const instancePath = `/plugins/${pluginId}`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);
    if (plugin.disabled_reason !== "scope-change") {
      throw conflict("This plugin is not currently awaiting scope-change re-approval.", instancePath);
    }

    const breaker = this.healthService.getBreaker(pluginId);
    const manifestResult = await fetchPluginManifest(plugin.base_url, {
      lanAllowlist: plugin.lan_allowlist,
      breaker,
      clock: () => nowMs,
    });
    if (!manifestResult.ok) {
      throw unprocessableEntity(describeFetchManifestFailure(manifestResult), instancePath);
    }
    const { manifest, raw } = manifestResult;

    // C-2 fix wave — see registerPlugin's identical call for the full
    // rationale; the re-approval flow has the SAME preview (POST
    // /admin/plugins/preview) -> confirm -> reapprove TOCTOU shape.
    assertManifestDigestMatches(manifest, grant.manifestDigest, instancePath);

    this.validateGrantAgainstManifest(manifest, grant, instancePath);
    const contentClass = computeAggregateContentClass(manifest, grant.grantedCapabilityTypes);

    await reapprovePluginAndEmit(this.dbProvider.db, {
      pluginId,
      manifest: raw as Record<string, unknown>,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      contentClass,
      grantedCapabilityTypes: grant.grantedCapabilityTypes,
      eventTypes: grant.eventTypeGrants,
      actorUserId,
      nowMs,
    });

    breaker.reset();
    return this.healthService.runHealthCheck(pluginId, nowMs);
  }
}
