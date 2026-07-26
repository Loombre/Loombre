// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugin-pseudonymization.service.ts
//
// Lane W5b: PUT /admin/plugins/{id}/pseudonymization's logic — the admin
// toggle for plugins.pseudonymize_actor_ids (LPP v1 mission §3.2, default
// TRUE, migrations/0016_plugin_delivery_cursors.sql). Thin by design,
// mirroring AdminPluginGrantsService's shape exactly: requireLiveAdmin ->
// plugin lookup (404) -> the SAME "event-subscriber capability must
// currently be granted" 409 guard updateAdminPluginEventGrants uses (this
// setting has nothing to act on for a plugin that never receives the
// activity feed) -> body validation (422) -> the real DB write
// (setPluginPseudonymizationAndEmit, packages/db/src/query/plugins.ts).

import { Injectable } from "@nestjs/common";
import { getPluginById, setPluginPseudonymizationAndEmit, type PluginRow } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../settings/require-live-admin.js";

@Injectable()
export class AdminPluginPseudonymizationService {
  constructor(private readonly dbProvider: DbProvider) {}

  async setPseudonymization(pluginId: string, rawEnabled: unknown, actorUserId: string, nowMs = Date.now()): Promise<PluginRow> {
    const instancePath = `/admin/plugins/${pluginId}/pseudonymization`;
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", instancePath);

    if (!plugin.granted_capability_types.includes("event-subscriber")) {
      throw conflict("This plugin's event-subscriber capability is not currently granted.", instancePath);
    }

    if (typeof rawEnabled !== "boolean") {
      throw unprocessableEntity("enabled (boolean) is required.", instancePath);
    }

    return setPluginPseudonymizationAndEmit(this.dbProvider.db, {
      pluginId,
      enabled: rawEnabled,
      actorUserId,
      nowMs,
    });
  }
}
