// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-library-provider-chain-dto.ts
//
// Lane W5b: wire shapes for GET/PUT /admin/libraries/{id}/provider-chain
// (packages/contract/openapi.yaml's AdminLibraryProviderChain schema),
// mirroring admin-plugin-dto.ts's own "hand-written DTO, structurally
// checked by tsc, verified against the contract by e2e" convention exactly.

import type { ContentClass, LibraryProviderEntryRow, LibraryProviderKind, PluginHealthState, PluginRow } from "@loombre/db";

export interface AdminLibraryProviderChainPluginRefDto {
  id: string;
  name: string;
  enabled: boolean;
  healthState: PluginHealthState;
  contentClass: ContentClass;
}

export interface AdminLibraryProviderChainEntryDto {
  position: number;
  providerKind: LibraryProviderKind;
  builtinName: string | null;
  pluginId: string | null;
  plugin: AdminLibraryProviderChainPluginRefDto | null;
}

export interface AdminLibraryProviderChainDto {
  libraryId: string;
  isDefault: boolean;
  entries: AdminLibraryProviderChainEntryDto[];
  eligiblePlugins: AdminLibraryProviderChainPluginRefDto[];
  builtinProviderNames: string[];
}

export function toPluginRefDto(plugin: PluginRow): AdminLibraryProviderChainPluginRefDto {
  return {
    id: plugin.id,
    name: plugin.name,
    enabled: plugin.enabled,
    healthState: plugin.health_state,
    contentClass: plugin.content_class,
  };
}

/** Resolves one persisted library_provider_entries row into its display
 *  shape — `pluginById` is the FULL (not eligibility-filtered) plugin map,
 *  so a chain entry whose referenced plugin's contentClass has since
 *  drifted away from the library's (possible via refreshAdminPlugin/
 *  reapproveAdminPlugin re-scoping a plugin after it was already chained —
 *  the OTHER two layers of the mission's three-layer C5 defense-in-depth
 *  still refuse to actually USE it at resolution/adapter-construction time)
 *  still resolves to real, current display data rather than silently
 *  showing `plugin: null` for a plugin that in fact still exists. */
export function toChainEntryDto(row: LibraryProviderEntryRow, pluginById: ReadonlyMap<string, PluginRow>): AdminLibraryProviderChainEntryDto {
  const plugin = row.plugin_id ? (pluginById.get(row.plugin_id) ?? null) : null;
  return {
    position: row.position,
    providerKind: row.provider_kind,
    builtinName: row.builtin_name,
    pluginId: row.plugin_id,
    plugin: plugin ? toPluginRefDto(plugin) : null,
  };
}

export function toDefaultChainEntryDto(builtinName: string, position: number): AdminLibraryProviderChainEntryDto {
  return { position, providerKind: "builtin", builtinName, pluginId: null, plugin: null };
}
