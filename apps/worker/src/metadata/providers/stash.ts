// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/providers/stash.ts
//
// The Stash provider (STATE.md S1/K7): first-party, restricted-scoped
// (`contentClass: 'restricted'`, `kinds: ['movie']`). Registered under
// name `stash` — see apps/server/src/plugins/builtin-metadata-providers.ts's
// KNOWN_BUILTIN_PROVIDER_NAMES (K7) and apps/worker/src/index.ts's
// registration site — but DELIBERATELY never added to
// provider-chain-defaults.ts's PROVIDER_CHAIN: a Stash connection is
// per-library configuration (library_stash_connections), not a global
// default every movie library should try.
//
// ============================================================================
// ProviderRef addressing (a design choice this file OWNS, since it is the
// only caller that constructs a `stash`-provider ref)
// ============================================================================
// ProviderRef/SearchQuery (apps/worker/src/metadata/provider.ts) carry no
// libraryId — a fine assumption for a globally-addressed API (TMDB movie
// id 603 means the same thing everywhere) but Stash's scene ids are only
// unique WITHIN the one SQLite database a library is attached to. This
// provider therefore encodes BOTH facts into `ProviderRef.externalId` as
// `"<libraryId>:<stashSceneId>"` (parsed by parseStashExternalId below) —
// the only place in the codebase that needs to know this convention is
// this file (the writer) and whatever calls fetchDetails with a
// previously-stored provider_ids.external_id value for provider='stash'
// (a per-item refresh flow) — see this lane's freeze report for the full
// "premise correction" writeup on why ProviderRef needed this.
//
// ============================================================================
// ProviderDetails is a LOSSY view for this provider (documented gap)
// ============================================================================
// MovieProviderDetails/ProviderDetailsCommon is the lowest-common-
// denominator shape every provider (TMDB/TVDB/MusicBrainz) maps into for
// apps/worker/src/metadata/consumer.ts's generic precedence-merge path —
// it has no field for a performer's aliases/birthdate/country/
// measurements, no studio parent/image, no tag hierarchy, and no markers.
// S5's RICH mapping (rating100 scaled, studio via S6, performers'
// item_attributes under a `stash:` namespace, markers via S7) is Lane B's
// job, done through their OWN apply module (K11,
// apps/worker/src/stash/apply.ts) consuming read-model.ts's typed Stash
// reads DIRECTLY — never through this file's fetchDetails/ProviderDetails
// return value. fetchDetails here exists ONLY to satisfy the
// MetadataProvider interface for the generic per-item "refresh via the
// registry" path (a real, if secondary, code path — see this file's
// header on search() below for why it is otherwise mostly a no-op for
// Stash); it maps what it honestly can and leaves the rest at safe
// defaults. Do not extend this function to try to carry the rich fields —
// extend apply.ts's own input type instead.
//
// search()/fetchImages() are both effectively no-ops for Stash, and
// DELIBERATELY so:
//   - search(): SearchQuery carries no libraryId, and S4 explicitly says
//     Stash matching is done via path-mapping + oshash (never by title
//     search) — there is no safe, library-scoped way to implement a real
//     text search here, so it always returns []. The automatic
//     resolveViaProviderChain path in consumer.ts (which DOES call
//     search()) is a dead path for `stash` in practice: S4's matching
//     produces provider_ids directly (bypassing search/pickBestMatch
//     entirely), the same way Fix Match's forceRef path already bypasses
//     search() for every provider.
//   - fetchImages(): Stash's cover images are stored as local bytes
//     (`blobs.blob`, possibly NULL when Stash uses filesystem-backed blob
//     storage instead — read-model.ts's getBlob header) inside the Stash
//     SQLite file, never as a fetchable HTTP URL — the one thing
//     ProviderImageRef.url requires (docs/PLAN.md §8.3: "providers never
//     hand back bytes here"). Lane B's image ingest reads bytes directly
//     via read-model.ts's getBlob, bypassing this URL-based interface
//     entirely (documented gap — see freeze report).

import type { DbOrTx } from '@loombre/db/internal';
import { connectToStashLibrary } from '../../stash/connect.js';
import { getScene, getScenePerformers, getSceneTags } from '../../stash/read-model.js';
import type {
  MetadataProvider,
  MovieProviderDetails,
  PersonCredit,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
} from '../provider.js';

export interface StashProviderDeps {
  db: DbOrTx;
}

export function buildStashExternalId(libraryId: string, stashSceneId: string): string {
  return `${libraryId}:${stashSceneId}`;
}

export class InvalidStashExternalIdError extends Error {
  constructor(externalId: string) {
    super(`stash: malformed ProviderRef.externalId "${externalId}" — expected "<libraryId>:<stashSceneId>"`);
    this.name = 'InvalidStashExternalIdError';
  }
}

export function parseStashExternalId(externalId: string): { libraryId: string; stashSceneId: string } {
  const separatorIndex = externalId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) {
    throw new InvalidStashExternalIdError(externalId);
  }
  return { libraryId: externalId.slice(0, separatorIndex), stashSceneId: externalId.slice(separatorIndex + 1) };
}

function yearFromStashDate(date: string | null): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

export class StashSceneNotFoundError extends Error {
  constructor(ref: string) {
    super(`stash: scene not found for ref "${ref}"`);
    this.name = 'StashSceneNotFoundError';
  }
}

export class StashLibraryUnavailableError extends Error {
  constructor(libraryId: string, reason: string) {
    super(`stash: library "${libraryId}"'s Stash connection is not currently usable: ${reason}`);
    this.name = 'StashLibraryUnavailableError';
  }
}

export function createStashProvider(deps: StashProviderDeps): MetadataProvider {
  return {
    name: 'stash',
    contentClass: 'restricted',
    kinds: ['movie'],
    enabled: true,

    async search(_query: SearchQuery): Promise<ProviderSearchResult[]> {
      // See this file's header — deliberately always empty.
      return [];
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      const { libraryId, stashSceneId } = parseStashExternalId(ref.externalId);

      const outcome = await connectToStashLibrary({ db: deps.db }, libraryId);
      if (outcome.status !== 'ok') {
        const reason = outcome.status === 'unsupported_schema' ? outcome.notice : outcome.reason;
        throw new StashLibraryUnavailableError(libraryId, reason);
      }

      try {
        const scene = getScene(outcome.connection.db, stashSceneId);
        if (!scene) {
          throw new StashSceneNotFoundError(ref.externalId);
        }
        const performers = getScenePerformers(outcome.connection.db, stashSceneId);
        const tags = getSceneTags(outcome.connection.db, stashSceneId);

        const people: PersonCredit[] = performers.map((p, index) => ({
          name: p.name,
          role: 'performer',
          order: index,
          ...(p.disambiguation ? { credit: p.disambiguation } : {}),
        }));

        const details: MovieProviderDetails = {
          itemType: 'movie',
          title: scene.title ?? '',
          sortTitle: scene.title ?? '',
          year: yearFromStashDate(scene.date),
          overview: scene.details,
          // TMDB's vote_average (this shared field's other populated
          // source) is natively 0-10, unscaled by that provider — Stash's
          // rating100 is 0-100, so /10 brings it onto the same generic
          // contract THIS field uses. S5's own "(scaled)" mapping rule is
          // independently re-applied by Lane B's apply.ts directly off
          // read-model.ts's unscaled `rating100` — that path is
          // authoritative for the real community_rating write; this
          // value only matters for the secondary per-item-refresh path.
          communityRating: scene.rating100 != null ? scene.rating100 / 10 : null,
          // No Stash equivalent for an MPAA-style content rating.
          contentRating: null,
          // Tag `kind` (general|genre|studio) does not exist until Lane
          // B's migration 0019 (S6) — every scene tag lands in `tags`
          // here undifferentiated; apply.ts's rich path does the
          // kind-aware split.
          genres: [],
          tags: tags.map((t) => t.name),
          people,
          providerIds: {},
          tagline: null,
          // S5: "Duration/resolution stay Loombre-probed — Loombre
          // ffprobe authoritative for technical facts, Stash for
          // editorial facts." Never populated from Stash.
          runtimeMs: null,
        };
        return details;
      } finally {
        outcome.connection.close();
      }
    },

    async fetchImages(_ref: ProviderRef): Promise<ProviderImageRef[]> {
      // See this file's header — deliberately always empty.
      return [];
    },
  };
}
