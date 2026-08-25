// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/apply-match-provider.ts
//
// api-validation-F11: POST /admin/items/{id}/apply-match used to accept
// ANY non-empty `provider` string with a 202. The forced-match branch of
// the worker's metadata consumer resolves that name against the live
// ProviderRegistry (apps/worker/src/metadata/consumer.ts:140 —
// `registry.get(forceRef.provider)`), and a miss is a LOG-AND-SKIP: the
// job then reaches status 'completed' with error null having changed
// nothing. So a typo'd provider bought the admin a success signal for a
// request that could never work. This module is the request-path check
// that turns that into an immediate 422 naming the field.
//
// THE ACCEPTED SET (deliberately the resolvable one, not the contract's
// ProviderName enum — that enum is [tmdb, tvdb], a DIFFERENT closed set:
// the providers with an admin-manageable API KEY, A9):
//
//   1. A built-in ProviderRegistry name —
//      ../plugins/builtin-metadata-providers.ts's
//      KNOWN_BUILTIN_PROVIDER_NAMES, already this server's single
//      documented mirror of apps/worker/src/index.ts's
//      `registry.register(...)` call sites (apps/server may not import
//      apps/worker; see that file's header for the full duplication
//      rationale). Reusing it means the two admin surfaces that validate a
//      provider name — PUT /admin/libraries/{id}/provider-chain and this
//      one — can never disagree about what "built-in" means.
//   2. `lpp:<pluginId>` — the STABLE adapter name apps/worker/src/metadata/
//      plugin-provider.ts's lppProviderName() mints for every LPP metadata
//      plugin, where the referenced plugin row EXISTS and is ENABLED
//      (plugins.enabled; a disabled plugin constructs with
//      `enabled: false` and is skipped by the same registry lookup).
//
// Matching is EXACT and case-sensitive because the registry's Map lookup
// is: "TMDB" and "tmdb " are misses there, so they are 422s here.
//
// Scope note (deliberate, per the finding's owner ruling): this validates
// the provider is RESOLVABLE AT ALL, not that it sits in this item's own
// library provider chain — forceRef bypasses chain resolution by design
// (consumer.ts's "the admin already chose the exact candidate" comment),
// so a chain-membership requirement would reject legitimate one-off
// re-matches. A registered+enabled plugin that no library chain has ever
// attached can therefore still no-op worker-side (nothing ever registered
// its adapter in that process); closing that is a worker-side change to
// the forceRef branch, not a request-path one.

import { getPluginById } from "@loombre/db";
import type { LoombreDb } from "../common/db.provider.js";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import { isValidUuid } from "../gateway/require-uuid-param.js";
import { KNOWN_BUILTIN_PROVIDER_NAMES, isKnownBuiltinProviderName } from "../plugins/builtin-metadata-providers.js";

/** apps/worker/src/metadata/plugin-provider.ts's `lpp:${pluginId}`. */
export const LPP_PROVIDER_NAME_PREFIX = "lpp:";

export type ParsedApplyMatchProvider =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "unknown" };

/** The pure half — no DB touch, so it is unit-testable and the controller's
 *  DB read only happens for a syntactically plausible plugin ref. A
 *  non-UUID id after the prefix is `unknown`, never a plugin lookup:
 *  `plugins.id` is a `uuid` column and Postgres's implicit cast would
 *  throw on garbage, which is exactly the bare-500 failure mode
 *  gateway/require-uuid-param.ts exists to prevent. */
export function parseApplyMatchProvider(provider: string): ParsedApplyMatchProvider {
  if (provider.startsWith(LPP_PROVIDER_NAME_PREFIX)) {
    const pluginId = provider.slice(LPP_PROVIDER_NAME_PREFIX.length);
    return isValidUuid(pluginId) ? { kind: "plugin", pluginId } : { kind: "unknown" };
  }
  return isKnownBuiltinProviderName(provider) ? { kind: "builtin", name: provider } : { kind: "unknown" };
}

/** Bounded echo of the submitted value: helpful ("you sent 'TMDB'") without
 *  letting an arbitrarily long body field ride back out in the problem
 *  detail. */
function quoteProvider(provider: string): string {
  const MAX = 64;
  return JSON.stringify(provider.length > MAX ? `${provider.slice(0, MAX)}…` : provider);
}

const KNOWN_LIST = KNOWN_BUILTIN_PROVIDER_NAMES.join(", ");

/**
 * Throws a 422 problem naming `provider` unless the submitted name is one
 * this server can actually resolve (see the file header). Call AFTER the
 * item's own existence check, so 404 keeps winning over 422 for a
 * nonexistent item (the ordering putLibraryPermissions and this handler
 * already establish), and BEFORE the job is enqueued — a rejected request
 * must leave no jobs row behind.
 */
export async function requireResolvableApplyMatchProvider(db: LoombreDb, provider: string, instance: string): Promise<void> {
  const parsed = parseApplyMatchProvider(provider);

  if (parsed.kind === "unknown") {
    throw unprocessableEntity(
      `provider ${quoteProvider(provider)} is not a metadata provider this server can resolve ` +
        `(built-in: ${KNOWN_LIST}; or "${LPP_PROVIDER_NAME_PREFIX}<pluginId>" for a registered, enabled plugin).`,
      instance,
    );
  }

  if (parsed.kind === "plugin") {
    const plugin = await getPluginById(db, parsed.pluginId);
    if (!plugin) {
      throw unprocessableEntity(`provider ${quoteProvider(provider)} references a plugin that is not registered on this server.`, instance);
    }
    if (!plugin.enabled) {
      throw unprocessableEntity(`provider ${quoteProvider(provider)} references a plugin that is currently disabled.`, instance);
    }
  }
}
