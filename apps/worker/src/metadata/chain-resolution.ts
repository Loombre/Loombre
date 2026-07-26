// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/chain-resolution.ts
//
// LPP v1 (Lane W3), mission point 3: resolves a library's provider chain
// PER LIBRARY, at metadata-job time — a fresh DB read every call (plugins
// register while the worker runs; there is no boot-time freeze of either
// the chain rows or the referenced plugin rows). Replaces
// apps/worker/src/metadata/consumer.ts's old hardcoded
// `Record<MediaKind, string[]>` lookup with a real per-library read:
//
//   - ZERO `library_provider_entries` rows for the library => the legacy
//     `PROVIDER_CHAIN[mediaKind]` default, VERBATIM (provider-chain-
//     defaults.ts is the single source both this module and consumer.ts
//     import from) — behavior-neutrality by construction
//     (migrations/0015_library_provider_chains.sql's header).
//   - Rows present => walked in `position` order; a `builtin` entry
//     contributes its `builtin_name` straight into the resulting chain
//     (resolved against the registry by consumer.ts's EXISTING
//     resolveViaProviderChain, unchanged — an unregistered name is simply
//     skipped there, same as always); a `plugin` entry is turned into (or
//     reuses) an LPP adapter via plugin-provider.ts's
//     createLppMetadataProvider, REGISTERED into the shared
//     ProviderRegistry under its stable `lpp:<pluginId>` name, and that
//     name is appended to the chain instead.
//
// The result is always a plain `readonly string[]` of provider NAMES —
// mission point 3's explicit requirement: "plugin providers flow through
// the exact same registry/precedence path as built-ins" — consumer.ts's
// resolveViaProviderChain (P1.6/P1.7 semantics: assertScope, per-field
// precedence, metadata_lock) is completely unaware that some of those
// names came from a plugin rather than a built-in; nothing about it
// changes.
//
// C5 STRICT, LAYER 2 (chain-resolution time — the 2nd of the mission's
// three defense-in-depth layers; layer 1 is packages/db/src/query/
// library-provider-chains.ts's write-time check, layer 3 is
// plugin-provider.ts's own construction-time refusal): a `plugin` entry
// whose plugin.content_class does not EQUAL this call's `contentClass`
// argument is excluded from the resulting chain entirely (never
// registered, never appended) — logged, never thrown; C6's "a dead/
// misconfigured plugin must not stall a scan" applies here exactly as it
// does to breaker trips.
//
// Deliberate lane decision (documented, not silently narrowed): NO
// cross-job caching of the DB reads themselves — every call re-reads
// `library_provider_entries` and every referenced `plugins` row fresh.
// The mission's "a short in-job cache is fine" is read as PERMISSIVE, not
// REQUIRED; a metadata job is already an out-of-process, multi-second-
// timeout-bound operation (LPP_SEARCH/DETAILS/IMAGES_TIMEOUT_MS), so a
// couple of extra indexed SELECTs are immaterial, and always-fresh reads
// sidestep any question of a cached adapter/chain going stale relative to
// a concurrent admin edit (chain reorder, plugin re-approval, content-
// class change) — simplicity and correctness over a micro-optimization.

import { getLibraryProviderChain, getPluginById } from '@loombre/db';
import type { DbOrTx } from '@loombre/db/internal';
import type { PluginCircuitBreaker } from '@loombre/plugin-host';
import { createLppMetadataProvider } from './plugin-provider.js';
import { PROVIDER_CHAIN } from './provider-chain-defaults.js';
import type { ProviderRegistry } from './registry.js';
import type { ContentClass, MediaKind } from './provider.js';

export interface ResolveProviderChainForLibraryDeps {
  registry: ProviderRegistry;
  getBreaker: (pluginId: string) => PluginCircuitBreaker;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/**
 * Resolves the ordered provider-name chain a metadata job should walk for
 * one (library, mediaKind, contentClass) — see file header. `db`,
 * `libraryId`, `mediaKind`, and `contentClass` normally come straight from
 * the job's own item read (apps/worker/src/metadata/item-read.ts's
 * `MetadataSourceItem` — `contentClass` is denormalized from the owning
 * library by a DB trigger, so it is always the SAME value the library row
 * itself carries, docs/PLAN.md §6.4).
 */
export async function resolveProviderChainForLibrary(
  db: DbOrTx,
  libraryId: string,
  mediaKind: MediaKind,
  contentClass: ContentClass,
  deps: ResolveProviderChainForLibraryDeps
): Promise<readonly string[]> {
  const rows = await getLibraryProviderChain(db, libraryId);

  if (rows.length === 0) {
    return PROVIDER_CHAIN[mediaKind];
  }

  const chain: string[] = [];

  for (const row of rows) {
    if (row.provider_kind === 'builtin') {
      if (row.builtin_name) chain.push(row.builtin_name);
      continue;
    }

    // provider_kind === 'plugin'
    const pluginId = row.plugin_id;
    if (!pluginId) continue; // unreachable under the migration's XOR CHECK — defensive only.

    const plugin = await getPluginById(db, pluginId);
    if (!plugin) {
      deps.log(`chain-resolution: library "${libraryId}" chain references plugin "${pluginId}" which no longer exists — skipping`);
      continue;
    }

    // C5 STRICT, layer 2.
    if (plugin.content_class !== contentClass) {
      deps.log(
        `chain-resolution: library "${libraryId}" chain plugin "${pluginId}" has content_class="${plugin.content_class}" ` +
          `!== target content_class="${contentClass}" — excluded (C5 STRICT, layer 2)`
      );
      continue;
    }

    const provider = createLppMetadataProvider(
      {
        id: plugin.id,
        baseUrl: plugin.base_url,
        enabled: plugin.enabled,
        contentClass: plugin.content_class,
        lanAllowlist: plugin.lan_allowlist,
        grantedCapabilityTypes: plugin.granted_capability_types,
        manifest: plugin.manifest,
        config: plugin.config,
      },
      {
        db,
        breaker: deps.getBreaker(plugin.id),
        targetContentClass: contentClass,
        log: deps.log,
        // exactOptionalPropertyTypes: omit rather than pass `undefined`
        // through for these optional pass-throughs.
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      }
    );

    if (!provider) continue; // ineligible or C5-refused (layer 3) — already logged by plugin-provider.ts.

    deps.registry.register(provider);
    chain.push(provider.name);
  }

  return chain;
}
