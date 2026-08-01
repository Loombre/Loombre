// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/builtin-metadata-providers.ts
//
// Lane W5b: a DOCUMENTED DUPLICATION of two apps/worker-owned facts apps/
// server needs for the provider-chain admin surface (admin-library-
// provider-chain.service.ts) but cannot import directly — apps/server may
// not import apps/worker, they're separate deployables (see apps/server/
// src/cli/doctor.ts's own "apps/server may not import apps/worker" note,
// and apps/server/src/common/rate-limiter.spec.ts's identical precedent).
// Same duplication posture apps/server/src/settings/provider-keys.service.ts's
// PROVIDER_ENV_VAR/PROVIDER_NAMES already establishes for tmdb/tvdb, and
// packages/db/src/query/library-provider-chains.ts's own header establishes
// for the C5 STRICT scope check itself (apps/server/src/plugins/scope.ts's
// assertPluginAttachAllowed, duplicated there for the exact same
// dependency-direction reason).
//
//   - KNOWN_BUILTIN_PROVIDER_NAMES: the closed set of built-in
//     ProviderRegistry names (apps/worker/src/metadata/registry.ts's
//     `registry.register(...)` call sites in apps/worker/src/index.ts) —
//     used to reject an unrecognized `builtinName` on
//     putAdminLibraryProviderChain with a 422, something
//     packages/db/src/query/library-provider-chains.ts deliberately does
//     NOT do itself (that module's own header: "packages/db has no
//     knowledge of it... an unresolvable name is simply skipped at
//     apps/worker chain-resolution time", which is the right behavior for
//     the WORKER'S resolution path but not for an admin UI that should
//     catch a typo immediately).
//   - LEGACY_DEFAULT_PROVIDER_CHAIN: apps/worker/src/metadata/
//     provider-chain-defaults.ts's PROVIDER_CHAIN, SAME values/shape/media
//     kinds — read-only display data for getAdminLibraryProviderChain's
//     `isDefault: true` case (a library with zero library_provider_entries
//     rows resolves this exact chain, per migrations/
//     0015_library_provider_chains.sql's header — "behavior-neutrality by
//     construction"). If apps/worker's default chain is ever intentionally
//     changed, this copy must be updated in the SAME PR (mirrors
//     provider-keys.service.ts's own maintenance-burden acknowledgment for
//     PROVIDER_NAMES).
//
// Neither constant is queried against a live ProviderRegistry instance
// (which only exists inside the worker process, constructed from
// currently-configured API keys) — this is purely the STATIC name/default
// vocabulary, which is what the admin UI actually needs to render choices
// and validate a builtinName's spelling.

import type { MediaKind } from "@loombre/db";

// Stash SQLite metadata sync, K7: `stash` is a restricted-scoped built-in
// (apps/worker/src/metadata/providers/stash.ts) that attaches per-library
// via library_provider_entries — like tmdb/tvdb it must be a KNOWN name so
// putAdminLibraryProviderChain can validate a builtinName spelling, but
// unlike them it is DELIBERATELY absent from LEGACY_DEFAULT_PROVIDER_CHAIN
// below (K7: "NEVER add to the default PROVIDER_CHAIN — it attaches
// per-library only"). ProviderRegistry.assertScope (apps/worker/src/
// metadata/registry.ts) already refuses to run a restricted provider
// against a general library, independent of this list.
export const KNOWN_BUILTIN_PROVIDER_NAMES = ["tmdb", "tvdb", "musicbrainz", "stash"] as const;

export const LEGACY_DEFAULT_PROVIDER_CHAIN: Record<MediaKind, readonly string[]> = {
  movie: ["tmdb"],
  tv: ["tmdb", "tvdb"],
  music: ["musicbrainz"],
};

export function isKnownBuiltinProviderName(name: string): boolean {
  return (KNOWN_BUILTIN_PROVIDER_NAMES as readonly string[]).includes(name);
}
