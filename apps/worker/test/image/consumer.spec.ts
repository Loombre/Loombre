// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/consumer.spec.ts
//
// Live-DB integration test for imageConsumerHandler (P1.8). SELF-
// SUFFICIENT: resets @loombre/db's schema and seeds a minimal fixture of
// its own. Proves: variants + blurhash rows + files for a real (existing)
// entity, content-class safety (nothing written for a nonexistent
// entity), and clean job failure for a malformed source.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import { imageConsumerHandler } from '../../src/image/consumer.js';
import { runVariantJob } from '../../src/image/variant-job.js';
import { outputDirFor } from '../../src/image/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_image_consumer_test');

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

let db: ReturnType<typeof createDb>;
let libraryId: string;
let workDir: string;

async function insertItem(title: string): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('catalog_items')
    .values({ library_id: libraryId, item_type: 'movie', title, sort_title: title, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Image Consumer Test Library', media_kind: 'movie', paths: [], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  libraryId = lib.id;
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-image-consumer-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('imageConsumerHandler', () => {
  it('writes original + 3 variant images rows (all sharing the blurhash) and the files exist on disk', async () => {
    const itemId = await insertItem('Poster Test Movie');
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 300, height: 450, channels: 3, background: 'purple' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'catalog_item', entityId: itemId, kind: 'poster', sourcePath }, { jobId: 'img-job-1' });

    const rows = await db
      .selectFrom('images')
      .select(['width', 'height', 'blurhash', 'dominant_color', 'file_path', 'source', 'kind'])
      .where('entity_type', '=', 'catalog_item')
      .where('entity_id', '=', itemId)
      .execute();

    expect(rows).toHaveLength(4); // original + 320 + 720 + 1280
    expect(rows.every((r) => r.kind === 'poster')).toBe(true);
    expect(rows.every((r) => r.source === 'local')).toBe(true);
    const blurhashes = new Set(rows.map((r) => r.blurhash));
    expect(blurhashes.size).toBe(1); // same blurhash on every row of the set
    expect([...blurhashes][0]).toBeTruthy();

    // P2.11: dominant_color is populated on every row (original + variants,
    // same value copied across the set, mirroring blurhash) and matches the
    // purple solid-color source ('#800080').
    const dominantColors = new Set(rows.map((r) => r.dominant_color));
    expect(dominantColors.size).toBe(1);
    const dominantColor = [...dominantColors][0];
    expect(dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    const r = parseInt(dominantColor!.slice(1, 3), 16);
    const g = parseInt(dominantColor!.slice(3, 5), 16);
    const b = parseInt(dominantColor!.slice(5, 7), 16);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(8); // 'purple' = #800080
    expect(Math.abs(g - 0)).toBeLessThanOrEqual(8);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(8);

    const widths = rows.map((r) => r.width).sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(widths).toEqual([null, 320, 720, 1280]);

    const outDir = outputDirFor(workDir, 'catalog_item', itemId);
    const files = await readdir(outDir);
    expect(files).toContain('poster-original.png');
    expect(files).toContain('poster-320.webp');
  });

  it('marks source=provider for a url: source', async () => {
    const itemId = await insertItem('Remote Poster Movie');
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'orange' } }).png().toBuffer();
    const fetchImpl = async (): Promise<Response> => {
      const { Readable } = await import('node:stream');
      const stream = Readable.toWeb(Readable.from([png])) as unknown as ReadableStream;
      return { ok: true, status: 200, statusText: 'OK', body: stream } as Response;
    };

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob, fetchImpl });
    // 93.184.216.34 (this codebase's own convention for "an allowed
    // public IPv4 literal" — packages/plugin-host/test/ssrf.spec.ts), not
    // a hostname, so this stays independent of real DNS: resolveSource now
    // routes url: fetches through the SSRF guard (AUD-A7c-001).
    await handler({ entityType: 'catalog_item', entityId: itemId, kind: 'backdrop', sourcePath: 'url:https://93.184.216.34/x.jpg' }, { jobId: 'img-job-2' });

    const rows = await db.selectFrom('images').select('source').where('entity_id', '=', itemId).execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'provider')).toBe(true);
  });

  it('content-class safety: writes nothing (no rows, no files) for an entity that does not exist', async () => {
    const bogusId = '018f6f1e-0000-7000-8000-00000000feed';
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: 'gray' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'catalog_item', entityId: bogusId, kind: 'poster', sourcePath }, { jobId: 'img-job-3' });

    const rows = await db.selectFrom('images').select('id').where('entity_id', '=', bogusId).execute();
    expect(rows).toHaveLength(0);

    await expect(readdir(outputDirFor(workDir, 'catalog_item', bogusId))).rejects.toThrow();
  });

  // Stash mission (STATE.md S5/S6/K11): apps/worker/src/stash/apply.ts
  // enqueues images for entityType 'tag' (studio logos) and 'person'
  // (performer portraits) — image/consumer.ts's entityExists must
  // recognize both, and local-temp:-staged Stash blobs must record
  // source='provider' (same bucket as a url: fetch), not 'local'.
  it('writes images for entityType "tag" (studio logo) when the tag row exists, source=provider for a local-temp: source', async () => {
    const tag = await db.insertInto('tags').values({ name: 'Acme Studios', content_class: 'restricted', kind: 'studio' }).returningAll().executeTakeFirstOrThrow();
    const sourcePath = join(workDir, 'logo.png');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: 'blue' } }).png().toFile(sourcePath);

    const { stageLocalTempBlob } = await import('../../src/image/download.js');
    const bytes = await (await import('node:fs/promises')).readFile(sourcePath);
    const localTempSource = await stageLocalTempBlob(bytes, 'studio-logo-checksum');

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'tag', entityId: tag.id, kind: 'logo', sourcePath: localTempSource }, { jobId: 'img-job-tag-1' });

    const rows = await db.selectFrom('images').select(['source', 'kind']).where('entity_type', '=', 'tag').where('entity_id', '=', tag.id).execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'provider')).toBe(true);
    expect(rows.every((r) => r.kind === 'logo')).toBe(true);
  });

  it('writes images for entityType "person" (performer portrait) when the person row exists', async () => {
    const person = await db.insertInto('people').values({ name: 'Jane Doe', content_class: 'restricted' }).returningAll().executeTakeFirstOrThrow();
    const sourcePath = join(workDir, 'portrait.png');
    await sharp({ create: { width: 200, height: 300, channels: 3, background: 'green' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'person', entityId: person.id, kind: 'thumb', sourcePath }, { jobId: 'img-job-person-1' });

    const rows = await db.selectFrom('images').select(['source', 'kind']).where('entity_type', '=', 'person').where('entity_id', '=', person.id).execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === 'thumb')).toBe(true);
  });

  it('content-class safety: writes nothing for entityType "tag"/"person" when the row does not exist', async () => {
    const bogusId = '018f6f1e-0000-7000-8000-00000000feed';
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: 'gray' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'tag', entityId: bogusId, kind: 'logo', sourcePath }, { jobId: 'img-job-tag-bogus' });
    await handler({ entityType: 'person', entityId: bogusId, kind: 'thumb', sourcePath }, { jobId: 'img-job-person-bogus' });

    const rows = await db.selectFrom('images').select('id').where('entity_id', '=', bogusId).execute();
    expect(rows).toHaveLength(0);
  });

  it('content-class safety: writes nothing when entityType is "person" but entityId is not actually a people row (e.g. a catalog_items id)', async () => {
    const itemId = await insertItem('Irrelevant');
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: 'gray' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'person', entityId: itemId, kind: 'thumb', sourcePath }, { jobId: 'img-job-4' });

    const rows = await db.selectFrom('images').select('id').where('entity_type', '=', 'person').where('entity_id', '=', itemId).execute();
    expect(rows).toHaveLength(0);
  });

  it('content-class safety: writes nothing for a genuinely unrecognized entityType', async () => {
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: 'gray' } }).png().toFile(sourcePath);

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await handler({ entityType: 'widget', entityId: 'anything', kind: 'thumb', sourcePath }, { jobId: 'img-job-4b' });

    const rows = await db.selectFrom('images').select('id').where('entity_type', '=', 'widget').execute();
    expect(rows).toHaveLength(0);
  });

  it('a malformed source image fails the job cleanly (rejects) without writing any images rows', async () => {
    const itemId = await insertItem('Malformed Image Movie');
    const badPath = join(workDir, 'bad.png');
    await (await import('node:fs/promises')).writeFile(badPath, 'not an image at all');

    const handler = imageConsumerHandler({ db, dataDir: workDir, execute: runVariantJob });
    await expect(handler({ entityType: 'catalog_item', entityId: itemId, kind: 'poster', sourcePath: badPath }, { jobId: 'img-job-5' })).rejects.toThrow();

    const rows = await db.selectFrom('images').select('id').where('entity_id', '=', itemId).execute();
    expect(rows).toHaveLength(0);
  });
});
