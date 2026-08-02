// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/import/types.ts
//
// Typed mirror of packages/contract/openapi.yaml's ExportArchive (POST
// /import's request body, GET /export's response body — the SAME schema,
// per the contract's own "Import accepts the same shape" description).
// ImportJobPayload.archive (packages/jobs/src/types.ts) is `unknown` on the
// wire — validate.ts's validateArchive() is the one place that narrows it
// to these types, so every OTHER file in this module works against a
// trusted, already-shape-checked value.
//
// Deliberately narrower than the full OpenAPI schema: only the fields the
// import consumer actually reads are typed here (validate.ts still checks
// every REQUIRED contract field's presence/type on the raw input, even
// fields not carried into these interfaces afterward — a malformed archive
// must fail validation regardless of which fields this module goes on to
// use). Fields the contract exposes but that have no import destination at
// all (e.g. Season/Album have no `people`; Episode/Track have no `genres` —
// see packages/contract/openapi.yaml's per-type schemas) are simply absent
// here, matching the contract exactly rather than inventing one.

export type ArchiveMediaKind = 'movie' | 'tv' | 'music';
export type ArchiveContentClass = 'general' | 'restricted';
export type ArchiveItemType = 'movie' | 'series' | 'season' | 'episode' | 'artist' | 'album' | 'track';
export type ArchiveWatchState = 'unplayed' | 'in-progress' | 'played';
export type ArchivePersonRole = 'actor' | 'director' | 'writer' | 'artist' | 'album_artist' | 'performer' | 'guest';

export interface ArchiveLibrary {
  id: string;
  name: string;
  mediaKind: ArchiveMediaKind;
  paths: string[];
  contentClass: ArchiveContentClass;
  createdAtMs: number;
}

export interface ArchiveMediaFile {
  id: string;
  versionLabel: string | null;
  container: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
}

export interface ArchivePersonCredit {
  name: string;
  role: ArchivePersonRole;
  credit: string | null;
  order: number;
}

interface ArchiveItemBase {
  id: string;
  libraryId: string;
  title: string;
  sortTitle: string;
  year: number | null;
  communityRating: number | null;
  contentClass: ArchiveContentClass;
  addedAtMs: number;
  updatedAtMs: number;
}

export interface ArchiveMovie extends ArchiveItemBase {
  itemType: 'movie';
  contentRating: string | null;
  runtimeMs: number | null;
  overview: string | null;
  tagline: string | null;
  genres: string[];
  people: ArchivePersonCredit[];
  mediaFiles: ArchiveMediaFile[];
}

export interface ArchiveSeries extends ArchiveItemBase {
  itemType: 'series';
  contentRating: string | null;
  overview: string | null;
  status: 'continuing' | 'ended' | 'cancelled' | null;
  genres: string[];
  people: ArchivePersonCredit[];
}

export interface ArchiveSeason extends ArchiveItemBase {
  itemType: 'season';
  seriesId: string;
  seasonNumber: number;
}

export interface ArchiveEpisode extends ArchiveItemBase {
  itemType: 'episode';
  seasonId: string;
  seriesId: string;
  episodeNumber: number;
  runtimeMs: number | null;
  overview: string | null;
  airDateMs: number | null;
  people: ArchivePersonCredit[];
  mediaFiles: ArchiveMediaFile[];
}

export interface ArchiveArtist extends ArchiveItemBase {
  itemType: 'artist';
  overview: string | null;
  genres: string[];
  people: ArchivePersonCredit[];
}

export interface ArchiveAlbum extends ArchiveItemBase {
  itemType: 'album';
  artistId: string;
  genres: string[];
}

export interface ArchiveTrack extends ArchiveItemBase {
  itemType: 'track';
  albumId: string;
  artistId: string;
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
  mediaFiles: ArchiveMediaFile[];
}

export type ArchiveItem =
  | ArchiveMovie
  | ArchiveSeries
  | ArchiveSeason
  | ArchiveEpisode
  | ArchiveArtist
  | ArchiveAlbum
  | ArchiveTrack;

export interface ArchiveUser {
  id: string;
  username: string;
  /** M1: nullable — ExportUser.email is optional-value now (an email-less
   *  archived user round-trips as `null`). */
  email: string | null;
  /** M2: nullable — ExportUser.displayName (E4 archive check). */
  displayName: string | null;
  isAdmin: boolean;
  createdAtMs: number;
}

export interface ArchiveProgress {
  itemId: string;
  positionMs: number;
  durationMs: number | null;
  state: ArchiveWatchState;
  playCount: number;
  updatedAtMs: number;
}

export interface ExportArchive {
  exportedAtMs: number;
  users: ArchiveUser[];
  libraries: ArchiveLibrary[];
  items: ArchiveItem[];
  progress: ArchiveProgress[];
  /** Never non-empty on the wire today — GET /export hardcodes `[]`
   *  (apps/server/src/catalog/data-freedom.controller.ts) because no
   *  `playlists` table exists anywhere in packages/db/migrations. Validated
   *  for shape (must be an array — the contract requires the key) but never
   *  written anywhere; see the import consumer's module header. */
  playlists: unknown[];
}

// ============================================================================
// Job result / conflict-policy types.
// ============================================================================

export type ImportMode = 'fail-if-not-empty' | 'merge-skip-existing';

export interface ImportSectionCounts {
  created: number;
  /** Natural-key match under merge-skip-existing — the archive's row was
   *  left untouched. Named to match the exit-bar's own wording ("counts all
   *  'skipped'" for a merge-mode re-import). */
  skipped: number;
}

export interface ImportResult {
  /** The policy that governed non-empty-target handling (payload.mode,
   *  defaulting to 'fail-if-not-empty' — see ./consumer.ts's module
   *  header). Recorded even when preservedIds is true: a caller who
   *  explicitly asked for 'fail-if-not-empty' and got an empty target
   *  should see that their request was honored, not silently relabeled. */
  mode: ImportMode;
  /** True iff the target was empty enough (see ./consumer.ts's exact
   *  definition) that every archive id was written verbatim; false means
   *  every newly-created row this run minted a fresh id and natural-key
   *  matching decided created-vs-skipped. */
  preservedIds: boolean;
  libraries: ImportSectionCounts;
  items: ImportSectionCounts;
  users: ImportSectionCounts & {
    /** users-section special case (P4.10 wizard-restore seam): the archive
     *  row's username matched the CALLER's (requestedByUserId's) own,
     *  already-existing row — left untouched (including its real,
     *  just-set password), not counted as a plain natural-key `skipped`. */
    selfMatched: number;
  };
  progress: ImportSectionCounts;
  durationMs: number;
}

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

export class ImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportConflictError';
  }
}
