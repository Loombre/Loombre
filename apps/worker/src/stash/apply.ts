// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/apply.ts
//
// Stash SQLite metadata sync (STATE.md mission, S5-S7, K5/K11): writes an
// already-read, already-matched Stash scene bundle onto an existing
// catalog item. `applyStashSceneMetadata(trx, deps, input)` is the FROZEN
// name/signature K11 assigns to this lane — Lane C (the sync engine) is
// the only caller, injecting it wherever it needs to apply one scene, and
// owns EVERY read of the Stash SQLite file and every match decision (S4);
// this module never opens a Stash connection and never decides which
// catalog item a scene belongs to. It only writes.
//
// Reuses the SAME merge/writer primitives metadata/consumer.ts uses (K5):
// mergeFields (precedence.ts) + buildLayers/toProvenanceMap/isEqual
// (layers.ts — mechanically extracted OUT of consumer.ts for this reuse;
// consumer.spec.ts proves the extraction didn't change consumer.ts's own
// behavior), upsertCatalogItem/upsertSatellite, upsertMetadataProvenance,
// findOrCreatePerson/findOrCreateTag, replaceItemPeople/replaceItemTags,
// and the 'image' job enqueue convention. Provenance source is always the
// literal string 'provider:stash' — NOT a member of precedence.ts's
// closed `FieldSource` union (that file is off-limits to edit per this
// lane's constraints), so it is cast the exact same way consumer.ts casts
// its own dynamic provider name (`` `provider:${matched.providerName}` as
// ProviderFieldSource ``) — the DB column backing metadata_provenance.
// source is plain TEXT (packages/db/src/internal/provenance.ts), so this
// is a type-level cast only, not a schema or logic change.
//
// ============================================================================
// Transaction shape (K11: "must run inside ONE transaction")
// ============================================================================
// `trx` is typed the same general `DbOrTx` every internal writer accepts
// (Kysely<DB> | Transaction<DB>) — this function opens its own
// `withTransaction(trx, ...)` block internally, exactly like relations.ts's
// replaceItemPeople/replaceItemTags do. withTransaction's own contract
// (packages/db/src/internal/tx.ts) means: if the caller already passed an
// active transaction (Lane C composing this call alongside its own
// stash_scene_links bookkeeping in one atomic unit), no NESTED transaction
// opens and every write here joins that one; if the caller passed a plain
// pool handle, a fresh transaction opens around this call alone. Either
// way, every write below is one atomic unit.
//
// Image jobs are enqueued AFTER that transaction commits (mirrors
// consumer.ts's own commit-then-enqueue ordering — never enqueue a job for
// a write that might still roll back). Blob bytes (deps.getBlob, backed by
// read-model.ts's synchronous SQLite read) are staged to a local temp file
// via image/download.ts's stageLocalTempBlob + the `local-temp:` sourcePath
// convention added alongside this file (Stash hands back in-SQLite bytes,
// never a fetchable URL — apps/worker/src/metadata/providers/stash.ts's
// header documents this same gap for its own, secondary, fetchImages()).
//
// ============================================================================
// Locked fields (S5, "respect metadata_provenance locks")
// ============================================================================
// Ten catalog-level fields go through mergeFields, independently
// lockable, exactly like metadata/consumer.ts's tmdb/tvdb/musicbrainz
// path: title, sortTitle, year, communityRating, overview, premiereAtMs,
// genres, tags, studio, people. A locked field's merged value is simply
// ABSENT from `merged.fields` (precedence.ts's own contract) — this module
// then falls back to whatever is CURRENTLY persisted, so a locked field is
// never rewritten. `runtimeMs`/content_rating/tagline are NEVER part of
// providerFields at all (S5: "Loombre's ffprobe is authoritative for
// technical facts, Stash for editorial facts") — see writeMovieSatellite
// below, which always echoes the CURRENT runtime_ms/content_rating/
// tagline back unchanged (upsertSatellite's movie branch has no
// absent-means-don't-touch semantics for those three columns, unlike
// premiere_at_ms, so omitting them would NULL them out rather than
// preserve them).
//
// Studio/tags/genres/people are RELATIONAL, not scalar — the lock
// decision only gates whether THIS ITEM's edge set (item_tags/item_people)
// gets rewritten. The underlying shared entities (a studio tag, a genre
// tag, a performer person row + its person_attributes/portrait) are
// always kept fresh from the Stash bundle regardless of this item's own
// lock state — locking "this item's cast list" has no sensible reading as
// "also stop updating Jane Doe's bio for every OTHER item she's credited
// on".
//
// ============================================================================
// Rating scale (S5 "rating100 → community_rating — scaled")
// ============================================================================
// Verified empirically against the only other populated source:
// apps/worker/src/metadata/providers/tmdb.ts's mapMovieDetails does
// `communityRating: json.vote_average ?? null` — TMDB's vote_average is
// natively 0-10 with no scaling applied by that provider, so 0-10 IS the
// established catalog_items.community_rating convention (the column
// itself is a plain `REAL` with no in-DB scale CHECK —
// migrations/0001_init.sql). Stash's rating100 is 0-100 by name and
// convention, so dividing by 10 brings it onto the SAME 0-10 scale
// (rating100=85 -> 8.5, directly comparable to a TMDB vote_average of
// 8.5). apps/worker/src/metadata/providers/stash.ts independently applies
// the identical /10 conversion for its own secondary per-item-refresh
// path and cross-references this module in its own comment.
//
// ============================================================================
// Genre heuristic (S6/K15, "library_stash_connections.genre_tag_names
// NULL ⇒ documented default heuristic")
// ============================================================================
// isDefaultGenreTag: a Stash tag with NO parent in Stash's tags_relations
// table (StashTag.parentIds.length === 0) is treated as a genre; a tag
// with at least one parent is treated as a plain tag. Chosen over the
// "nothing is a genre by default" alternative the mission brief also
// floats: Stash's own community tagging convention commonly nests
// specific/descriptive tags under broader category tags (the checked-in
// v67 fixture — apps/worker/test/stash/fixtures/schema-v67-supported-
// min.sql — has exactly this shape: "Action" is a root tag, "Fight Scene"
// is its child), so root tags read as the closest Stash-native analog to
// a genre — the same broad-few-genres/many-specific-tags split Loombre's
// own TMDB-driven catalog already has. A "nothing is a genre by default"
// policy would leave S9's zone browse genre filter empty for every fresh
// Stash connection until an admin discovers and hand-configures
// genre_tag_names, materially degrading the mission's own "browse with
// filters (... tags/genres ...)" goal for the common case — rejected on
// that basis. genre_tag_names (non-NULL) overrides this per exact,
// case-insensitive (CITEXT-equivalent) name match — see isGenreTag below.
//
// ============================================================================
// Tag/studio hierarchy (S5 "tags gain parent_tag_id... preserving
// hierarchy where schema provides it")
// ============================================================================
// Studios: `input.studioChain` is Lane C's fully-resolved ancestor chain
// (index 0 = the scene's directly-attached studio, index 1 = its parent,
// etc. — resolved by Lane C repeatedly following read-model.ts's
// StashStudio.parentId, since Loombre's tags.parent_tag_id models only a
// SINGLE optional parent per tag while Stash's studios table supports
// arbitrarily deep chains). This module always upserts every node in the
// chain (root to leaf) with the correct parent_tag_id links, regardless
// of whether the SCENE's own studio *edge* ends up locked.
//
// General tags: `input.tags` is only the scene's OWN directly-attached
// tags (read-model.ts's getSceneTags), not Stash's whole tag table.
// parent_tag_id is therefore only reconstructed among tags BOTH present
// in this one bundle — a parent tag not itself attached to this scene has
// no name available here to create/link it from, and Lane C does not walk
// Stash's tags_relations beyond one scene's own tag list. This is a real,
// documented v1 gap (full ancestor-tag resolution independent of any one
// scene is future work), not a bug: the fixture data (Action -> Fight
// Scene, both attached to the same scene) is the common real-world case
// this DOES handle, and is exactly what apply.spec.ts proves.
//
// ============================================================================
// Image dedup (Tier-0 + S10 33k-scale budget)
// ============================================================================
// The scene cover is 1:1 with the item and always re-enqueued when a
// checksum is present (Lane C's own S8 diffing already bounds how often
// apply() runs for a given item — a re-run implies the scene may have
// changed). Performer portraits and studio logos are SHARED entities a
// full sync visits once per referencing scene — enqueueing on every visit
// would multiply work by however many scenes credit that performer/
// studio. This module guards those two with
// @loombre/db/internal's hasOriginalImage: skip staging+enqueueing when an
// "original" images row already exists for that (entityType, entityId,
// kind). This is an EXISTENCE check, not a checksum comparison (this
// module has no record of which Stash blob checksum produced a given
// images row) — a changed Stash performer/studio image after first
// ingest is a documented v1 limitation, consistent with S8's sync engine
// only diffing SCENE-level Stash `updated_at`, never performer/studio
// `updated_at` independently.

import type { JobPayloads } from '@loombre/jobs';
import {
  findOrCreatePerson,
  findOrCreateTag,
  getProvenanceForItem,
  hasOriginalImage,
  replaceChapterMarkers,
  replaceItemPeople,
  replaceItemTags,
  upsertCatalogItem,
  upsertItemAttribute,
  upsertMetadataProvenance,
  upsertPersonAttribute,
  upsertProviderId,
  upsertSatellite,
  withTransaction,
  writeEvent,
  type DbOrTx,
} from '@loombre/db/internal';
import type { ItemTagKind } from '@loombre/db';
import { getCurrentRelations, getCurrentSatelliteFields, getMetadataSourceItem } from '../metadata/item-read.js';
import { mergeFields, type ProviderFieldSource } from '../metadata/precedence.js';
import { buildLayers, isEqual, toProvenanceMap } from '../metadata/layers.js';
import type { PersonCredit } from '../metadata/provider.js';
import { toSortTitle } from '../scan/hierarchy.js';
import { buildStashExternalId } from '../metadata/providers/stash.js';
import { stageLocalTempBlob } from '../image/download.js';
import type { StashBlob, StashPerformer, StashScene, StashSceneFile, StashSceneMarker, StashStudio, StashTag } from './read-model.js';

// S1/K7: the Stash provider is ALWAYS restricted-scoped
// (`contentClass: 'restricted'` in metadata/providers/stash.ts's provider
// factory; ProviderRegistry.assertScope already refuses a restricted
// provider on a general library) — every entity this mapper finds or
// creates is therefore always 'restricted', never read off the item.
const STASH_CONTENT_CLASS = 'restricted';

const STASH_SOURCE = 'provider:stash' as ProviderFieldSource;

// ============================================================================
// input / deps
// ============================================================================

export interface StashSceneBundle {
  scene: StashScene;
  /** Primary-first, per read-model.ts's getSceneFiles ordering. Carried
   *  for bundle completeness (Lane C already read these for S4 matching)
   *  and used here ONLY as informational context for item_attributes'
   *  primaryFilePath (see writeSceneAttributes) — NEVER to write
   *  media_files/media_streams/duration/resolution (S5: Loombre's ffprobe
   *  owns those). */
  files: StashSceneFile[];
  performers: StashPerformer[];
  /** [] = no studio attached to this scene. Index 0 is the scene's own
   *  studio; index 1 its parent, etc. (this file's header). */
  studioChain: StashStudio[];
  /** The scene's own attached tags (read-model.ts's getSceneTags). */
  tags: StashTag[];
  markers: StashSceneMarker[];
}

export interface ApplyStashSceneMetadataInput extends StashSceneBundle {
  libraryId: string;
  itemId: string;
  stashSceneId: string;
  /** library_stash_connections.genre_tag_names (K15). NULL selects
   *  isDefaultGenreTag (this file's header); a non-NULL array is an
   *  explicit, case-insensitive exact-name allowlist that replaces the
   *  heuristic wholesale. */
  genreTagNames: string[] | null;
}

export interface ApplyStashSceneMetadataDeps {
  /** Reads one blob's bytes by checksum from the SAME already-open Stash
   *  connection Lane C used to read the rest of the bundle (S1/S2 — this
   *  module never opens a Stash connection itself). Signature matches
   *  read-model.ts's getBlob exactly; returns null for "no bytes
   *  available" (unknown checksum, or Stash's filesystem-backed blob
   *  storage — read-model.ts's own header), never throws. */
  getBlob: (checksum: string) => StashBlob | null;
  /** Mirrors metadata/consumer.ts's MetadataConsumerDeps.enqueueImageJob
   *  exactly (same 'image' job type) — called only AFTER the transaction
   *  this module opens has committed (this file's header). */
  enqueueImageJob: (payload: JobPayloads['image']) => Promise<unknown>;
  clock?: () => number;
}

export interface ApplyStashSceneMetadataResult {
  /** Field names mergeFields decided to (re)write this call (scalar +
   *  relational catalog-level fields only — see this file's header) —
   *  empty when every field was locked or unchanged. Lane C's sync report
   *  (S8) may use this to distinguish "matched, no-op" from "matched,
   *  updated". */
  changedFields: string[];
}

// ============================================================================
// pure mapping helpers
// ============================================================================

/** Stash's scene.date/performer.birthdate are partial calendar dates
 *  ('YYYY-MM-DD', DATE columns) — Date.parse on a bare ISO date string is
 *  interpreted as UTC midnight per the ECMAScript date-time string format,
 *  the SAME convention apps/worker/src/metadata/providers/tmdb.ts's
 *  isoDateToEpochMs already relies on for its own ISO date strings. */
function parseIsoDateMs(date: string | null): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

function yearFromStashDate(date: string | null): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** Stash allows an empty-string title (distinct from SQL NULL); this
 *  mapper treats both as "no title" — catalog_items.title is NOT NULL, so
 *  a genuinely-empty Stash title must never become the winning provider
 *  layer (see buildProviderFields's comment on why title/sortTitle are
 *  omitted rather than included-as-null, unlike every other field here). */
function nonEmptyTitle(title: string | null): string | null {
  const trimmed = title?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Default genre heuristic (S6/K15, NULL genre_tag_names) — see this
 *  file's header for the full rationale. */
function isDefaultGenreTag(tag: StashTag): boolean {
  return tag.parentIds.length === 0;
}

function isGenreTag(tag: StashTag, genreTagNames: string[] | null): boolean {
  if (genreTagNames != null) {
    const lower = tag.name.toLowerCase();
    return genreTagNames.some((n) => n.toLowerCase() === lower);
  }
  return isDefaultGenreTag(tag);
}

function chapterTitleFor(marker: StashSceneMarker, tagsById: Map<string, StashTag>): string {
  const trimmed = marker.title.trim();
  if (trimmed.length > 0) return trimmed;
  return tagsById.get(marker.primaryTagId)?.name ?? 'Marker';
}

/** Birthdate stored as epoch ms (house law, CLAUDE.md invariant 5) with
 *  the raw Stash string preserved alongside it — `ms: null` when the raw
 *  string is present but unparseable ("lossy") rather than dropping it. */
function parseStashBirthdate(raw: string | null): { raw: string | null; ms: number | null } {
  return { raw, ms: parseIsoDateMs(raw) };
}

// ============================================================================
// studio chain (S6/K2)
// ============================================================================

interface ResolvedStudioNode {
  tagId: string;
  name: string;
}

/** Upserts every studio in the chain root-to-leaf so each child's
 *  parent_tag_id can reference an already-resolved parent tag id. Always
 *  runs (regardless of whether the SCENE's own studio edge ends up
 *  locked) — see this file's header on why shared entities stay fresh
 *  independent of one item's lock state. */
async function upsertStudioChain(trx: DbOrTx, chain: StashStudio[]): Promise<ResolvedStudioNode[]> {
  const resolved: ResolvedStudioNode[] = new Array(chain.length);
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    const parentTagId = i + 1 < chain.length ? resolved[i + 1]!.tagId : null;
    const tag = await findOrCreateTag(trx, node.name, STASH_CONTENT_CLASS, { kind: 'studio', parentTagId });
    resolved[i] = { tagId: tag.id, name: tag.name };
  }
  return resolved;
}

// ============================================================================
// scene tags (S5/S6, genre vs. tag classification + hierarchy)
// ============================================================================

interface ResolvedTag {
  tagId: string;
  name: string;
  isGenre: boolean;
}

/** Upserts every tag in the scene's own bundle with its classification
 *  (genre vs. general), then a second pass links parent_tag_id among
 *  tags BOTH present in this bundle (this file's header explains the
 *  single-bundle hierarchy-resolution limitation). */
async function upsertSceneTags(trx: DbOrTx, tags: StashTag[], genreTagNames: string[] | null): Promise<Map<string, ResolvedTag>> {
  const byStashId = new Map<string, ResolvedTag>();

  for (const tag of tags) {
    const genre = isGenreTag(tag, genreTagNames);
    const row = await findOrCreateTag(trx, tag.name, STASH_CONTENT_CLASS, { kind: genre ? 'genre' : 'general' });
    byStashId.set(tag.id, { tagId: row.id, name: row.name, isGenre: genre });
  }

  for (const tag of tags) {
    const parentStashId = tag.parentIds[0];
    if (!parentStashId) continue;
    const parent = byStashId.get(parentStashId);
    if (!parent) continue; // parent not in this scene's own bundle — see header.
    const self = byStashId.get(tag.id)!;
    const updated = await findOrCreateTag(trx, self.name, STASH_CONTENT_CLASS, { parentTagId: parent.tagId });
    self.tagId = updated.id;
  }

  return byStashId;
}

/** Resolves a tag id for a name already decided as the FINAL (lock-
 *  respecting) genre/tag list. Names that came from this scene's own
 *  Stash bundle reuse the already-classified/parented row from
 *  upsertSceneTags; a name that fell back to whatever is CURRENTLY
 *  persisted (a locked field, or content from a source other than this
 *  scene's bundle) is looked up/created WITHOUT kind/parentTagId opts —
 *  findOrCreateTag's absent-means-don't-touch contract (relations.ts)
 *  then preserves whatever classification that tag already has. */
async function resolveTagIdForName(trx: DbOrTx, name: string, byStashId: Map<string, ResolvedTag>): Promise<string> {
  for (const resolved of byStashId.values()) {
    if (resolved.name === name) return resolved.tagId;
  }
  const row = await findOrCreateTag(trx, name, STASH_CONTENT_CLASS);
  return row.id;
}

async function getCurrentStudioName(db: DbOrTx, itemId: string): Promise<string | null> {
  const row = await db
    .selectFrom('item_tags')
    .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
    .select('tags.name as name')
    .where('item_tags.item_id', '=', itemId)
    .where('item_tags.kind', '=', 'studio')
    .executeTakeFirst();
  return row?.name ?? null;
}

async function getCurrentPremiereAtMs(db: DbOrTx, itemId: string): Promise<number | null> {
  const row = await db.selectFrom('movie_details').select('premiere_at_ms').where('item_id', '=', itemId).executeTakeFirst();
  return row?.premiere_at_ms ?? null;
}

// ============================================================================
// item_attributes / person_attributes (S5/K11 scene + performer extras)
// ============================================================================

async function writeSceneAttributes(trx: DbOrTx, itemId: string, input: ApplyStashSceneMetadataInput): Promise<void> {
  const primaryFile = input.files.find((f) => f.isPrimary) ?? input.files[0] ?? null;
  const entries: [string, Record<string, unknown>][] = [
    ['sceneId', { sceneId: input.stashSceneId }],
    ['rating100', { rating100: input.scene.rating100 }],
    ['code', { code: input.scene.code }],
    ['director', { director: input.scene.director }],
    ['organized', { organized: input.scene.organized }],
    ['primaryFilePath', { path: primaryFile?.path ?? null }],
  ];
  for (const [key, value] of entries) {
    await upsertItemAttribute(trx, { itemId, namespace: 'stash', key, value });
  }
}

async function writePerformerAttributes(trx: DbOrTx, personId: string, performer: StashPerformer): Promise<void> {
  const entries: [string, Record<string, unknown>][] = [
    ['aliases', { aliases: performer.aliases }],
    ['gender', { gender: performer.gender }],
    ['country', { country: performer.country }],
    ['measurements', { measurements: performer.measurements }],
    ['birthdate', parseStashBirthdate(performer.birthdate)],
  ];
  for (const [key, value] of entries) {
    await upsertPersonAttribute(trx, { personId, namespace: 'stash', key, value });
  }
}

// ============================================================================
// pending image tasks — collected during the transaction, executed after
// commit (this file's header)
// ============================================================================

interface PendingImageTask {
  entityType: 'catalog_item' | 'tag' | 'person';
  entityId: string;
  kind: 'poster' | 'logo' | 'thumb';
  checksum: string;
  filenameHint: string;
}

// ============================================================================
// applyStashSceneMetadata — K11 frozen name/signature
// ============================================================================

export async function applyStashSceneMetadata(
  trx: DbOrTx,
  deps: ApplyStashSceneMetadataDeps,
  input: ApplyStashSceneMetadataInput
): Promise<ApplyStashSceneMetadataResult> {
  const clock = deps.clock ?? Date.now;
  const pendingImageTasks: PendingImageTask[] = [];

  const changedFields = await withTransaction(trx, async (innerTrx) => {
    const item = await getMetadataSourceItem(innerTrx, input.itemId);
    if (!item) return []; // race: item deleted before this job ran — no-op, matches consumer.ts.

    if (item.itemType !== 'movie') {
      // K1: Stash scenes are ALWAYS item_type='movie' rows. A mismatch
      // here means Lane C matched the wrong itemId — a real caller bug,
      // not a benign Stash-side data gap, so this fails loudly rather
      // than silently no-op-ing like the SUPPORTED_ITEM_TYPES check in
      // metadata/consumer.ts (which is filtering EXPECTED out-of-scope
      // item types, a different situation).
      throw new Error(`applyStashSceneMetadata: item ${input.itemId} is item_type "${item.itemType}", expected "movie" (K1)`);
    }

    const [existingProvenanceRows, currentSatelliteFields, currentRelations, currentStudioName, currentPremiereAtMs] = await Promise.all([
      getProvenanceForItem(innerTrx, item.id),
      getCurrentSatelliteFields(innerTrx, 'movie', item.id),
      getCurrentRelations(innerTrx, item.id),
      getCurrentStudioName(innerTrx, item.id),
      getCurrentPremiereAtMs(innerTrx, item.id),
    ]);
    const existingProvenance = toProvenanceMap(existingProvenanceRows);

    const title = nonEmptyTitle(input.scene.title);
    const year = yearFromStashDate(input.scene.date);
    const premiereAtMs = parseIsoDateMs(input.scene.date);
    const communityRating = input.scene.rating100 != null ? input.scene.rating100 / 10 : null;
    const studioName = input.studioChain[0]?.name ?? null;
    const genreNames = input.tags.filter((t) => isGenreTag(t, input.genreTagNames)).map((t) => t.name);
    const tagNames = input.tags.filter((t) => !isGenreTag(t, input.genreTagNames)).map((t) => t.name);
    const people: PersonCredit[] = input.performers.map((p, index) => ({
      name: p.name,
      role: 'performer',
      order: index,
      credit: p.disambiguation ?? null,
    }));

    // Title/sortTitle are omitted entirely (never included-as-null) when
    // Stash has nothing usable — catalog_items.title is NOT NULL, and
    // "no opinion" must never win over whatever is already persisted (see
    // nonEmptyTitle's comment). Every other field below is ALWAYS
    // included, even when null/empty, so a Stash-side clear (e.g. a
    // scene's date removed) legitimately clears the mapped Loombre field
    // too, unless locked — matching apps/worker/src/metadata/providers/
    // tmdb.ts's own `?? null` convention for its optional fields.
    const providerFields: Record<string, unknown> = {
      ...(title ? { title, sortTitle: toSortTitle(title) } : {}),
      year,
      premiereAtMs,
      overview: input.scene.details,
      communityRating,
      studio: studioName,
      genres: genreNames,
      tags: tagNames,
      people,
    };

    const current: Record<string, unknown> = {
      title: item.title,
      sortTitle: item.sortTitle,
      year: item.year,
      communityRating: item.communityRating,
      overview: currentSatelliteFields.overview,
      premiereAtMs: currentPremiereAtMs,
      studio: currentStudioName,
      genres: currentRelations.genres,
      tags: currentRelations.tags,
      people: currentRelations.people,
    };

    const layers = buildLayers('movie', providerFields, current, existingProvenance);
    const merged = mergeFields(layers, existingProvenance, {}, STASH_SOURCE);

    const now = clock();
    const changed = Object.keys(merged.fields).filter((field) => !isEqual(merged.fields[field], current[field]));

    // ------------------------------------------------------------------
    // catalog_items + movie_details
    // ------------------------------------------------------------------
    const finalTitle = (merged.fields.title as string | undefined) ?? item.title;
    const finalSortTitle = (merged.fields.sortTitle as string | undefined) ?? item.sortTitle;
    const finalYear = 'year' in merged.fields ? (merged.fields.year as number | null) : item.year;
    const finalCommunityRating = 'communityRating' in merged.fields ? (merged.fields.communityRating as number | null) : item.communityRating;

    await upsertCatalogItem(innerTrx, {
      id: item.id,
      libraryId: item.libraryId,
      itemType: 'movie',
      parentId: item.parentId,
      title: finalTitle,
      sortTitle: finalSortTitle,
      year: finalYear,
      communityRating: finalCommunityRating,
      addedAtMs: item.addedAtMs,
      updatedAtMs: now,
    });

    const hasPremiere = 'premiereAtMs' in merged.fields;
    await upsertSatellite(innerTrx, {
      itemType: 'movie',
      item_id: item.id,
      // S5: NEVER Stash-sourced — always echoed back unchanged.
      content_rating: (currentSatelliteFields.contentRating as string | null | undefined) ?? null,
      runtime_ms: (currentSatelliteFields.runtimeMs as number | null | undefined) ?? null,
      tagline: (currentSatelliteFields.tagline as string | null | undefined) ?? null,
      overview: 'overview' in merged.fields ? (merged.fields.overview as string | null) : ((currentSatelliteFields.overview as string | null | undefined) ?? null),
      ...(hasPremiere ? { premiere_at_ms: merged.fields.premiereAtMs as number | null } : {}),
    });

    // ------------------------------------------------------------------
    // provider_ids (Lane A's frozen convention)
    // ------------------------------------------------------------------
    await upsertProviderId(innerTrx, { itemId: item.id, provider: 'stash', externalId: buildStashExternalId(input.libraryId, input.stashSceneId) });

    // ------------------------------------------------------------------
    // studio chain + genre/tag hierarchy (always upserted — see header)
    // ------------------------------------------------------------------
    const studioChainResolved = input.studioChain.length > 0 ? await upsertStudioChain(innerTrx, input.studioChain) : [];
    const sceneTagsResolved = await upsertSceneTags(innerTrx, input.tags, input.genreTagNames);

    const finalStudioName = 'studio' in merged.fields ? (merged.fields.studio as string | null) : currentStudioName;
    let studioEdgeTagId: string | null = null;
    if (finalStudioName != null) {
      const direct = studioChainResolved[0];
      studioEdgeTagId = direct && direct.name === finalStudioName ? direct.tagId : await (async () => (await findOrCreateTag(innerTrx, finalStudioName, STASH_CONTENT_CLASS)).id)();
    }

    const finalGenres = (merged.fields.genres as string[] | undefined) ?? currentRelations.genres;
    const finalTags = (merged.fields.tags as string[] | undefined) ?? currentRelations.tags;

    const tagInputs: { tagId: string; kind: ItemTagKind }[] = [];
    for (const name of finalGenres) {
      tagInputs.push({ tagId: await resolveTagIdForName(innerTrx, name, sceneTagsResolved), kind: 'genre' });
    }
    for (const name of finalTags) {
      tagInputs.push({ tagId: await resolveTagIdForName(innerTrx, name, sceneTagsResolved), kind: 'tag' });
    }
    if (studioEdgeTagId) {
      tagInputs.push({ tagId: studioEdgeTagId, kind: 'studio' });
    }
    await replaceItemTags(innerTrx, item.id, tagInputs);

    // ------------------------------------------------------------------
    // performers (S5/K3)
    // ------------------------------------------------------------------
    const finalPeople = (merged.fields.people as PersonCredit[] | undefined) ?? currentRelations.people;
    const personIdByName = new Map<string, string>();
    const peopleInputs: { personId: string; role: PersonCredit['role']; credit: string | null; order: number }[] = [];
    for (const p of finalPeople) {
      const person = await findOrCreatePerson(innerTrx, p.name, STASH_CONTENT_CLASS);
      personIdByName.set(p.name, person.id);
      peopleInputs.push({ personId: person.id, role: p.role, credit: p.credit ?? null, order: p.order });
    }
    await replaceItemPeople(innerTrx, item.id, peopleInputs);

    const stashPerformerByName = new Map(input.performers.map((p) => [p.name, p] as const));
    for (const p of finalPeople) {
      const stashPerformer = stashPerformerByName.get(p.name);
      if (!stashPerformer) continue; // not from this scene's Stash bundle (e.g. a locked fallback to a manually-assigned credit) — nothing to enrich.
      const personId = personIdByName.get(p.name)!;
      await writePerformerAttributes(innerTrx, personId, stashPerformer);
      if (stashPerformer.imageBlobChecksum && !(await hasOriginalImage(innerTrx, 'person', personId, 'thumb'))) {
        pendingImageTasks.push({
          entityType: 'person',
          entityId: personId,
          kind: 'thumb',
          checksum: stashPerformer.imageBlobChecksum,
          filenameHint: `performer-${stashPerformer.id}`,
        });
      }
    }

    // ------------------------------------------------------------------
    // studio logos (always considered — shared entities, see header)
    // ------------------------------------------------------------------
    for (let i = 0; i < input.studioChain.length; i++) {
      const node = input.studioChain[i]!;
      const resolvedNode = studioChainResolved[i]!;
      if (node.imageBlobChecksum && !(await hasOriginalImage(innerTrx, 'tag', resolvedNode.tagId, 'logo'))) {
        pendingImageTasks.push({ entityType: 'tag', entityId: resolvedNode.tagId, kind: 'logo', checksum: node.imageBlobChecksum, filenameHint: `studio-${node.id}` });
      }
    }

    // ------------------------------------------------------------------
    // cover art (always refreshed — see header)
    // ------------------------------------------------------------------
    if (input.scene.coverBlobChecksum) {
      pendingImageTasks.push({
        entityType: 'catalog_item',
        entityId: item.id,
        kind: 'poster',
        checksum: input.scene.coverBlobChecksum,
        filenameHint: `scene-${input.stashSceneId}-cover`,
      });
    }

    // ------------------------------------------------------------------
    // scene-level extras (S5/K11)
    // ------------------------------------------------------------------
    await writeSceneAttributes(innerTrx, item.id, input);

    // ------------------------------------------------------------------
    // markers → chapters (S7/K9)
    // ------------------------------------------------------------------
    const tagsById = new Map(input.tags.map((t) => [t.id, t] as const));
    await replaceChapterMarkers(
      innerTrx,
      item.id,
      input.markers.map((m) => ({
        title: chapterTitleFor(m, tagsById),
        startMs: Math.round(m.startSeconds * 1000),
        source: 'stash' as const,
      }))
    );

    // ------------------------------------------------------------------
    // provenance + event (mirrors metadata/consumer.ts exactly)
    // ------------------------------------------------------------------
    for (const p of merged.provenance) {
      await upsertMetadataProvenance(innerTrx, { itemId: item.id, field: p.field, source: p.source, updatedAtMs: now });
    }

    if (changed.length > 0) {
      await writeEvent(innerTrx, {
        type: 'item.updated',
        tsMs: now,
        payload: { itemId: item.id, libraryId: item.libraryId, itemType: item.itemType, contentClass: item.contentClass, changedFields: changed, updatedAtMs: now },
      });
    }

    return changed;
  });

  // ------------------------------------------------------------------
  // image jobs — AFTER commit (this file's header)
  // ------------------------------------------------------------------
  for (const task of pendingImageTasks) {
    const blob = deps.getBlob(task.checksum);
    if (!blob || !blob.bytes) continue; // no bytes available — read-model.ts's getBlob header; never throws.
    const sourcePath = await stageLocalTempBlob(blob.bytes, task.filenameHint);
    await deps.enqueueImageJob({ entityType: task.entityType, entityId: task.entityId, kind: task.kind, sourcePath });
  }

  return { changedFields: changedFields };
}
