// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-library-provider-chain.service.ts
//
// Lane W5b: GET/PUT /admin/libraries/{id}/provider-chain's logic, around
// Lane W3's packages/db/src/query/library-provider-chains.ts
// (getLibraryProviderChain / replaceLibraryProviderChain — that module's
// own header names this exact surface as its intended future caller).
// Lives under apps/server/src/plugins/ (not apps/server/src/catalog/,
// where LibrariesController's OTHER /libraries/{id}/* routes live) because
// this surface is plugin-shaped through and through — it needs the plugin
// registry for eligibility filtering, uses requireLiveAdmin (Lane W5's
// admin-plugins hardening, unlike LibrariesController's own still-JWT-claim
// requireAdmin()), and is mounted in admin-plugins.module.ts alongside
// every other Lane W5/W5b admin-plugins-area controller.
//
// Ordering mirrors apps/server/src/catalog/libraries.controller.ts's own
// putLibraryPermissions precedent exactly: library existence is checked
// BEFORE the request body is validated (404 wins over 422 for a
// placeholder/bodyless request), then entry-shape/unknown-builtin/unknown-
// plugin/C5-scope validation runs, in that order — the first two are this
// service's OWN job (packages/db has no knowledge of the built-in registry,
// see builtin-metadata-providers.ts's header), the last two are
// replaceLibraryProviderChain's.

import { Injectable } from "@nestjs/common";
import {
  getLibraryByIdAdmin,
  getLibraryProviderChain,
  listPlugins,
  replaceLibraryProviderChain,
  InvalidLibraryProviderEntryError,
  LibraryNotFoundError,
  LibraryProviderChainScopeError,
  PluginNotFoundError,
  type LibraryProviderChainEntryInput,
  type LibraryProviderEntryRow,
  type LibraryRow,
  type PluginRow,
} from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../settings/require-live-admin.js";
import { KNOWN_BUILTIN_PROVIDER_NAMES, LEGACY_DEFAULT_PROVIDER_CHAIN, isKnownBuiltinProviderName } from "./builtin-metadata-providers.js";
import { toChainEntryDto, toDefaultChainEntryDto, toPluginRefDto, type AdminLibraryProviderChainDto } from "./admin-library-provider-chain-dto.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Injectable()
export class AdminLibraryProviderChainService {
  constructor(private readonly dbProvider: DbProvider) {}

  private instancePath(libraryId: string): string {
    return `/admin/libraries/${libraryId}/provider-chain`;
  }

  /** entries[] validation this service owns (see file header — the two
   *  checks packages/db's replaceLibraryProviderChain deliberately does
   *  NOT perform): shape (mirrors packages/db's own validateEntryShape,
   *  duplicated here so a malformed request 422s with a clear per-field
   *  message before ever reaching a transaction) plus unknown-builtin-name
   *  rejection. Unknown-plugin / C5-scope-violation are NOT checked here —
   *  those need a live DB read of the referenced plugin row, which
   *  replaceLibraryProviderChain already does inside its own transaction;
   *  duplicating that lookup here would just be a second round trip for
   *  the same answer. */
  private parseEntries(raw: unknown, instancePath: string): LibraryProviderChainEntryInput[] {
    if (!Array.isArray(raw)) {
      throw unprocessableEntity("entries must be an array.", instancePath);
    }
    return raw.map((rawEntry, index) => {
      if (!isPlainObject(rawEntry)) {
        throw unprocessableEntity(`entries[${index}] must be an object.`, instancePath);
      }
      const providerKind = rawEntry["providerKind"];
      if (providerKind !== "builtin" && providerKind !== "plugin") {
        throw unprocessableEntity(`entries[${index}].providerKind must be "builtin" or "plugin".`, instancePath);
      }
      if (providerKind === "builtin") {
        const builtinName = rawEntry["builtinName"];
        if (typeof builtinName !== "string" || builtinName.length === 0) {
          throw unprocessableEntity(`entries[${index}]: providerKind="builtin" requires builtinName.`, instancePath);
        }
        if (rawEntry["pluginId"] !== undefined) {
          throw unprocessableEntity(`entries[${index}]: providerKind="builtin" must not set pluginId.`, instancePath);
        }
        if (!isKnownBuiltinProviderName(builtinName)) {
          throw unprocessableEntity(
            `entries[${index}]: unknown built-in provider "${builtinName}" (known: ${KNOWN_BUILTIN_PROVIDER_NAMES.join(", ")}).`,
            instancePath,
          );
        }
        return { providerKind: "builtin" as const, builtinName };
      }
      const pluginId = rawEntry["pluginId"];
      if (typeof pluginId !== "string" || pluginId.length === 0) {
        throw unprocessableEntity(`entries[${index}]: providerKind="plugin" requires pluginId.`, instancePath);
      }
      if (rawEntry["builtinName"] !== undefined) {
        throw unprocessableEntity(`entries[${index}]: providerKind="plugin" must not set builtinName.`, instancePath);
      }
      return { providerKind: "plugin" as const, pluginId };
    });
  }

  private async buildDto(library: LibraryRow, rows: LibraryProviderEntryRow[]): Promise<AdminLibraryProviderChainDto> {
    const allPlugins = await listPlugins(this.dbProvider.db);
    const pluginById = new Map(allPlugins.map((p) => [p.id, p] as [string, PluginRow]));
    const eligiblePlugins = allPlugins
      .filter((p) => p.content_class === library.content_class)
      .map(toPluginRefDto);

    const isDefault = rows.length === 0;
    const entries = isDefault
      ? (LEGACY_DEFAULT_PROVIDER_CHAIN[library.media_kind] ?? []).map((builtinName, position) => toDefaultChainEntryDto(builtinName, position))
      : rows.map((row) => toChainEntryDto(row, pluginById));

    return {
      libraryId: library.id,
      isDefault,
      entries,
      eligiblePlugins,
      builtinProviderNames: [...KNOWN_BUILTIN_PROVIDER_NAMES],
    };
  }

  async getChain(libraryId: string, actorUserId: string): Promise<AdminLibraryProviderChainDto> {
    const instancePath = this.instancePath(libraryId);
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const rows = await getLibraryProviderChain(this.dbProvider.db, libraryId);
    return this.buildDto(library, rows);
  }

  /** library_provider_entries carries no timestamp columns (migrations/
   *  0015_library_provider_chains.sql) — unlike this file's sibling
   *  services, there is no `nowMs` for this write to record anywhere. */
  async putChain(libraryId: string, rawEntries: unknown, actorUserId: string): Promise<AdminLibraryProviderChainDto> {
    const instancePath = this.instancePath(libraryId);
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    // Library existence wins over body validation (matches
    // LibrariesController.putLibraryPermissions's documented ordering).
    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const entries = this.parseEntries(rawEntries, instancePath);

    let rows: LibraryProviderEntryRow[];
    try {
      rows = await replaceLibraryProviderChain(this.dbProvider.db, libraryId, entries);
    } catch (err) {
      // LibraryProviderChainScopeError's own message already names BOTH
      // content classes involved (packages/db/src/query/
      // library-provider-chains.ts) — passed straight through rather than
      // re-worded, so the wire detail and the thrown error stay in lockstep
      // by construction. Same for PluginNotFoundError/
      // InvalidLibraryProviderEntryError's own messages.
      if (
        err instanceof LibraryProviderChainScopeError ||
        err instanceof PluginNotFoundError ||
        err instanceof InvalidLibraryProviderEntryError
      ) {
        throw unprocessableEntity(err.message, instancePath);
      }
      if (err instanceof LibraryNotFoundError) {
        // Unreachable given the pre-check above (library existence was
        // just confirmed under the same request) — kept as defense in
        // depth, matching this service's own "never trust a check is still
        // true two lines later without a reason" posture.
        throw notFound("Library not found.", instancePath);
      }
      throw err;
    }

    return this.buildDto(library, rows);
  }
}
