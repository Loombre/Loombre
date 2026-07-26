// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/provider-chain-defaults.ts
//
// LPP v1 (Lane W3, LD10): the legacy hardcoded provider fallback chain
// (P1.6), moved out of consumer.ts verbatim — SAME values, SAME shape,
// zero behavior change — so it can be "the single default source" both
// consumer.ts (still imports it for the doc-comment-visible default) and
// chain-resolution.ts (falls back to it when a library has ZERO
// library_provider_entries rows) share, without either module importing
// the other (a consumer.ts <-> chain-resolution.ts circular import).
//
// Behavior-neutrality by construction (migrations/0015_library_provider_chains.sql's
// header, mission point 5): a library with no rows in
// library_provider_entries resolves EXACTLY this chain, unchanged from
// before this lane existed.

import type { MediaKind } from './provider.js';

/** Provider fallback chain per media kind (P1.6): movies use TMDB only; TV
 *  tries TMDB then falls back to TVDB when TMDB misses/is disabled; music
 *  uses MusicBrainz. Provider *names*, resolved against whatever is
 *  registered in the ProviderRegistry passed into the handler — a provider
 *  name with nothing registered for it is simply skipped. */
export const PROVIDER_CHAIN: Record<MediaKind, readonly string[]> = {
  movie: ['tmdb'],
  tv: ['tmdb', 'tvdb'],
  music: ['musicbrainz'],
};
