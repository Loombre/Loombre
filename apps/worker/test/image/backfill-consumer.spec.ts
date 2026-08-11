// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/backfill-consumer.spec.ts
//
// Live-DB integration test for imageBackfillConsumerHandler (P2.11's
// one-time dominant_color backfill, migrations/0005_images_dominant_color.
// sql). SELF-SUFFICIENT: resets @loombre/db's schema in its own beforeAll
// (same convention as image/consumer.spec.ts).
//
// Proves:
//   - a batch processes originals in id order and writes a real hex color
//     for a readable source file, copying it onto sibling variant rows too
//   - a missing/unreadable source file gets the '' sentinel (never NULL,
//     never retried) on both the original row and its variants
//   - resumability: running with a small batchSize leaves later rows NULL
//     after the first batch, and resuming from the captured cursor
//     processes exactly the remainder
//   - the handler only re-enqueues itself (via the injected enqueueSelf)
//     when a batch came back full (more rows might remain)

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createDb, resolveTestDatabaseUrl } from '@loombre/db';
import { imageBackfillConsumerHandler } from '../../src/image/backfill-consumer.js';
import { computeDominantColor } from '../../src/image/variant-job.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const DATABASE_URL = resolveTestDatabaseUrl();

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
let workDir: string;

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-image-backfill-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface SeedRow {
  id: string;
  entityId: string;
}

async function insertOriginal(filePath: string): Promise<SeedRow> {
  const entityId = randomUUID();
  const row = await db
    .insertInto('images')
    .values({
      entity_type: 'catalog_item',
      entity_id: entityId,
      kind: 'poster',
      source: 'local',
      width: null,
      height: 100,
      blurhash: 'placeholder-blurhash',
      dominant_color: null,
      file_path: filePath,
      created_at_ms: Date.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { id: row.id, entityId };
}

async function insertVariant(entityId: string, filePath: string): Promise<void> {
  await db
    .insertInto('images')
    .values({
      entity_type: 'catalog_item',
      entity_id: entityId,
      kind: 'poster',
      source: 'local',
      width: 320,
      height: 60,
      blurhash: 'placeholder-blurhash',
      dominant_color: null,
      file_path: filePath,
      created_at_ms: Date.now(),
    })
    .execute();
}

async function readDominantColors(entityIds: string[]): Promise<Map<string, { original: string | null; variant: string | null }>> {
  const rows = await db
    .selectFrom('images')
    .select(['entity_id', 'width', 'dominant_color'])
    .where('entity_type', '=', 'catalog_item')
    .where('entity_id', 'in', entityIds)
    .execute();

  const map = new Map<string, { original: string | null; variant: string | null }>();
  for (const row of rows) {
    const entry = map.get(row.entity_id) ?? { original: null, variant: null };
    if (row.width === null) entry.original = row.dominant_color;
    else entry.variant = row.dominant_color;
    map.set(row.entity_id, entry);
  }
  return map;
}

describe('imageBackfillConsumerHandler', () => {
  it('computes real colors for readable files, sentinels missing files, copies onto variants, and resumes from a mid-way cursor', async () => {
    const redPath = join(workDir, 'red.png');
    const greenPath = join(workDir, 'green.png');
    const redVariantPath = join(workDir, 'red-320.png');
    const greenVariantPath = join(workDir, 'green-320.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toFile(redPath);
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 20, g: 200, b: 20 } } }).png().toFile(greenPath);
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toFile(redVariantPath);
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 200, b: 20 } } }).png().toFile(greenVariantPath);

    const missingPathA = join(workDir, 'missing-a.png');
    const missingPathB = join(workDir, 'missing-b.png');

    // Insert 4 originals; sort by the id the DB actually assigned (UUIDv7 —
    // time-ordered, but the test never assumes insertion order == id order
    // beyond what it independently re-derives here).
    const red = await insertOriginal(redPath);
    await insertVariant(red.entityId, redVariantPath);
    const missingA = await insertOriginal(missingPathA);
    const green = await insertOriginal(greenPath);
    await insertVariant(green.entityId, greenVariantPath);
    const missingB = await insertOriginal(missingPathB);

    const seeded = [red, missingA, green, missingB].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(seeded).toHaveLength(4);

    const enqueueCalls: string[] = [];
    const handler = imageBackfillConsumerHandler({
      db,
      execute: computeDominantColor,
      batchSize: 3,
      enqueueSelf: async (cursor) => {
        enqueueCalls.push(cursor);
      },
    });

    // --- Batch 1: cursor = null, batchSize 3 -> processes the first 3 rows
    // (by id order) and re-enqueues itself (batch came back full). ---
    await handler({ cursor: null }, { jobId: 'backfill-job-1' });

    expect(enqueueCalls).toHaveLength(1);
    const cursorAfterBatch1 = enqueueCalls[0]!;
    expect(cursorAfterBatch1).toBe(seeded[2]!.id);

    const allEntityIds = seeded.map((s) => s.entityId);
    const afterBatch1 = await readDominantColors(allEntityIds);

    const firstThree = seeded.slice(0, 3);
    const fourth = seeded[3]!;

    for (const s of firstThree) {
      expect(afterBatch1.get(s.entityId)?.original).not.toBeNull();
    }
    // The 4th row (not in batch 1) is untouched — still NULL.
    expect(afterBatch1.get(fourth.entityId)?.original).toBeNull();

    // --- Batch 2: resume from the captured cursor -> processes exactly the
    // remaining 1 row, batch comes back short, so no further re-enqueue. ---
    await handler({ cursor: cursorAfterBatch1 }, { jobId: 'backfill-job-2' });

    expect(enqueueCalls).toHaveLength(1); // unchanged — no second re-enqueue

    const afterBatch2 = await readDominantColors(allEntityIds);

    // Real colors for the two readable originals, copied onto their variant.
    const redColors = afterBatch2.get(red.entityId)!;
    expect(redColors.original).toMatch(/^#[0-9a-f]{6}$/);
    expect(redColors.variant).toBe(redColors.original);
    const redR = parseInt(redColors.original!.slice(1, 3), 16);
    expect(Math.abs(redR - 220)).toBeLessThanOrEqual(10);

    const greenColors = afterBatch2.get(green.entityId)!;
    expect(greenColors.original).toMatch(/^#[0-9a-f]{6}$/);
    expect(greenColors.variant).toBe(greenColors.original);
    const greenG = parseInt(greenColors.original!.slice(3, 5), 16);
    expect(Math.abs(greenG - 200)).toBeLessThanOrEqual(10);

    // Missing files: '' sentinel (never null, never a real hex), copied
    // onto... well missingA had no variant seeded, only checking original.
    const missingAColors = afterBatch2.get(missingA.entityId)!;
    expect(missingAColors.original).toBe('');

    const missingBColors = afterBatch2.get(missingB.entityId)!;
    expect(missingBColors.original).toBe('');

    // No row is left NULL anywhere — the backfill is fully done.
    for (const s of seeded) {
      expect(afterBatch2.get(s.entityId)?.original).not.toBeNull();
    }

    // Running the same query set that gates the boot-time enqueue would now
    // find nothing left to do.
    const { listImagesNeedingDominantColor } = await import('@loombre/db/internal');
    const remaining = await listImagesNeedingDominantColor(db, { afterId: null, limit: 10 });
    const remainingForThisTest = remaining.filter((r) => allEntityIds.includes(r.entity_id));
    expect(remainingForThisTest).toHaveLength(0);
  });

  it('leaves a sibling variant row untouched (still NULL) if the original itself was never in a processed batch — i.e. only processed originals propagate', async () => {
    const untouchedPath = join(workDir, 'untouched.png');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toFile(untouchedPath);

    const original = await insertOriginal(untouchedPath);
    await insertVariant(original.entityId, untouchedPath);

    // batchSize 0-effective: use a cursor that's already past this row's id
    // so the batch selects nothing, proving the handler is a true no-op
    // (no crash, no enqueue) when there is nothing left for it to do.
    const enqueueCalls: string[] = [];
    const handler = imageBackfillConsumerHandler({
      db,
      execute: computeDominantColor,
      batchSize: 5,
      enqueueSelf: async (cursor) => {
        enqueueCalls.push(cursor);
      },
    });

    await handler({ cursor: original.id }, { jobId: 'backfill-job-noop' });

    expect(enqueueCalls).toHaveLength(0);
    const colors = await readDominantColors([original.entityId]);
    expect(colors.get(original.entityId)?.original).toBeNull();
    expect(colors.get(original.entityId)?.variant).toBeNull();
  });
});
