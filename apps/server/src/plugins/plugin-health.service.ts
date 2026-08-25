// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-health.service.ts
//
// LD7/LD8: health WITHOUT wire amendments (the frozen spec has no ping) —
//   - envelope health = manifest fetch + parse + name/protocolVersion
//     consistency vs the stored snapshot.
//   - metadata-provider capability health = a benign canary search POST
//     through callPlugin (2xx + schema-valid LppSearchResponse; empty
//     results is healthy).
//   - event-subscriber capability health (registration-time AND every
//     subsequent check, since this lane owns no operational delivery
//     tracking) = delivery-endpoint SSRF/allowlist validation +
//     well-formedness ONLY, no actual POST — "operational delivery health
//     is W4's", per the mission text; this lane's contribution is the
//     shared substrate (plugins.health_state/consecutive_failures columns
//     + plugin.health-changed) W4 can layer its own richer signal onto
//     later via the SAME setPluginHealthAndEmit path.
//
// ONE PluginCircuitBreaker instance per plugin, held in-memory for this
// process's lifetime (LD2: the breaker class itself is pure/DB-free;
// OWNING an instance per plugin and persisting the durable counter is this
// service's job, not plugin-host's — see breaker.ts's header for the
// accepted "a process restart resets in-memory breaker state" tradeoff).
// The SAME breaker instance gates: (a) this service's own manifest+canary
// health-check calls, and (b) — once W3/W4 land — their capability calls,
// via getBreaker(pluginId), so a plugin failing in ANY call path
// contributes to the SAME 5-consecutive-failure count (LD8: "gates ALL
// capability calls uniformly").

import { Injectable } from "@nestjs/common";
import {
  callPlugin,
  fetchPluginManifest,
  LPP_BREAKER_FAILURE_THRESHOLD,
  LPP_CAPABILITY_MAX_RESPONSE_BYTES,
  LPP_SEARCH_TIMEOUT_MS,
  PluginCircuitBreaker,
  assertHostAllowed,
  buildPluginRequestHeaders,
  type PluginBreakerSeed,
} from "@loombre/plugin-host";
import {
  LppSearchResponseSchema,
  listTopLevelSecretFieldNames,
  parseLppManifest,
  type LppManifest,
  type LppMetadataProviderCapability,
} from "@loombre/plugin-protocol";
import {
  getPluginById,
  setPluginEnabledAndEmit,
  setPluginHealthAndEmit,
  type PluginHealthState,
  type PluginRow,
} from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { notFound } from "../gateway/problem.exception.js";
import { resolveAllPluginConfigSecrets } from "./plugin-keyring.js";

/** Deterministic, obviously-fake title — never expected to match a real
 *  catalog title, so a plugin's canary response is exercised without this
 *  producing anything an admin would mistake for a real search. */
const HEALTH_CANARY_TITLE = "Loombre LPP Health Check";

@Injectable()
export class PluginHealthService {
  private readonly breakers = new Map<string, PluginCircuitBreaker>();

  constructor(private readonly dbProvider: DbProvider) {}

  /** Lazily creates one breaker per plugin id — the SAME instance every
   *  call site (this service, and eventually W3/W4's capability callers)
   *  must fetch through this method rather than constructing its own.
   *
   *  C5.1 (closes deferred LPP L-5): `seed`, when given, is used ONLY on
   *  the FIRST construction for a given pluginId in this process's
   *  lifetime — which, since breakers are constructed lazily rather than
   *  eagerly at process start, is effectively "at boot" for whichever
   *  caller happens to touch this plugin first (runHealthCheck via the
   *  health scheduler, most commonly). Every caller below that already has
   *  the plugin's row in hand passes `{ consecutiveFailures:
   *  plugin.consecutive_failures, atMs: nowMs }` — see breaker.ts's own
   *  header for why an un-reseeded breaker doesn't just forget locally, it
   *  corrupts the durable counter on its next write. A call site with no
   *  seed to offer (e.g. resetBreaker, which force-resets immediately
   *  after) simply gets the unseeded default, matching prior behavior. */
  getBreaker(pluginId: string, seed?: PluginBreakerSeed): PluginCircuitBreaker {
    let breaker = this.breakers.get(pluginId);
    if (!breaker) {
      breaker = new PluginCircuitBreaker(seed ? { seed } : {});
      this.breakers.set(pluginId, breaker);
    }
    return breaker;
  }

  /** LD8 "manual re-enable service method resets the count" — called by
   *  the lifecycle service alongside its own DB write. */
  resetBreaker(pluginId: string): void {
    this.getBreaker(pluginId).reset();
  }

  /** Called when a plugin row is removed — no reason to keep its breaker
   *  (or let it grow the map forever across many register/remove cycles). */
  removeBreaker(pluginId: string): void {
    this.breakers.delete(pluginId);
  }

  /**
   * Runs the full LD7 check (envelope + every granted capability's static
   * check) against the plugin's CURRENT row, persists the outcome
   * (health_state transition, consecutive_failures, last_*_ms), and — if
   * this check's failure crosses LPP_BREAKER_FAILURE_THRESHOLD on an
   * ENABLED plugin — auto-disables it (LD8: enabled=false,
   * disabled_reason='breaker', plugin.disabled + plugin.health-changed).
   * Returns the final row (post auto-disable, if that happened).
   */
  async runHealthCheck(
    pluginId: string,
    nowMs = Date.now(),
    opts: { manifestTimeoutMs?: number; searchTimeoutMs?: number } = {},
  ): Promise<PluginRow> {
    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    // d3-b7: the plugin RESOURCE path (`/admin/plugins/{id}`, the surface
    // this server actually mounts — never the unmounted `/plugins/{id}`
    // this used to echo). Deliberately the resource rather than one route:
    // three callers reach this line — registerPlugin (POST /admin/plugins),
    // refreshPlugin (POST /admin/plugins/{id}/refresh) and
    // plugin-health-scheduler.service.ts, which has no request at all — so
    // no single request path is the truthful answer for all of them.
    if (!plugin) throw notFound("Plugin not found.", `/admin/plugins/${pluginId}`);

    // C5.1: seed from the row JUST fetched — the durable count as of right
    // now, not stale.
    const breaker = this.getBreaker(pluginId, { consecutiveFailures: plugin.consecutive_failures, atMs: nowMs });
    const manifestResult = await fetchPluginManifest(plugin.base_url, {
      lanAllowlist: plugin.lan_allowlist,
      breaker,
      clock: () => nowMs,
      ...(opts.manifestTimeoutMs !== undefined ? { timeoutMs: opts.manifestTimeoutMs } : {}),
    });

    let ok = false;
    if (manifestResult.ok) {
      const envelopeConsistent =
        manifestResult.manifest.name === plugin.name && manifestResult.manifest.protocolVersion === plugin.protocol_version;
      ok =
        envelopeConsistent &&
        (await this.checkGrantedCapabilities(plugin, manifestResult.manifest, breaker, nowMs, opts.searchTimeoutMs));
    }

    const snapshot = breaker.snapshot();
    const healthState: PluginHealthState = ok ? "healthy" : "unhealthy";

    const updated = await setPluginHealthAndEmit(this.dbProvider.db, {
      pluginId,
      healthState,
      consecutiveFailures: snapshot.consecutiveFailures,
      ok,
      checkedAtMs: nowMs,
    });

    if (!ok && updated.enabled && snapshot.state === "open" && snapshot.consecutiveFailures >= LPP_BREAKER_FAILURE_THRESHOLD) {
      return setPluginEnabledAndEmit(this.dbProvider.db, {
        pluginId,
        enabled: false,
        reason: "breaker",
        actorUserId: null,
        nowMs,
      });
    }

    return updated;
  }

  private async checkGrantedCapabilities(
    plugin: PluginRow,
    manifest: LppManifest,
    breaker: PluginCircuitBreaker,
    nowMs: number,
    searchTimeoutMs?: number,
  ): Promise<boolean> {
    for (const capabilityType of plugin.granted_capability_types) {
      const capability = manifest.capabilities.find((c) => c.type === capabilityType);
      if (!capability) {
        // The live manifest no longer declares a capability this row is
        // granted for — a real behavioral change worth surfacing as
        // unhealthy. Distinct from LD6's expansion diff (which the
        // registration service's refresh flow owns for the DISABLE
        // decision); this is purely the health signal.
        return false;
      }
      if (capability.type === "metadata-provider") {
        if (!(await this.checkMetadataProviderCanary(plugin, capability, breaker, nowMs, searchTimeoutMs))) return false;
      } else if (capability.type === "event-subscriber") {
        if (!(await this.checkEventSubscriberDelivery(plugin, capability.delivery.endpoint))) return false;
      }
    }
    return true;
  }

  private async buildRequestHeaders(plugin: PluginRow): Promise<Record<string, string>> {
    const parsedManifest = parseLppManifest(plugin.manifest);
    const secretFieldNames = parsedManifest.ok ? listTopLevelSecretFieldNames(parsedManifest.manifest.configSchema) : [];
    const secrets = await resolveAllPluginConfigSecrets(plugin.id, secretFieldNames);
    return buildPluginRequestHeaders(plugin.config as Record<string, unknown>, secrets);
  }

  private async checkMetadataProviderCanary(
    plugin: PluginRow,
    capability: LppMetadataProviderCapability,
    breaker: PluginCircuitBreaker,
    nowMs: number,
    searchTimeoutMs?: number,
  ): Promise<boolean> {
    const url = new URL(capability.endpoints.search, plugin.base_url).toString();
    const headers = await this.buildRequestHeaders(plugin);
    const body = JSON.stringify({ mediaKind: capability.mediaKinds[0] ?? "movie", title: HEALTH_CANARY_TITLE });

    const result = await callPlugin(
      url,
      { method: "POST", body },
      {
        timeoutMs: searchTimeoutMs ?? LPP_SEARCH_TIMEOUT_MS,
        maxResponseBytes: LPP_CAPABILITY_MAX_RESPONSE_BYTES,
        lanAllowlist: plugin.lan_allowlist,
        breaker,
        clock: () => nowMs,
        headers,
      },
    );
    if (!result.ok || result.status < 200 || result.status >= 300) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.bodyText);
    } catch {
      return false;
    }
    // Empty `results` is healthy — this is a schema-shape canary, not a
    // "does this title exist" check.
    return LppSearchResponseSchema.safeParse(parsed).success;
  }

  private async checkEventSubscriberDelivery(plugin: PluginRow, deliveryEndpoint: string): Promise<boolean> {
    try {
      const deliveryUrl = new URL(deliveryEndpoint, plugin.base_url);
      await assertHostAllowed(deliveryUrl.hostname, plugin.lan_allowlist);
      return true;
    } catch {
      return false;
    }
  }
}
