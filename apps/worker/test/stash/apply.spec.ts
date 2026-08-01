// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/apply.spec.ts
//
// Live-DB tests for applyStashSceneMetadata (STATE.md S5-S7, K11).
// SELF-SUFFICIENT: resets @loombre/db's schema and seeds a minimal
// fixture of its own, same convention as apps/worker/test/metadata/
// consumer.spec.ts. Two halves:
//   - "real Stash fixture" — builds an input bundle via ACTUAL read-model
//     calls against the checked-in schema-v67-supported-min.sql fixture
//     (apps/worker/test/stash/fixtures/), proving the mapping end to end
//     against Lane A's own read-model, not just hand-built objects.
//   - "synthetic bundles" — hand-built StashScene/StashPerformer/etc.
//     objects for behaviors easier to isolate that way: locks, runtime_ms
//     preservation, idempotency + image dedup, the genre heuristic and
//     its explicit override, missing blob bytes, the item-deleted race,
//     and the itemType guard.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '@loombre/db';
import type { DB } from '@loombre/db';
import { applyStashSceneMetadata, type ApplyStashSceneMetadataInput } from '../../src/stash/apply.js';
import { metadataConsumerHandler } from '../../src/metadata/consumer.js';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';
import { openStashConnection, type StashConnection } from '../../src/stash/adapter.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';
import { getBlob, getScene, getSceneFiles, getSceneMarkers, getScenePerformers, getSceneTags, getStudio } from '../../src/stash/read-model.js';
import type { StashPerformer, StashScene, StashSceneFile, StashSceneMarker, StashStudio, StashTag } from '../../src/stash/read-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let libraryId: string;

async function insertPlaceholderItem(title = 'placeholder-from-filename.mp4'): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('catalog_items')
    .values({ library_id: libraryId, item_type: 'movie', title, sort_title: title, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

function noopDeps(overrides: Partial<{ getBlob: (checksum: string) => { checksum: string; bytes: Buffer | null } | null; enqueueImageJob: ReturnType<typeof vi.fn> }> = {}) {
  return {
    getBlob: overrides.getBlob ?? (() => null),
    enqueueImageJob: overrides.enqueueImageJob ?? vi.fn(async () => 'job-id'),
  };
}

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Apply Test Library', media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  libraryId = lib.id;
});

afterAll(async () => {
  await db?.destroy();
});

// ============================================================================
// real Stash fixture (schema-v67-supported-min.sql)
// ============================================================================

describe('applyStashSceneMetadata — real Stash fixture (schema-v67)', () => {
  let conn: StashConnection;
  let workDir: string;
  let itemId: string;

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'loombre-apply-fixture-'));
    const dbPath = path.join(workDir, `scene-one-${randomUUID()}.sqlite`);
    buildFixtureDb(path.join(FIXTURES_DIR, 'schema-v67-supported-min.sql'), dbPath).close();
    conn = await openStashConnection({ path: dbPath });
    itemId = await insertPlaceholderItem('scene-one.mp4');
  });

  afterAll(() => {
    conn.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function readBundle(sceneId: string) {
    const scene = getScene(conn.db, sceneId)!;
    const files = getSceneFiles(conn.db, sceneId);
    const performers = getScenePerformers(conn.db, sceneId);
    const tags = getSceneTags(conn.db, sceneId);
    const markers = getSceneMarkers(conn.db, sceneId);
    const studioChain = scene.studioId ? [getStudio(conn.db, scene.studioId)!] : [];
    return { scene, files, performers, tags, markers, studioChain };
  }

  it('maps a fully-populated real scene end to end', async () => {
    const bundle = readBundle('1');
    const enqueueImageJob = vi.fn(async () => 'job-id');
    const getBlobDep = (checksum: string) => getBlob(conn.db, checksum);

    const result = await applyStashSceneMetadata(
      db,
      { getBlob: getBlobDep, enqueueImageJob },
      { libraryId, itemId, stashSceneId: '1', genreTagNames: null, ...bundle }
    );

    expect(result.changedFields.sort()).toEqual(
      ['title', 'sortTitle', 'year', 'premiereAtMs', 'overview', 'communityRating', 'studio', 'genres', 'tags', 'people'].sort()
    );

    const item = await db.selectFrom('catalog_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('Scene One');
    expect(item.sort_title).toBe('scene one');
    expect(item.year).toBe(2023);
    expect(item.community_rating).toBeCloseTo(8.5);

    const details = await db.selectFrom('movie_details').selectAll().where('item_id', '=', itemId).executeTakeFirstOrThrow();
    expect(details.overview).toBe('Details for scene one.');
    expect(details.premiere_at_ms).toBe(Date.parse('2023-06-15'));
    // S5: NEVER Stash-sourced.
    expect(details.runtime_ms).toBeNull();

    const providerIdRow = await db.selectFrom('provider_ids').selectAll().where('item_id', '=', itemId).where('provider', '=', 'stash').executeTakeFirstOrThrow();
    expect(providerIdRow.external_id).toBe(`${libraryId}:1`);

    // studio + genre/tag hierarchy
    const edges = await db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['tags.name as name', 'tags.kind as entityKind', 'item_tags.kind as edgeKind', 'tags.parent_tag_id as parentTagId', 'tags.id as tagId'])
      .where('item_tags.item_id', '=', itemId)
      .execute();

    const studioEdge = edges.find((e) => e.edgeKind === 'studio');
    expect(studioEdge?.name).toBe('Acme Studios');
    expect(studioEdge?.entityKind).toBe('studio');

    const actionEdge = edges.find((e) => e.name === 'Action');
    expect(actionEdge?.edgeKind).toBe('genre'); // root tag -> default genre heuristic
    expect(actionEdge?.entityKind).toBe('genre');
    expect(actionEdge?.parentTagId).toBeNull();

    const fightSceneEdge = edges.find((e) => e.name === 'Fight Scene');
    expect(fightSceneEdge?.edgeKind).toBe('tag'); // has a parent -> not a genre by default
    expect(fightSceneEdge?.entityKind).toBe('general');
    expect(fightSceneEdge?.parentTagId).toBe(actionEdge?.tagId);

    // performers
    const people = await db
      .selectFrom('item_people')
      .innerJoin('people', 'people.id', 'item_people.person_id')
      .select(['people.name as name', 'item_people.role as role', 'item_people.ord as ord', 'item_people.person_id as personId'])
      .where('item_people.item_id', '=', itemId)
      .orderBy('item_people.ord', 'asc')
      .execute();
    expect(people.map((p) => p.name)).toEqual(['Jane Doe', 'John Smith']);
    expect(people.every((p) => p.role === 'performer')).toBe(true);

    const janeId = people.find((p) => p.name === 'Jane Doe')!.personId;
    const janeAttrs = await db.selectFrom('person_attributes').selectAll().where('person_id', '=', janeId).where('namespace', '=', 'stash').execute();
    // read-model.ts's readPerformerAliases orders by `alias ASC`
    // (case-sensitive ASCII — 'J','D' sorts before 'J','a').
    expect(janeAttrs.find((a) => a.key === 'aliases')?.value).toEqual({ aliases: ['JD', 'Jane D.'] });
    expect(janeAttrs.find((a) => a.key === 'country')?.value).toEqual({ country: 'USA' });
    expect(janeAttrs.find((a) => a.key === 'measurements')?.value).toEqual({ measurements: '34-24-35' });
    expect(janeAttrs.find((a) => a.key === 'gender')?.value).toEqual({ gender: 'FEMALE' });
    expect(janeAttrs.find((a) => a.key === 'birthdate')?.value).toEqual({ raw: '1990-05-01', ms: Date.parse('1990-05-01') });

    // scene-level extras
    const sceneAttrs = await db.selectFrom('item_attributes').selectAll().where('item_id', '=', itemId).where('namespace', '=', 'stash').execute();
    expect(sceneAttrs.find((a) => a.key === 'sceneId')?.value).toEqual({ sceneId: '1' });
    expect(sceneAttrs.find((a) => a.key === 'rating100')?.value).toEqual({ rating100: 85 });
    expect(sceneAttrs.find((a) => a.key === 'code')?.value).toEqual({ code: 'ABC-123' });
    expect(sceneAttrs.find((a) => a.key === 'director')?.value).toEqual({ director: 'Some Director' });
    expect(sceneAttrs.find((a) => a.key === 'organized')?.value).toEqual({ organized: true });
    expect(sceneAttrs.find((a) => a.key === 'primaryFilePath')?.value).toEqual({ path: '/data/videos/scene-one.mp4' });

    // markers -> chapters
    const chapters = await db.selectFrom('chapter_markers').selectAll().where('item_id', '=', itemId).execute();
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe('Marker One');
    expect(chapters[0]!.start_ms).toBe(30_500);
    expect(chapters[0]!.source).toBe('stash');

    // provenance — every mapped field carries provider:stash
    const provenance = await db.selectFrom('metadata_provenance').selectAll().where('item_id', '=', itemId).execute();
    for (const field of ['title', 'sortTitle', 'year', 'premiereAtMs', 'overview', 'communityRating', 'studio', 'genres', 'tags', 'people']) {
      expect(provenance.find((p) => p.field === field)?.source).toBe('provider:stash');
    }

    // item.updated event
    const events = await db.selectFrom('events').selectAll().where('type', '=', 'item.updated').execute();
    const payload = events.find((e) => (e.payload as { itemId?: string }).itemId === itemId)?.payload as { changedFields: string[] } | undefined;
    expect(payload?.changedFields).toBeDefined();

    // images: cover (blob present) + studio logo (blob present) — Jane
    // Doe/John Smith both have image_blob NULL, so NO performer job.
    expect(enqueueImageJob).toHaveBeenCalledTimes(2);
    const calls = enqueueImageJob.mock.calls.map((c) => c[0] as { entityType: string; kind: string });
    expect(calls.find((c) => c.entityType === 'catalog_item')?.kind).toBe('poster');
    expect(calls.find((c) => c.entityType === 'tag')?.kind).toBe('logo');
  });

  it('maps a mostly-empty real scene (scene 2: has a title, everything else null/empty/false)', async () => {
    const emptyItemId = await insertPlaceholderItem('scene-two.mkv');
    const bundle = readBundle('2');

    await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId: emptyItemId, stashSceneId: '2', genreTagNames: null, ...bundle });

    const item = await db.selectFrom('catalog_items').selectAll().where('id', '=', emptyItemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('Scene Two'); // Stash's title (fixture scene 2 has a title, unlike every other field).
    expect(item.sort_title).toBe('scene two');
    expect(item.year).toBeNull();
    expect(item.community_rating).toBeNull();

    const details = await db.selectFrom('movie_details').selectAll().where('item_id', '=', emptyItemId).executeTakeFirstOrThrow();
    expect(details.overview).toBeNull();
    expect(details.premiere_at_ms).toBeNull();

    const edges = await db.selectFrom('item_tags').selectAll().where('item_id', '=', emptyItemId).execute();
    expect(edges).toHaveLength(0); // no studio, no tags on scene 2.

    const people = await db.selectFrom('item_people').selectAll().where('item_id', '=', emptyItemId).execute();
    expect(people).toHaveLength(0);

    const chapters = await db.selectFrom('chapter_markers').selectAll().where('item_id', '=', emptyItemId).execute();
    expect(chapters).toHaveLength(0); // scene 2 has no markers.

    const sceneAttrs = await db.selectFrom('item_attributes').selectAll().where('item_id', '=', emptyItemId).where('namespace', '=', 'stash').execute();
    expect(sceneAttrs.find((a) => a.key === 'organized')?.value).toEqual({ organized: false });
    expect(sceneAttrs.find((a) => a.key === 'code')?.value).toEqual({ code: null });
  });
});

// ============================================================================
// synthetic bundles
// ============================================================================

function syntheticScene(overrides: Partial<StashScene> = {}): StashScene {
  return {
    id: 'synthetic-scene',
    title: 'Synthetic Scene',
    details: 'Synthetic overview.',
    date: '2020-01-15',
    rating100: 70,
    studioId: null,
    code: null,
    director: null,
    organized: false,
    coverBlobChecksum: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function syntheticBundle(overrides: Partial<ApplyStashSceneMetadataInput> = {}): Omit<ApplyStashSceneMetadataInput, 'libraryId' | 'itemId'> {
  const files: StashSceneFile[] = [];
  const performers: StashPerformer[] = [];
  const studioChain: StashStudio[] = [];
  const tags: StashTag[] = [];
  const markers: StashSceneMarker[] = [];
  return {
    stashSceneId: 'synthetic-scene',
    scene: syntheticScene(),
    files,
    performers,
    studioChain,
    tags,
    markers,
    genreTagNames: null,
    ...overrides,
  };
}

describe('applyStashSceneMetadata — synthetic bundles', () => {
  it('a locked field is never rewritten', async () => {
    const itemId = await insertPlaceholderItem('locked-title.mp4');
    const now = Date.now();
    await db.insertInto('metadata_provenance').values({ item_id: itemId, field: 'title', source: 'nfo', locked: true, updated_at_ms: now }).execute();

    const result = await applyStashSceneMetadata(db, noopDeps(), {
      libraryId,
      itemId,
      ...syntheticBundle({ scene: syntheticScene({ title: 'Should Not Win' }) }),
    });

    expect(result.changedFields).not.toContain('title');
    const item = await db.selectFrom('catalog_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('locked-title.mp4');

    const provenance = await db.selectFrom('metadata_provenance').selectAll().where('item_id', '=', itemId).where('field', '=', 'title').executeTakeFirstOrThrow();
    expect(provenance.source).toBe('nfo');
    expect(provenance.locked).toBe(true);
  });

  it('NEVER writes runtime_ms/content_rating/tagline from Stash — always preserves the current value', async () => {
    const itemId = await insertPlaceholderItem('runtime-preserved.mp4');
    await db
      .insertInto('movie_details')
      .values({ item_id: itemId, content_rating: 'R', runtime_ms: 7_260_000, tagline: 'Existing tagline', overview: null })
      .execute();

    await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId, ...syntheticBundle() });

    const details = await db.selectFrom('movie_details').selectAll().where('item_id', '=', itemId).executeTakeFirstOrThrow();
    expect(details.runtime_ms).toBe(7_260_000);
    expect(details.content_rating).toBe('R');
    expect(details.tagline).toBe('Existing tagline');
  });

  it('rating100 is divided by 10 to reach the 0-10 community_rating scale', async () => {
    const itemId = await insertPlaceholderItem('rating.mp4');
    await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId, ...syntheticBundle({ scene: syntheticScene({ rating100: 85 }) }) });
    const item = await db.selectFrom('catalog_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.community_rating).toBeCloseTo(8.5);
  });

  it('re-applying an UNCHANGED bundle is idempotent: stable entity ids, no duplicate rows, deduped performer/studio image enqueue', async () => {
    const itemId = await insertPlaceholderItem('idempotent.mp4');
    const performer: StashPerformer = {
      id: 'perf-1',
      name: 'Idempotent Performer',
      disambiguation: null,
      aliases: [],
      gender: null,
      birthdate: null,
      country: null,
      measurements: null,
      details: null,
      rating100: null,
      imageBlobChecksum: 'perf-checksum',
    };
    const studio: StashStudio = { id: 'studio-1', name: 'Idempotent Studio', parentId: null, details: null, rating100: null, imageBlobChecksum: 'studio-checksum' };
    const bundle = syntheticBundle({
      scene: syntheticScene({ coverBlobChecksum: 'cover-checksum' }),
      performers: [performer],
      studioChain: [studio],
    });

    const enqueueImageJob = vi.fn(async () => 'job-id');
    const getBlobFn = () => ({ checksum: 'x', bytes: Buffer.from('bytes') });
    const deps = { getBlob: getBlobFn, enqueueImageJob };

    await applyStashSceneMetadata(db, deps, { libraryId, itemId, ...bundle });

    const itemAfterFirst = await db.selectFrom('catalog_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
    const tagAfterFirst = await db.selectFrom('tags').selectAll().where('name', '=', 'Idempotent Studio').executeTakeFirstOrThrow();
    const personAfterFirst = await db.selectFrom('people').selectAll().where('name', '=', 'Idempotent Performer').executeTakeFirstOrThrow();
    const attrAfterFirst = await db.selectFrom('item_attributes').selectAll().where('item_id', '=', itemId).where('key', '=', 'sceneId').executeTakeFirstOrThrow();
    const providerIdAfterFirst = await db.selectFrom('provider_ids').selectAll().where('item_id', '=', itemId).where('provider', '=', 'stash').executeTakeFirstOrThrow();

    // cover + studio logo + performer thumb — nothing is ingested yet, so
    // the dedup guard (hasOriginalImage) has nothing to find on this FIRST
    // apply; it only starts skipping once an "original" images row
    // exists, which happens below (simulating a real image-job run).
    expect(enqueueImageJob).toHaveBeenCalledTimes(3);

    // Simulate the performer/studio images having been ingested by now
    // (what a real image-job run would have produced) so the SECOND
    // apply's dedup guard has something to find.
    await db
      .insertInto('images')
      .values([
        { entity_type: 'tag', entity_id: tagAfterFirst.id, kind: 'logo', source: 'provider', width: null, height: null, file_path: '/data/x', created_at_ms: 1 },
        { entity_type: 'person', entity_id: personAfterFirst.id, kind: 'thumb', source: 'provider', width: null, height: null, file_path: '/data/y', created_at_ms: 1 },
      ])
      .execute();

    const enqueueImageJobSecond = vi.fn(async () => 'job-id');
    await applyStashSceneMetadata(db, { getBlob: getBlobFn, enqueueImageJob: enqueueImageJobSecond }, { libraryId, itemId, ...bundle });

    const itemAfterSecond = await db.selectFrom('catalog_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
    const tagAfterSecond = await db.selectFrom('tags').selectAll().where('name', '=', 'Idempotent Studio').executeTakeFirstOrThrow();
    const personAfterSecond = await db.selectFrom('people').selectAll().where('name', '=', 'Idempotent Performer').executeTakeFirstOrThrow();
    const attrAfterSecond = await db.selectFrom('item_attributes').selectAll().where('item_id', '=', itemId).where('key', '=', 'sceneId').executeTakeFirstOrThrow();
    const providerIdAfterSecond = await db.selectFrom('provider_ids').selectAll().where('item_id', '=', itemId).where('provider', '=', 'stash').executeTakeFirstOrThrow();

    expect(itemAfterSecond.id).toBe(itemAfterFirst.id);
    expect(tagAfterSecond.id).toBe(tagAfterFirst.id);
    expect(personAfterSecond.id).toBe(personAfterFirst.id);
    expect(attrAfterSecond.id).toBe(attrAfterFirst.id);
    expect(providerIdAfterSecond.id).toBe(providerIdAfterFirst.id);

    const tagRows = await db.selectFrom('tags').selectAll().where('name', '=', 'Idempotent Studio').execute();
    expect(tagRows).toHaveLength(1); // no duplicate tag row

    // cover is ALWAYS re-enqueued (S8 diffing bounds how often apply()
    // runs at all); performer/studio images are DEDUPED once an original
    // row exists.
    expect(enqueueImageJobSecond).toHaveBeenCalledTimes(1);
    const secondCalls = enqueueImageJobSecond.mock.calls.map((c) => c[0] as { entityType: string });
    expect(secondCalls.every((c) => c.entityType === 'catalog_item')).toBe(true);
  });

  it('genre_tag_names (explicit, case-insensitive) overrides the default root-tag heuristic', async () => {
    const itemId = await insertPlaceholderItem('genre-override.mp4');
    const root: StashTag = { id: 'tag-root', name: 'Action', description: null, imageBlobChecksum: null, parentIds: [], childIds: ['tag-child'] };
    const child: StashTag = { id: 'tag-child', name: 'Fight Scene', description: null, imageBlobChecksum: null, parentIds: ['tag-root'], childIds: [] };

    // Explicit list names the CHILD as genre (by a different case) — the
    // default heuristic would have picked the ROOT instead.
    await applyStashSceneMetadata(db, noopDeps(), {
      libraryId,
      itemId,
      ...syntheticBundle({ tags: [root, child], genreTagNames: ['fight scene'] }),
    });

    const edges = await db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['tags.name as name', 'item_tags.kind as edgeKind'])
      .where('item_tags.item_id', '=', itemId)
      .execute();

    expect(edges.find((e) => e.name === 'Fight Scene')?.edgeKind).toBe('genre');
    expect(edges.find((e) => e.name === 'Action')?.edgeKind).toBe('tag');
  });

  it('a missing blob (getBlob returns bytes:null) skips that image job without throwing', async () => {
    const itemId = await insertPlaceholderItem('missing-blob.mp4');
    const enqueueImageJob = vi.fn(async () => 'job-id');

    await expect(
      applyStashSceneMetadata(
        db,
        { getBlob: () => ({ checksum: 'x', bytes: null }), enqueueImageJob },
        { libraryId, itemId, ...syntheticBundle({ scene: syntheticScene({ coverBlobChecksum: 'checksum-with-no-bytes' }) }) }
      )
    ).resolves.toBeDefined();

    expect(enqueueImageJob).not.toHaveBeenCalled();
  });

  it('an unknown checksum (getBlob returns null) skips that image job without throwing', async () => {
    const itemId = await insertPlaceholderItem('unknown-checksum.mp4');
    const enqueueImageJob = vi.fn(async () => 'job-id');

    await applyStashSceneMetadata(
      db,
      { getBlob: () => null, enqueueImageJob },
      { libraryId, itemId, ...syntheticBundle({ scene: syntheticScene({ coverBlobChecksum: 'unknown' }) }) }
    );

    expect(enqueueImageJob).not.toHaveBeenCalled();
  });

  it('a race — the item no longer exists — is a no-op, not an error', async () => {
    const bogusId = '018f6f1e-0000-7000-8000-00000000feed';
    const result = await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId: bogusId, ...syntheticBundle() });
    expect(result.changedFields).toEqual([]);

    const rows = await db.selectFrom('item_attributes').selectAll().where('item_id', '=', bogusId).execute();
    expect(rows).toHaveLength(0);
  });

  it('an item_type other than "movie" throws (K1 invariant, not a benign race)', async () => {
    const now = Date.now();
    const seriesItem = await db
      .insertInto('catalog_items')
      .values({ library_id: libraryId, item_type: 'series', title: 'Not A Movie', sort_title: 'not a movie', added_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId: seriesItem.id, ...syntheticBundle() })).rejects.toThrow(/item_type/);
  });

  it('markers fall back to the primary tag name when the marker title is empty', async () => {
    const itemId = await insertPlaceholderItem('marker-fallback.mp4');
    const primaryTag: StashTag = { id: 'marker-tag', name: 'Establishing Shot', description: null, imageBlobChecksum: null, parentIds: [], childIds: [] };
    const marker: StashSceneMarker = { id: 'marker-1', title: '   ', startSeconds: 12.25, endSeconds: null, primaryTagId: 'marker-tag' };

    await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId, ...syntheticBundle({ tags: [primaryTag], markers: [marker] }) });

    const chapters = await db.selectFrom('chapter_markers').selectAll().where('item_id', '=', itemId).execute();
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe('Establishing Shot');
    expect(chapters[0]!.start_ms).toBe(12_250);
  });

  it('an editorial date written by Stash SURVIVES a later general metadata refresh (K1 absent-means-don\'t-touch, end to end)', async () => {
    // R2 audit. K1 gave movie_details.premiere_at_ms "absent = don't
    // touch" semantics precisely so "the pre-0019 writers (scan hierarchy,
    // import, general metadata refresh) ... must never clobber a value
    // another producer (the Stash mapper) wrote". That seam was real in
    // the type (UpsertSatelliteInput) and real in the writer
    // (packages/db/src/internal/catalog.ts), but NOTHING pinned the
    // consumer side: adding `premiere_at_ms: field(...)` to
    // metadata/consumer.ts's movie branch — a one-line, entirely
    // plausible edit — would silently NULL the Stash-set date on the next
    // TMDB refresh of every zone scene, and every test would still pass.
    //
    // This drives the REAL metadataConsumerHandler with a real (fake-
    // backed) tmdb provider over an item Stash has already mapped, and
    // asserts the refresh genuinely ran (it rewrote the fields it DOES
    // own) while the date it does not own survived untouched.
    const itemId = await insertPlaceholderItem('tmdb-after-stash.mp4');

    await applyStashSceneMetadata(db, noopDeps(), {
      libraryId,
      itemId,
      ...syntheticBundle({ scene: syntheticScene({ title: 'Stash Title', date: '2019-03-04', details: 'Stash overview.' }) }),
    });

    const afterStash = await db.selectFrom('movie_details').selectAll().where('item_id', '=', itemId).executeTakeFirstOrThrow();
    expect(afterStash.premiere_at_ms).toBe(Date.parse('2019-03-04'));

    const tmdb = makeFakeProvider({
      name: 'tmdb',
      contentClass: 'general',
      kinds: ['movie'],
      searchResults: [{ ref: { provider: 'tmdb', externalId: '999', mediaKind: 'movie' }, title: 'Stash Title', year: 2019 }],
      details: {
        itemType: 'movie',
        title: 'TMDB Title',
        sortTitle: 'TMDB Title',
        year: 2019,
        overview: 'TMDB overview.',
        communityRating: 6.4,
        contentRating: 'PG-13',
        genres: [],
        tags: [],
        people: [],
        providerIds: { tmdb: '999' },
        tagline: 'A TMDB tagline.',
        runtimeMs: 5_400_000,
      },
      images: [],
    });
    const registry = new ProviderRegistry();
    registry.register(tmdb);
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob: vi.fn(async () => 'job-id'), log: () => {} });

    await handler({ itemId, mediaKind: 'movie', contentClass: 'restricted' }, { jobId: 'r2-tmdb-after-stash' });

    const afterTmdb = await db.selectFrom('movie_details').selectAll().where('item_id', '=', itemId).executeTakeFirstOrThrow();
    // The refresh really happened — these are the general path's own fields.
    expect(afterTmdb.overview).toBe('TMDB overview.');
    expect(afterTmdb.runtime_ms).toBe(5_400_000); // S5: technical facts are NOT Stash's
    expect(afterTmdb.tagline).toBe('A TMDB tagline.');
    // ...and the field only the Stash path knows how to write is untouched.
    expect(afterTmdb.premiere_at_ms).toBe(Date.parse('2019-03-04'));
  });

  it('a studio parent chain sets parent_tag_id from root to leaf, and attaches the LEAF (index 0) to the item', async () => {
    const itemId = await insertPlaceholderItem('studio-chain.mp4');
    const leaf: StashStudio = { id: 'studio-leaf', name: 'Leaf Studio', parentId: 'studio-mid', details: null, rating100: null, imageBlobChecksum: null };
    const mid: StashStudio = { id: 'studio-mid', name: 'Mid Studio', parentId: 'studio-root', details: null, rating100: null, imageBlobChecksum: null };
    const root: StashStudio = { id: 'studio-root', name: 'Root Studio', parentId: null, details: null, rating100: null, imageBlobChecksum: null };

    await applyStashSceneMetadata(db, noopDeps(), { libraryId, itemId, ...syntheticBundle({ studioChain: [leaf, mid, root] }) });

    const rootTag = await db.selectFrom('tags').selectAll().where('name', '=', 'Root Studio').executeTakeFirstOrThrow();
    const midTag = await db.selectFrom('tags').selectAll().where('name', '=', 'Mid Studio').executeTakeFirstOrThrow();
    const leafTag = await db.selectFrom('tags').selectAll().where('name', '=', 'Leaf Studio').executeTakeFirstOrThrow();

    expect(rootTag.parent_tag_id).toBeNull();
    expect(midTag.parent_tag_id).toBe(rootTag.id);
    expect(leafTag.parent_tag_id).toBe(midTag.id);
    expect([rootTag.kind, midTag.kind, leafTag.kind]).toEqual(['studio', 'studio', 'studio']);

    const studioEdge = await db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select('tags.name as name')
      .where('item_tags.item_id', '=', itemId)
      .where('item_tags.kind', '=', 'studio')
      .executeTakeFirstOrThrow();
    expect(studioEdge.name).toBe('Leaf Studio');
  });
});
