// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/library-provider-chains.ts
//
// LPP v1 (Lane W3) per-library metadata-provider chains —
// migrations/0015_library_provider_chains.sql. Lives in the PUBLIC barrel
// (src/index.ts), same reasoning src/query/plugins.ts's header gives for
// itself: apps/worker (the only caller of getLibraryProviderChain, at
// metadata-job time) and a future apps/server admin surface (W5b's
// chain-ordering UI, calling replaceLibraryProviderChain) are both fenced
// off from the @loombre/db/internal subpath by dependency-cruiser's
// "no-internal-db-outside-worker" rule for apps/server specifically — this
// file is the door through that fence for this one surface, not a general
// bypass.
//
// C5 STRICT write-time enforcement (this file's own choke point — mirrors
// apps/server/src/plugins/scope.ts's assertPluginAttachAllowed rule
// EXACTLY: a plugin slot's plugin.content_class must equal the owning
// library's content_class, no exceptions in either direction). Duplicated
// here rather than imported from apps/server/src/plugins/scope.ts — same
// "documented duplication" precedent apps/worker/src/metadata/keys.ts's
// header already establishes for mirrorServerDataDir (packages/db cannot
// depend on apps/server; the dependency graph only runs the other way).
// This is layer 1 of the mission's three-layer C5 defense-in-depth
// (write time / chain-resolution time / adapter-construction time — the
// other two layers live in apps/worker/src/metadata/chain-resolution.ts
// and plugin-provider.ts).

import type { Kysely, Selectable } from 'kysely';
import type { ContentClass, DB, LibraryProviderEntriesTable, LibraryProviderKind } from '../types.js';
import { getLibraryById, withTransaction } from '../internal/index.js';

export type LibraryProviderEntryRow = Selectable<LibraryProviderEntriesTable>;

export class LibraryNotFoundError extends Error {
  constructor(libraryId: string) {
    super(`library "${libraryId}" does not exist`);
    this.name = 'LibraryNotFoundError';
  }
}

export class PluginNotFoundError extends Error {
  constructor(pluginId: string) {
    super(`plugin "${pluginId}" does not exist`);
    this.name = 'PluginNotFoundError';
  }
}

export class InvalidLibraryProviderEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLibraryProviderEntryError';
  }
}

/**
 * C5 STRICT scoping violation (write time): a chain entry names a plugin
 * whose content_class does not EQUAL the owning library's content_class —
 * "general-scoped plugins never receive restricted data through ANY
 * capability" (the mission's C5 tightening for plugins specifically,
 * apps/server/src/plugins/scope.ts's header) applies symmetrically: a
 * restricted-scoped plugin is equally forbidden from a general library's
 * chain. Rejected outright, never silently dropped/reordered.
 */
export class LibraryProviderChainScopeError extends Error {
  readonly pluginId: string;
  readonly pluginContentClass: ContentClass;
  readonly libraryContentClass: ContentClass;

  constructor(pluginId: string, pluginContentClass: ContentClass, libraryContentClass: ContentClass) {
    super(
      `plugin "${pluginId}" has content_class="${pluginContentClass}" and cannot be added to a chain for a ` +
        `library with content_class="${libraryContentClass}" (LPP C5 STRICT: a plugin's content_class must ` +
        `equal the target library's content_class exactly)`
    );
    this.name = 'LibraryProviderChainScopeError';
    this.pluginId = pluginId;
    this.pluginContentClass = pluginContentClass;
    this.libraryContentClass = libraryContentClass;
  }
}

export interface LibraryProviderChainEntryInput {
  providerKind: LibraryProviderKind;
  /** Required iff providerKind === 'builtin'; must be omitted/undefined
   *  otherwise. Not validated against the built-in ProviderRegistry here
   *  (packages/db has no knowledge of it) — an unresolvable name is simply
   *  skipped at apps/worker chain-resolution time. */
  builtinName?: string;
  /** Required iff providerKind === 'plugin'; must be omitted/undefined
   *  otherwise. Validated to reference an existing plugin whose
   *  content_class strictly equals the target library's (C5). */
  pluginId?: string;
}

/** Ordered read — resolution order is `position ASC` (migration's own
 *  documented convention; gaps after a CASCADE-deleted plugin are legal
 *  and never require renumbering). Empty array for a library with no chain
 *  configured — apps/worker/src/metadata/chain-resolution.ts treats that
 *  as "fall back to the legacy PROVIDER_CHAIN default" (behavior-
 *  neutrality by construction, migration header). */
export async function getLibraryProviderChain(db: Kysely<DB>, libraryId: string): Promise<LibraryProviderEntryRow[]> {
  return db
    .selectFrom('library_provider_entries')
    .selectAll()
    .where('library_id', '=', libraryId)
    .orderBy('position', 'asc')
    .execute();
}

// L-4 fix wave: the reserved provider-name PREFIX every LPP plugin adapter
// registers itself under (apps/worker/src/metadata/plugin-provider.ts's
// `lppProviderName` — `lpp:<pluginId>`; duplicated as a literal here, not
// imported, for the same "packages/db cannot depend on apps/worker"
// reason this file's own header already gives for not knowing the REAL
// built-in provider name list). `validateEntryShape` used to only check
// `builtinName`/`pluginId` PRESENCE, never CONTENT — a `providerKind:
// "builtin"` entry never went through the C5 STRICT plugin-scope check
// below (that check only runs for `providerKind: "plugin"` entries), so a
// caller of this function OTHER than the one admin service that also
// separately rejects unknown builtin names (apps/server/src/plugins/
// admin-library-provider-chain.service.ts's own `isKnownBuiltinProviderName`
// gate) could smuggle a plugin reference through the "builtin" slot —
// `builtinName: "lpp:<generalPluginId>"` on a RESTRICTED library — and
// chain-resolution.ts's builtin branch pushes ANY `builtin_name` into the
// resolved chain with NO C5 check at all (that check exists only on the
// `plugin` branch), reaching a general-scoped plugin's adapter with
// restricted-library item titles. Rejecting the reserved prefix here,
// UNCONDITIONALLY, closes that specific smuggling path at the one choke
// point every caller of this function passes through — independent of
// whichever caller does or doesn't also separately validate against the
// full built-in name list.
const RESERVED_PLUGIN_PROVIDER_NAME_PREFIX = 'lpp:';

function validateEntryShape(entry: LibraryProviderChainEntryInput, index: number): void {
  if (entry.providerKind === 'builtin') {
    if (!entry.builtinName) {
      throw new InvalidLibraryProviderEntryError(`entry[${index}]: providerKind="builtin" requires builtinName`);
    }
    if (entry.pluginId !== undefined) {
      throw new InvalidLibraryProviderEntryError(`entry[${index}]: providerKind="builtin" must not set pluginId`);
    }
    if (entry.builtinName.startsWith(RESERVED_PLUGIN_PROVIDER_NAME_PREFIX)) {
      throw new InvalidLibraryProviderEntryError(
        `entry[${index}]: builtinName "${entry.builtinName}" uses the reserved "${RESERVED_PLUGIN_PROVIDER_NAME_PREFIX}" prefix (LPP plugin-provider names only — use providerKind="plugin" with pluginId instead)`,
      );
    }
    return;
  }
  // providerKind === 'plugin'
  if (!entry.pluginId) {
    throw new InvalidLibraryProviderEntryError(`entry[${index}]: providerKind="plugin" requires pluginId`);
  }
  if (entry.builtinName !== undefined) {
    throw new InvalidLibraryProviderEntryError(`entry[${index}]: providerKind="plugin" must not set builtinName`);
  }
}

/**
 * Replaces a library's ENTIRE chain wholesale (existing rows deleted and
 * re-inserted with `position` = the input array's index) — the same
 * "caller supplies the full ordered set" convention
 * src/query/libraries.ts's putLibraryPermissionsAdmin uses, matched to
 * what a drag-reorder chain-editing UI (W5b) naturally submits. Rejects
 * the WHOLE call (no partial write) if:
 *   - the library does not exist,
 *   - any entry is malformed (see validateEntryShape),
 *   - any `plugin` entry names a plugin that does not exist, or
 *   - any `plugin` entry's plugin.content_class !== the library's
 *     content_class (LibraryProviderChainScopeError, C5 STRICT — layer 1
 *     of the three-layer defense, see this file's header).
 * An empty `entries` array is legal (clears the chain — the library falls
 * back to the legacy default, see getLibraryProviderChain's doc comment).
 */
export async function replaceLibraryProviderChain(
  db: Kysely<DB>,
  libraryId: string,
  entries: LibraryProviderChainEntryInput[]
): Promise<LibraryProviderEntryRow[]> {
  entries.forEach(validateEntryShape);

  return withTransaction(db, async (trx) => {
    const library = await getLibraryById(trx, libraryId);
    if (!library) {
      throw new LibraryNotFoundError(libraryId);
    }

    // Validate every referenced plugin up front (existence + C5 STRICT)
    // before touching any row — "reject the whole call, never a partial
    // write".
    const pluginIds = [...new Set(entries.filter((e) => e.providerKind === 'plugin').map((e) => e.pluginId!))];
    for (const pluginId of pluginIds) {
      const plugin = await trx.selectFrom('plugins').select(['id', 'content_class']).where('id', '=', pluginId).executeTakeFirst();
      if (!plugin) {
        throw new PluginNotFoundError(pluginId);
      }
      if (plugin.content_class !== library.content_class) {
        throw new LibraryProviderChainScopeError(pluginId, plugin.content_class, library.content_class);
      }
    }

    await trx.deleteFrom('library_provider_entries').where('library_id', '=', libraryId).execute();

    const inserted: LibraryProviderEntryRow[] = [];
    for (let position = 0; position < entries.length; position += 1) {
      const entry = entries[position]!;
      inserted.push(
        await trx
          .insertInto('library_provider_entries')
          .values({
            library_id: libraryId,
            position,
            provider_kind: entry.providerKind,
            builtin_name: entry.providerKind === 'builtin' ? (entry.builtinName as string) : null,
            plugin_id: entry.providerKind === 'plugin' ? (entry.pluginId as string) : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      );
    }

    return inserted;
  });
}
