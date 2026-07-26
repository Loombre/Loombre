// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugin-grants.service.ts
//
// Lane W5: PUT /admin/plugins/{id}/event-grants's logic.
//
// Lane W5b closes the thin-controller gap Lane W5's header used to document
// here (W2 had no narrow "replace this plugin's event-type grants only,
// leave everything else untouched" DB primitive, so this used to borrow
// updatePluginManifestAndEmit with the plugin's stored manifest/version/
// protocolVersion/contentClass/grantedCapabilityTypes passed through
// unchanged — that performed the correct plugin_event_grants delete+
// reinsert, but its plugin.updated audit event necessarily carried
// `change: 'manifest'` with oldValue===newValue, both the unchanged version
// string). This now calls the dedicated updatePluginEventGrantsAndEmit
// (packages/db/src/query/plugins.ts), which replaces ONLY the
// plugin_event_grants rows and emits plugin.updated with an honest
// change='event-grants' (oldValue/newValue = the granted event `type`
// arrays before/after, each sorted ascending).

import { Injectable } from "@nestjs/common";
import { parseLppManifest, type LppEventSubscriberCapability } from "@loombre/plugin-protocol";
import { getPluginById, updatePluginEventGrantsAndEmit, type PluginRow } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../settings/require-live-admin.js";

@Injectable()
export class AdminPluginGrantsService {
  constructor(private readonly dbProvider: DbProvider) {}

  async setEventGrants(
    pluginId: string,
    eventTypeGrants: string[],
    actorUserId: string,
    nowMs = Date.now(),
  ): Promise<PluginRow> {
    const instancePath = `/admin/plugins/${pluginId}/event-grants`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    if (!plugin.granted_capability_types.includes("event-subscriber")) {
      throw conflict("This plugin's event-subscriber capability is not currently granted.", instancePath);
    }

    const parsedManifest = parseLppManifest(plugin.manifest);
    if (!parsedManifest.ok) {
      throw new Error(`setEventGrants: the stored manifest for plugin ${pluginId} no longer parses.`);
    }

    const eventSubscriberCap = parsedManifest.manifest.capabilities.find(
      (c): c is LppEventSubscriberCapability => c.type === "event-subscriber",
    );
    const requested = eventSubscriberCap?.eventTypes ?? [];
    const invalid = eventTypeGrants.filter((t) => !requested.includes(t));
    if (invalid.length > 0) {
      throw unprocessableEntity(
        `eventTypeGrants includes type(s) not requested by the manifest: ${invalid.join(", ")}`,
        instancePath,
      );
    }

    const { plugin: updated } = await updatePluginEventGrantsAndEmit(this.dbProvider.db, {
      pluginId,
      eventTypes: eventTypeGrants,
      actorUserId,
      nowMs,
    });

    return updated;
  }
}
