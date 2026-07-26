// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/import/diff-archive.ts
//
// Test-only deep-comparison tool for the export -> import round-trip exit
// bar (Phase 4 lane E, deliverable 2). Compares a captured ExportArchive
// (the parsed JSON body of a REAL GET /export call) against the rows a
// REAL import job wrote into a target database, walking every table the
// archive is actually relevant to.
//
// Uses the SAME `Kysely<DB>` handle @loombre/db's public createDb() already
// returns (query-builder method calls only, no raw SQL strings) rather than
// a separate `pg` client: apps/server has no direct `pg`/`kysely` package
// dependency of its own (LOCKFILE FROZEN — no new deps), and every OTHER
// query in this codebase already goes through exactly this handle anyway
// (CLAUDE.md invariant 4's spirit, even though this file's queries are
// deliberately unguarded test verification, not a viewer-facing surface).
//
// Deliberately NOT "source database vs target database" — the archive
// itself is the correct diff baseline, not the exporting admin's raw
// tables: GET /export is viewer-scoped (packages/db/src/query/export.ts),
// so the source database legitimately contains MORE than what the archive
// carries (another user's progress, a library this admin never granted
// itself, ...) — diffing against the raw source tables would produce
// false-positive "mismatches" for exclusions that are correct BY DESIGN,
// not bugs. Diffing against the archive itself proves the only claim that
// actually matters: "the target database now contains exactly what the
// archive said it should."
//
// EXCLUSION LIST (every one justified inline, per deliverable 2's
// requirement) — tables/columns this tool does NOT compare:
//   - media_files.path/content_hash/probe/probed_at_ms/mtime_ms: never in
//     the archive (packages/contract/openapi.yaml's MediaFileSummary has no
//     such fields) — see apps/worker/src/import/consumer.ts's module
//     header. Compared instead: id/item_id/container/size_bytes/
//     duration_ms/version_label (everything the archive DOES carry) plus a
//     direct assertion that missing_since_ms is non-null and path is a
//     synthesized placeholder (P1.2 state, verified, not diffed against a
//     "real" value that was never exported).
//   - media_streams, images, provider_ids: never in the archive at all
//     (no schema field anywhere) — asserted to be exactly EMPTY for every
//     imported item/library, not diffed (there is nothing to diff against).
//   - libraries.updated_at_ms / users.updated_at_ms: the export controller
//     (apps/server/src/catalog/data-freedom.controller.ts's
//     mapExportLibrary) and ExportUser's schema itself never carry a real
//     updatedAtMs distinct from createdAtMs — comparing this column would
//     only ever prove the import consumer copied one archive field into
//     two DB columns, not a real round-trip property.
//   - users.password_hash/birth_date/max_content_rating, user_settings
//     (whole table), library_permissions (whole table, except the
//     general-library auto-grant which this suite asserts separately, not
//     diffed): none of these are in ExportUser/the archive at all — see
//     consumer.ts's module header for the full accounting.
//   - events, jobs, scan_checkpoints, provider_cache (mission's own
//     explicit exclusion list): volatile job/ledger/outbox bookkeeping, not
//     restorable catalog/user data — a rolled-forward job id, a fresh
//     event timestamp, and a provider-response cache are expected to
//     differ on every run by construction, never a regression signal.
//   - devices, refresh_tokens, playback_sessions, hw_capability_snapshots,
//     transcode_sessions and friends: entirely outside data-freedom's
//     scope (not exported, not imported, not touched by this lane).

import type { createDb } from '@loombre/db';

type Db = ReturnType<typeof createDb>;

export interface DiffArchiveLike {
  libraries: { id: string; name: string; mediaKind: string; paths: string[]; contentClass: string; createdAtMs: number }[];
  items: Array<Record<string, unknown> & { id: string; itemType: string; libraryId: string }>;
  users: { id: string; username: string; email: string; isAdmin: boolean; createdAtMs: number }[];
  progress: { itemId: string; positionMs: number; durationMs: number | null; state: string; playCount: number; updatedAtMs: number }[];
}

function pushIfDiff(out: string[], label: string, expected: unknown, actual: unknown): void {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  if (!same) out.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Diffs archive.libraries[] against target `libraries` rows. */
export async function diffLibraries(archive: DiffArchiveLike, target: Db): Promise<string[]> {
  const out: string[] = [];
  for (const lib of archive.libraries) {
    const row = await target.selectFrom('libraries').selectAll().where('id', '=', lib.id).executeTakeFirst();
    if (!row) {
      out.push(`libraries[${lib.id}]: missing in target`);
      continue;
    }
    pushIfDiff(out, `libraries[${lib.id}].name`, lib.name, row.name);
    pushIfDiff(out, `libraries[${lib.id}].media_kind`, lib.mediaKind, row.media_kind);
    pushIfDiff(out, `libraries[${lib.id}].paths`, lib.paths, row.paths);
    pushIfDiff(out, `libraries[${lib.id}].content_class`, lib.contentClass, row.content_class);
    pushIfDiff(out, `libraries[${lib.id}].created_at_ms`, lib.createdAtMs, row.created_at_ms);
  }
  const targetRows = await target.selectFrom('libraries').select('id').execute();
  pushIfDiff(out, 'libraries: total row count', archive.libraries.length, targetRows.length);
  return out;
}

const SATELLITE_TABLE_BY_TYPE = {
  movie: 'movie_details',
  series: 'series_details',
  season: 'season_details',
  episode: 'episode_details',
  artist: 'artist_details',
  album: 'album_details',
  track: 'track_details',
} as const;

async function diffSatellite(item: Record<string, unknown> & { id: string; itemType: string }, target: Db): Promise<string[]> {
  const out: string[] = [];
  const label = (table: string) => `${table}[${item.id}]`;

  switch (item.itemType) {
    case 'movie': {
      const row = await target.selectFrom('movie_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.movie)}: missing in target`];
      pushIfDiff(out, `${label('movie_details')}.content_rating`, item['contentRating'], row.content_rating);
      pushIfDiff(out, `${label('movie_details')}.runtime_ms`, item['runtimeMs'], row.runtime_ms);
      pushIfDiff(out, `${label('movie_details')}.tagline`, item['tagline'] ?? null, row.tagline);
      pushIfDiff(out, `${label('movie_details')}.overview`, item['overview'], row.overview);
      return out;
    }
    case 'series': {
      const row = await target.selectFrom('series_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.series)}: missing in target`];
      pushIfDiff(out, `${label('series_details')}.content_rating`, item['contentRating'], row.content_rating);
      pushIfDiff(out, `${label('series_details')}.status`, item['status'], row.status);
      pushIfDiff(out, `${label('series_details')}.overview`, item['overview'], row.overview);
      return out;
    }
    case 'season': {
      const row = await target.selectFrom('season_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.season)}: missing in target`];
      pushIfDiff(out, `${label('season_details')}.season_number`, item['seasonNumber'], row.season_number);
      return out;
    }
    case 'episode': {
      const row = await target.selectFrom('episode_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.episode)}: missing in target`];
      pushIfDiff(out, `${label('episode_details')}.episode_number`, item['episodeNumber'], row.episode_number);
      pushIfDiff(out, `${label('episode_details')}.aired_at_ms`, item['airDateMs'] ?? null, row.aired_at_ms);
      pushIfDiff(out, `${label('episode_details')}.overview`, item['overview'], row.overview);
      return out;
    }
    case 'artist': {
      const row = await target.selectFrom('artist_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.artist)}: missing in target`];
      pushIfDiff(out, `${label('artist_details')}.overview`, item['overview'], row.overview);
      return out;
    }
    case 'album': {
      const row = await target.selectFrom('album_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.album)}: missing in target`];
      pushIfDiff(out, `${label('album_details')}.year`, item['year'], row.year);
      return out;
    }
    case 'track': {
      const row = await target.selectFrom('track_details').selectAll().where('item_id', '=', item.id).executeTakeFirst();
      if (!row) return [`${label(SATELLITE_TABLE_BY_TYPE.track)}: missing in target`];
      pushIfDiff(out, `${label('track_details')}.track_number`, item['trackNumber'], row.track_number);
      pushIfDiff(out, `${label('track_details')}.disc_number`, item['discNumber'] ?? null, row.disc_number);
      pushIfDiff(out, `${label('track_details')}.duration_ms`, item['durationMs'], row.duration_ms);
      return out;
    }
    default:
      return out;
  }
}

const GENRE_ITEM_TYPES = new Set(['movie', 'series', 'artist', 'album']);
const PEOPLE_ITEM_TYPES = new Set(['movie', 'series', 'episode', 'artist']);
const MEDIA_FILE_ITEM_TYPES = new Set(['movie', 'episode', 'track']);

async function diffGenres(item: Record<string, unknown> & { id: string; itemType: string; contentClass: string }, target: Db): Promise<string[]> {
  const out: string[] = [];
  if (!GENRE_ITEM_TYPES.has(item.itemType)) return out;
  const expected = [...((item['genres'] as string[] | undefined) ?? [])].sort();
  const rows = await target
    .selectFrom('item_tags')
    .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
    .select(['tags.name', 'tags.content_class'])
    .where('item_tags.item_id', '=', item.id)
    .where('item_tags.kind', '=', 'genre')
    .execute();
  const actual = rows.map((r) => r.name).sort();
  pushIfDiff(out, `item_tags[${item.id}] genre names`, expected, actual);
  if (rows.some((r) => r.content_class !== item.contentClass)) {
    out.push(`item_tags[${item.id}]: a genre tag's content_class does not match the item's own contentClass "${item.contentClass}"`);
  }
  return out;
}

async function diffPeople(item: Record<string, unknown> & { id: string; itemType: string }, target: Db): Promise<string[]> {
  const out: string[] = [];
  if (!PEOPLE_ITEM_TYPES.has(item.itemType)) return out;
  const expected = ((item['people'] as { name: string; role: string; credit: string | null; order: number }[] | undefined) ?? [])
    .map((p) => `${p.name}|${p.role}|${p.credit ?? ''}|${p.order}`)
    .sort();
  const rows = await target
    .selectFrom('item_people')
    .innerJoin('people', 'people.id', 'item_people.person_id')
    .select(['people.name', 'item_people.role', 'item_people.credit', 'item_people.ord'])
    .where('item_people.item_id', '=', item.id)
    .execute();
  const actual = rows.map((r) => `${r.name}|${r.role}|${r.credit ?? ''}|${r.ord}`).sort();
  pushIfDiff(out, `item_people[${item.id}]`, expected, actual);
  return out;
}

async function diffMediaFiles(item: Record<string, unknown> & { id: string; itemType: string }, target: Db): Promise<string[]> {
  const out: string[] = [];
  if (!MEDIA_FILE_ITEM_TYPES.has(item.itemType)) return out;
  const archiveFiles = (item['mediaFiles'] as { id: string; versionLabel: string | null; container: string | null; sizeBytes: number | null; durationMs: number | null }[] | undefined) ?? [];
  for (const mf of archiveFiles) {
    const row = await target.selectFrom('media_files').selectAll().where('id', '=', mf.id).executeTakeFirst();
    if (!row) {
      out.push(`media_files[${mf.id}] (item ${item.id}): missing in target`);
      continue;
    }
    const label = `media_files[${mf.id}]`;
    pushIfDiff(out, `${label}.item_id`, item.id, row.item_id);
    pushIfDiff(out, `${label}.container`, mf.container, row.container);
    pushIfDiff(out, `${label}.size_bytes`, mf.sizeBytes, row.size_bytes);
    pushIfDiff(out, `${label}.duration_ms`, mf.durationMs, row.duration_ms);
    pushIfDiff(out, `${label}.version_label`, mf.versionLabel, row.version_label);
    // Deliberately NOT diffed against a "real" value (never exported — see
    // module header): asserted instead as the documented P1.2 state.
    if (row.content_hash !== null) out.push(`${label}.content_hash: expected null (never exported), got ${JSON.stringify(row.content_hash)}`);
    if (row.missing_since_ms === null) out.push(`${label}.missing_since_ms: expected non-null (P1.2 missing state), got null`);
    if (typeof row.path !== 'string' || !row.path.startsWith('loombre-import-placeholder://')) {
      out.push(`${label}.path: expected a synthesized placeholder, got ${JSON.stringify(row.path)}`);
    }
  }
  return out;
}

/** Diffs archive.items[] (base fields + satellite + genres + people +
 *  mediaFiles) against target `catalog_items` and its satellite/relation
 *  tables. */
export async function diffItems(archive: DiffArchiveLike, target: Db): Promise<string[]> {
  const out: string[] = [];
  for (const item of archive.items) {
    const row = await target.selectFrom('catalog_items').selectAll().where('id', '=', item.id).executeTakeFirst();
    if (!row) {
      out.push(`catalog_items[${item.id}]: missing in target`);
      continue;
    }
    const label = `catalog_items[${item.id}]`;
    pushIfDiff(out, `${label}.item_type`, item.itemType, row.item_type);
    pushIfDiff(out, `${label}.library_id`, item.libraryId, row.library_id);
    pushIfDiff(out, `${label}.title`, item['title'], row.title);
    pushIfDiff(out, `${label}.sort_title`, item['sortTitle'], row.sort_title);
    pushIfDiff(out, `${label}.year`, item['year'], row.year);
    pushIfDiff(out, `${label}.community_rating`, item['communityRating'], row.community_rating);
    pushIfDiff(out, `${label}.content_class`, item['contentClass'], row.content_class);
    pushIfDiff(out, `${label}.added_at_ms`, item['addedAtMs'], row.added_at_ms);
    pushIfDiff(out, `${label}.updated_at_ms`, item['updatedAtMs'], row.updated_at_ms);

    const expectedParentId =
      item.itemType === 'season' ? item['seriesId'] :
      item.itemType === 'episode' ? item['seasonId'] :
      item.itemType === 'album' ? item['artistId'] :
      item.itemType === 'track' ? item['albumId'] :
      null;
    pushIfDiff(out, `${label}.parent_id`, expectedParentId, row.parent_id);

    out.push(...(await diffSatellite(item, target)));
    out.push(...(await diffGenres({ ...item, contentClass: item['contentClass'] as string }, target)));
    out.push(...(await diffPeople(item, target)));
    out.push(...(await diffMediaFiles(item, target)));
  }
  const targetRows = await target.selectFrom('catalog_items').select('id').execute();
  pushIfDiff(out, 'catalog_items: total row count', archive.items.length, targetRows.length);
  return out;
}

/** Diffs archive.users[] against target `users` rows (see module header
 *  for the deliberately-excluded columns). */
export async function diffUsers(archive: DiffArchiveLike, target: Db): Promise<string[]> {
  const out: string[] = [];
  for (const u of archive.users) {
    const row = await target.selectFrom('users').selectAll().where('id', '=', u.id).executeTakeFirst();
    if (!row) {
      out.push(`users[${u.id}]: missing in target`);
      continue;
    }
    pushIfDiff(out, `users[${u.id}].username`, u.username, row.username);
    pushIfDiff(out, `users[${u.id}].email`, u.email.toLowerCase(), row.email.toLowerCase());
    pushIfDiff(out, `users[${u.id}].is_admin`, u.isAdmin, row.is_admin);
  }
  return out;
}

/** Diffs archive.progress[] against target `progress` rows, all attributed
 *  to `targetUserId` (see consumer.ts's module header — the archive itself
 *  carries no userId). */
export async function diffProgress(archive: DiffArchiveLike, target: Db, targetUserId: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of archive.progress) {
    const row = await target
      .selectFrom('progress')
      .selectAll()
      .where('user_id', '=', targetUserId)
      .where('item_id', '=', p.itemId)
      .executeTakeFirst();
    if (!row) {
      out.push(`progress[${targetUserId},${p.itemId}]: missing in target`);
      continue;
    }
    const label = `progress[${p.itemId}]`;
    pushIfDiff(out, `${label}.position_ms`, p.positionMs, row.position_ms);
    // p.durationMs may be `undefined` here (the archive is the RAW
    // GET /export JSON, not run through the import consumer's own
    // validator) — GET /export's progress entries never include this key
    // at all (see apps/worker/src/import/validate.ts's validateProgress
    // doc comment); normalize the same way the consumer does: absent ~ null.
    pushIfDiff(out, `${label}.duration_ms`, p.durationMs ?? null, row.duration_ms);
    pushIfDiff(out, `${label}.state`, p.state, row.state);
    pushIfDiff(out, `${label}.play_count`, p.playCount, row.play_count);
    pushIfDiff(out, `${label}.updated_at_ms`, p.updatedAtMs, row.updated_at_ms);
  }
  return out;
}

/** Asserts the NEVER-exported tables are exactly empty for the imported
 *  items/libraries — see module header's exclusion list for why these are
 *  asserted-empty rather than diffed. */
export async function assertNeverExportedTablesAreEmpty(archive: DiffArchiveLike, target: Db): Promise<string[]> {
  const out: string[] = [];
  const itemIds = archive.items.map((i) => i.id);
  if (itemIds.length === 0) return out;

  const fileIdRows = await target.selectFrom('media_files').select('id').where('item_id', 'in', itemIds).execute();
  const fileIds = fileIdRows.map((r) => r.id);
  if (fileIds.length > 0) {
    const streams = await target.selectFrom('media_streams').select('id').where('file_id', 'in', fileIds).execute();
    if (streams.length !== 0) out.push(`media_streams: expected 0 rows for imported items, got ${streams.length}`);
  }

  const images = await target
    .selectFrom('images')
    .select('id')
    .where('entity_type', '=', 'catalog_item')
    .where('entity_id', 'in', itemIds)
    .execute();
  if (images.length !== 0) out.push(`images: expected 0 rows for imported items, got ${images.length}`);

  const providerIds = await target.selectFrom('provider_ids').select('id').where('item_id', 'in', itemIds).execute();
  if (providerIds.length !== 0) out.push(`provider_ids: expected 0 rows for imported items, got ${providerIds.length}`);

  return out;
}

export async function diffArchiveAgainstTarget(archive: DiffArchiveLike, target: Db, targetUserId: string): Promise<string[]> {
  return [
    ...(await diffLibraries(archive, target)),
    ...(await diffItems(archive, target)),
    ...(await diffUsers(archive, target)),
    ...(await diffProgress(archive, target, targetUserId)),
    ...(await assertNeverExportedTablesAreEmpty(archive, target)),
  ];
}
