// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/clear-consumer.spec.ts
//
// Live-DB test for the 'metadata-clear' job (owner ruling 2026-09-07):
// a wrongly matched movie goes back to what the scan saw.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import {
  findOrCreatePerson,
  findOrCreateTag,
  replaceItemPeople,
  replaceItemTags,
  upsertImage,
  upsertMetadataProvenance,
  upsertProviderId,
  upsertSatellite,
} from '@loombre/db/internal';
import { runMetadataClear, sortTitleFor } from '../../src/metadata/clear-consumer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_metadata_clear_test');

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: DB_PKG_ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
}

let db: ReturnType<typeof createDb>;
let libraryId: string;

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Clear Test Movies', media_kind: 'movie', paths: ['/media/movies'], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  libraryId = lib.id;
});

afterAll(async () => {
  await db?.destroy();
});

describe('sortTitleFor', () => {
  it('moves a leading article the way the scanner does', () => {
    expect(sortTitleFor('The Idol')).toBe('Idol, The');
    expect(sortTitleFor('Thor')).toBe('Thor');
  });
});

describe('runMetadataClear', () => {
  it('drops the provider match, provenance, tags, people, provider images (rows + files) and satellite fields; re-derives title/year from the file; turns auto-match off', async () => {
    const now = Date.now();
    // The wrong match wrote "The Idols Curse (2019)" over a file that is plainly "The Idol (2023)".
    const item = await db
      .insertInto('catalog_items')
      .values({ library_id: libraryId, item_type: 'movie', title: 'The Idols Curse', sort_title: 'Idols Curse, The', year: 2019, community_rating: 6.1, added_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('media_files')
      .values({ item_id: item.id, path: '/media/movies/The Idol (2023)/The.Idol.2023.1080p.mkv', size_bytes: 1, container: 'mkv', duration_ms: 1000 })
      .execute();
    await upsertProviderId(db, { itemId: item.id, provider: 'tmdb', externalId: '999' });
    await upsertMetadataProvenance(db, { itemId: item.id, field: 'title', source: 'provider:tmdb', updatedAtMs: now });
    await upsertSatellite(db, { itemType: 'movie', item_id: item.id, overview: 'wrong', content_rating: 'R', tagline: 'wrong', runtime_ms: 1 });
    const tag = await findOrCreateTag(db, 'Horror', 'general');
    await replaceItemTags(db, item.id, [{ tagId: tag.id, kind: 'genre' }]);
    const person = await findOrCreatePerson(db, 'Wrong Actor', 'general');
    await replaceItemPeople(db, item.id, [{ personId: person.id, role: 'actor', credit: null, order: 0 }]);
    await upsertImage(db, { entityType: 'catalog_item', entityId: item.id, kind: 'poster', source: 'provider', width: null, height: 100, filePath: '/data/images/x/poster-orig.webp', createdAtMs: now, sourceRef: 'url:x' });
    await upsertImage(db, { entityType: 'catalog_item', entityId: item.id, kind: 'poster', source: 'local', width: 320, height: 100, filePath: '/data/images/x/folder-320.webp', createdAtMs: now });

    const unlinked: string[] = [];
    const result = await runMetadataClear({ db, log: () => {}, unlinkFile: async (p) => { unlinked.push(p); } }, item.id);
    expect(result).toEqual({ cleared: true, imagesRemoved: 1 });
    expect(unlinked).toEqual(['/data/images/x/poster-orig.webp']);

    const row = await db.selectFrom('catalog_items').selectAll().where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ title: 'The Idol', sort_title: 'Idol, The', year: 2023, community_rating: null, metadata_auto_match: false });
    expect(await db.selectFrom('provider_ids').select('id').where('item_id', '=', item.id).execute()).toHaveLength(0);
    expect(await db.selectFrom('metadata_provenance').select('field').where('item_id', '=', item.id).execute()).toHaveLength(0);
    expect(await db.selectFrom('item_tags').select('tag_id').where('item_id', '=', item.id).execute()).toHaveLength(0);
    expect(await db.selectFrom('item_people').select('person_id').where('item_id', '=', item.id).execute()).toHaveLength(0);
    const images = await db.selectFrom('images').select(['source']).where('entity_id', '=', item.id).execute();
    expect(images).toEqual([{ source: 'local' }]); // folder art stays
    const satellite = await db.selectFrom('movie_details').selectAll().where('item_id', '=', item.id).executeTakeFirstOrThrow();
    expect(satellite).toMatchObject({ overview: null, content_rating: null, tagline: null, runtime_ms: null });
    const events = await db.selectFrom('events').select('payload').where('type', '=', 'item.updated').execute();
    expect(events.some((e) => (e.payload as { itemId: string }).itemId === item.id)).toBe(true);
  });

  it('is a no-op for an unknown item', async () => {
    expect(await runMetadataClear({ db, log: () => {} }, '018f6f1e-0000-7000-8000-00000000dead')).toEqual({ cleared: false, imagesRemoved: 0 });
  });
});
