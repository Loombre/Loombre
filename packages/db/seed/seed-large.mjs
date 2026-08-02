#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/seed/seed-large.mjs
//
// Additive 50k-movie library generator for local 60fps-virtualization
// verification (STATE.md P2.6 exit gate: "virtualized grids... scroll
// 60fps at 50k items") and reusable by the Wave-3 perf harness. Deterministic
// in SHAPE (same title/year/rating/genre/people distribution every run) —
// reruns REPLACE the one library this script owns ("Large Library", found
// by name; cascade delete wipes its items/details/files/images/tag+people
// credits) rather than piling up duplicates, so `pnpm db:seed-large` is
// safe to run repeatedly. It never touches any row `seed.mjs` created and
// requires `pnpm db:seed` to have already run (reads the existing
// admin/casual users to grant library_permissions) — additive only.
//
// No image FILES are written (this is a synthetic dev dataset, not a real
// ingest — Tier-0 image work stays worker-side/ingest-time everywhere
// else). `images` rows point at a small pool of already-known-good
// blurhash strings reused verbatim from seed.mjs so the real LQIP decode
// path (apps/web/src/lib/blurhash-canvas.ts) has real data to render; the
// browser's subsequent <img> fetch of the (nonexistent) full-res file 404s
// harmlessly via apps/server/src/catalog/images.controller.ts's stat()
// catch — expected, and irrelevant to virtualization/scroll performance
// since the DOM node exists and lays out correctly either way.
//
// Connection: DATABASE_URL env var, default postgres://loombre:loombre@localhost:5442/loombre
// Count: LOOMBRE_SEED_LARGE_COUNT env var, default 50000

import { randomUUID } from 'node:crypto';
import pg from 'pg';

pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';
const COUNT = Number.parseInt(process.env.LOOMBRE_SEED_LARGE_COUNT ?? '50000', 10);
const BATCH_SIZE = 500;
const LIBRARY_NAME = 'Large Library';
const PERSON_POOL_SIZE = 90;

const NOW = Date.now();
function nextMs(offset) {
  return NOW - 5_000_000 + offset;
}

// Known-good blurhash strings already inserted (and thereby validated) by
// packages/db/seed/seed.mjs — reused verbatim rather than hand-rolling a
// base83 encoder in a seed script.
const BLURHASH_POOL = [
  'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
  'L4PZfSi_.AyE_3t7t7R**0o#DgR5',
  'L4PZfSi_.AyE_3t7t7R**0o#DgR6',
  'L2PZfSi_.AyE_3t7t7R**0o#DgR7',
  'L2PZfSi_.AyE_3t7t7R**0o#DgR8',
  'L1PZfSi_.AyE_3t7t7R**0o#DgR9',
  'L1PZfSi_.AyE_3t7t7R**0o#DgRa',
  'L0PZfSi_.AyE_3t7t7R**0o#DgRb',
  'L0PZfSi_.AyE_3t7t7R**0o#DgRc',
];

const TITLE_ADJECTIVES = [
  'Silent', 'Crimson', 'Hollow', 'Distant', 'Broken', 'Golden', 'Last',
  'Forgotten', 'Wandering', 'Quiet', 'Bitter', 'Endless', 'Falling',
  'Midnight', 'Frozen', 'Burning', 'Restless', 'Hidden', 'Faded', 'Lonely',
];
const TITLE_NOUNS = [
  'Harbor', 'Static', 'Kingdom', 'Ferry', 'Orchard', 'Signal', 'Horizon',
  'Current', 'Ledger', 'Frontier', 'Echo', 'Cascade', 'Meridian', 'Anchor',
  'Lantern', 'Circuit', 'Tideline', 'Wreckage', 'Passage', 'Vantage',
];
const CONTENT_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
const CONTAINERS = ['mkv', 'mp4'];
const GENRE_NAMES = [
  'Action', 'Drama', 'Comedy', 'Sci-Fi', 'Horror', 'Thriller', 'Romance',
  'Documentary', 'Animation', 'Fantasy', 'Mystery', 'Adventure', 'Crime',
  'Family', 'War',
];
const PERSON_FIRST = [
  'Elena', 'Devon', 'Priya', 'Tomas', 'Mara', 'Noel', 'Isla', 'Rafi', 'Sana',
  'Otis', 'Wren', 'Kade', 'Yusuf', 'Lior', 'Bea', 'Sven', 'Aya', 'Dax',
];
const PERSON_LAST = [
  'Marsh', 'Kade', 'Anand', 'Lindqvist', 'Okoye', 'Blackwood', 'Reyes',
  'Sato', 'Hale', 'Voss', 'Ibarra', 'Kessler', 'Dunmore', 'Farrow',
];

function titleFor(i) {
  const adj = TITLE_ADJECTIVES[i % TITLE_ADJECTIVES.length];
  const noun = TITLE_NOUNS[(i * 7) % TITLE_NOUNS.length];
  return `${adj} ${noun} ${i + 1}`;
}

function personNameFor(i) {
  const first = PERSON_FIRST[i % PERSON_FIRST.length];
  const last = PERSON_LAST[(i * 5) % PERSON_LAST.length];
  return `${first} ${last}`;
}

/** Builds a `VALUES ($1,$2,...),(...)...` fragment + flat param array for a
 *  fixed-column multi-row INSERT. `casts[col]` (by 0-based column index) can
 *  force e.g. `::jsonb` on a placeholder. */
function buildBulkInsert(rows, casts = {}) {
  const params = [];
  let p = 1;
  const tuples = rows.map((row) => {
    const placeholders = row.map((_, colIndex) => {
      const ph = `$${p}`;
      p += 1;
      return casts[colIndex] ? `${ph}::${casts[colIndex]}` : ph;
    });
    return `(${placeholders.join(', ')})`;
  });
  for (const row of rows) params.push(...row);
  return { tuplesSql: tuples.join(', '), params };
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const { rows: adminRows } = await client.query(`SELECT id FROM users WHERE username = 'admin'`);
    if (adminRows.length === 0) {
      throw new Error(
        'seed-large: no admin user found — run `pnpm db:seed` first ' +
          '(this script is additive on top of the normal seed, not a replacement for it).',
      );
    }
    const adminId = adminRows[0].id;
    const { rows: casualRows } = await client.query(`SELECT id FROM users WHERE username = 'casual'`);
    const casualId = casualRows[0]?.id ?? null;

    await client.query('BEGIN');
    // Disposable dev dataset — a crash mid-seed just means re-running the
    // script, which replaces the library from scratch (see header).
    await client.query(`SET LOCAL synchronous_commit TO off`);

    // Replace-not-append: cascade delete wipes every child row transitively
    // (catalog_items -> movie_details/media_files/item_tags/item_people via
    // ON DELETE CASCADE FKs; images is polymorphic with no FK, cleaned up
    // explicitly below by entity_id).
    const { rows: existing } = await client.query(`SELECT id FROM libraries WHERE name = $1`, [LIBRARY_NAME]);
    if (existing.length > 0) {
      await client.query(
        `DELETE FROM images WHERE entity_type = 'catalog_item' AND entity_id IN
           (SELECT id FROM catalog_items WHERE library_id = $1)`,
        [existing[0].id],
      );
      await client.query(`DELETE FROM libraries WHERE id = $1`, [existing[0].id]);
    }

    const {
      rows: [library],
    } = await client.query(
      `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms)
       VALUES ($1, 'movie', ARRAY['/data/large'], 'general', $2, $2) RETURNING id`,
      [LIBRARY_NAME, nextMs(0)],
    );

    for (const userId of [adminId, casualId].filter((id) => id !== null)) {
      await client.query(
        `INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, library.id, nextMs(1)],
      );
    }

    // Shared genre pool (created once, reused) — "reasonable metadata
    // distribution": filter/sort/detail surfaces get real, varied genres,
    // not one repeated value on every item.
    const genreIds = [];
    for (const name of GENRE_NAMES) {
      const { rows } = await client.query(
        `INSERT INTO tags (name, content_class) VALUES ($1, 'general')
         ON CONFLICT (name, content_class) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
      );
      genreIds.push(rows[0].id);
    }

    // Shared people pool (~90 synthesized names, cycled) — enough variety
    // for /people browsing/search without a 50k-row people table.
    const personIds = [];
    for (let i = 0; i < PERSON_POOL_SIZE; i += 1) {
      const { rows } = await client.query(
        `INSERT INTO people (name, content_class) VALUES ($1, 'general') RETURNING id`,
        [personNameFor(i)],
      );
      personIds.push(rows[0].id);
    }

    console.log(`seed-large: inserting ${COUNT} movies into "${LIBRARY_NAME}" (${library.id})...`);

    for (let batchStart = 0; batchStart < COUNT; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, COUNT);
      const batchSize = batchEnd - batchStart;
      const ids = Array.from({ length: batchSize }, () => randomUUID());

      // ---- catalog_items ----
      // (content_class is deliberately omitted — the
      // catalog_items_enforce_content_class_trg trigger denormalizes it
      // from the library on every INSERT, so supplying it would be
      // pointless and misleading.)
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const title = titleFor(i);
          const year = 1970 + (i % 56);
          const rating = Math.round((3 + ((i * 37) % 70) / 10) * 10) / 10;
          const addedAt = nextMs(1000 + i);
          rows.push([ids[j], library.id, 'movie', title, title, year, rating, addedAt, addedAt]);
        }
        const { tuplesSql, params } = buildBulkInsert(rows);
        await client.query(
          `INSERT INTO catalog_items
             (id, library_id, item_type, title, sort_title, year, community_rating, added_at_ms, updated_at_ms)
           VALUES ${tuplesSql}`,
          params,
        );
      }

      // ---- movie_details ----
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const contentRating = CONTENT_RATINGS[i % CONTENT_RATINGS.length];
          const runtimeMs = (90 + (i % 120)) * 60_000;
          rows.push([
            ids[j],
            contentRating,
            runtimeMs,
            null,
            `${titleFor(i)} follows an ensemble cast through one unforgettable week.`,
          ]);
        }
        const { tuplesSql, params } = buildBulkInsert(rows);
        await client.query(
          `INSERT INTO movie_details (item_id, content_rating, runtime_ms, tagline, overview) VALUES ${tuplesSql}`,
          params,
        );
      }

      // ---- media_files ----
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const container = CONTAINERS[i % CONTAINERS.length];
          const runtimeMs = (90 + (i % 120)) * 60_000;
          const sizeBytes = 1_500_000_000 + (i % 40) * 150_000_000;
          rows.push([
            ids[j],
            `/data/large/movie-${i}.${container}`,
            `xxh3-large-${i}`,
            sizeBytes,
            container,
            runtimeMs,
            JSON.stringify({ format: container === 'mkv' ? 'matroska' : 'mp4', synthesized: true }),
            nextMs(1000 + i),
          ]);
        }
        const { tuplesSql, params } = buildBulkInsert(rows, { 6: 'jsonb' });
        await client.query(
          `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms)
           VALUES ${tuplesSql}`,
          params,
        );
      }

      // ---- images: one "original" (width NULL) row per movie — the
      // nearest-width picker (images.controller.ts's pickVariant) always
      // resolves any requested width to this single row when it's the only
      // one present, so one row is enough to exercise every srcset width. ----
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const blurhash = BLURHASH_POOL[i % BLURHASH_POOL.length];
          rows.push([
            'catalog_item',
            ids[j],
            'poster',
            'local',
            1000,
            1500,
            blurhash,
            `/data/large/images/movie-${i}-poster.jpg`,
            nextMs(1000 + i),
          ]);
        }
        const { tuplesSql, params } = buildBulkInsert(rows);
        await client.query(
          `INSERT INTO images (entity_type, entity_id, kind, source, width, height, blurhash, file_path, created_at_ms)
           VALUES ${tuplesSql}`,
          params,
        );
      }

      // ---- item_tags: 1-2 genres per movie ----
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const g1 = genreIds[i % genreIds.length];
          rows.push([ids[j], g1, 'genre']);
          if (i % 3 !== 0) {
            const g2 = genreIds[(i * 11 + 3) % genreIds.length];
            if (g2 !== g1) rows.push([ids[j], g2, 'genre']);
          }
        }
        const { tuplesSql, params } = buildBulkInsert(rows);
        await client.query(`INSERT INTO item_tags (item_id, tag_id, kind) VALUES ${tuplesSql}`, params);
      }

      // ---- item_people: a director + a lead actor per movie ----
      {
        const rows = [];
        for (let j = 0; j < batchSize; j += 1) {
          const i = batchStart + j;
          const director = personIds[i % personIds.length];
          const actor = personIds[(i * 13 + 7) % personIds.length];
          rows.push([ids[j], director, 'director', null, 0]);
          rows.push([ids[j], actor, 'actor', 'Lead', 1]);
        }
        const { tuplesSql, params } = buildBulkInsert(rows);
        await client.query(
          `INSERT INTO item_people (item_id, person_id, role, credit, ord) VALUES ${tuplesSql}`,
          params,
        );
      }

      if ((batchEnd / BATCH_SIZE) % 10 === 0 || batchEnd === COUNT) {
        console.log(`  ...${batchEnd}/${COUNT}`);
      }
    }

    await client.query('COMMIT');
    console.log('seed-large: committed successfully.');

    // Update planner statistics NOW, synchronously, rather than waiting on
    // autovacuum's ANALYZE to fire at some nondeterministic point after this
    // 50k-row bulk load. Without stats, Postgres estimates ~1 row for
    // `WHERE library_id = $x AND item_type = 'movie'` (the browse hot path)
    // and prices a scan-all-50k-rows + top-N Sort plan at cost 8.32 — a hair
    // under the correct keyset-index seek's 8.43 — so it picks the Sort and
    // the ENFORCING perf-t0 job's browsePageList p95 blows past its 100ms
    // budget (measured 177ms on CI). With stats present the same query plans
    // as a streaming index seek (~0.08ms). Production never sees the no-stats
    // state persistently (autovacuum keeps stats fresh); only a fresh
    // migrate+seed+measure run does, which is exactly what perf-t0 does — so
    // the fix belongs here, at the end of the bulk loader, per the standard
    // "ANALYZE after a bulk load" practice. This also makes perf-t0
    // deterministic: the pass/fail was previously a race against autovacuum.
    //
    // Scoped to exactly the tables this script bulk-loads (not a bare
    // whole-DB `ANALYZE`) so the "analyze what you just loaded" intent stays
    // honest. This list mirrors the INSERTs above; extend it if this script
    // starts loading another table.
    //
    // max_parallel_maintenance_workers = 0 pins the ANALYZE to the leader
    // backend so it never allocates a parallel dynamic-shared-memory segment:
    // the dev-compose Postgres container ships a 64 MiB /dev/shm, and under
    // any concurrent /dev/shm pressure a parallel ANALYZE can die mid-run with
    // "could not resize shared memory segment ... No space left on device".
    // Serial ANALYZE of these nine tables is a fraction of a second and makes
    // the stats refresh succeed deterministically in every environment, not
    // just on CI's ample-memory runner.
    console.log('seed-large: ANALYZE (refresh planner statistics after bulk load)...');
    await client.query('SET max_parallel_maintenance_workers = 0');
    await client.query('SET max_parallel_workers_per_gather = 0');
    await client.query(
      'ANALYZE catalog_items, movie_details, media_files, media_streams, ' +
        'item_people, item_tags, images, people, tags',
    );

    const { rows: counts } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM catalog_items WHERE library_id = $1) AS movies,
         (SELECT count(*)::int FROM media_files mf JOIN catalog_items ci ON ci.id = mf.item_id WHERE ci.library_id = $1) AS media_files,
         (SELECT count(*)::int FROM images i JOIN catalog_items ci ON ci.id = i.entity_id WHERE ci.library_id = $1) AS images,
         (SELECT count(*)::int FROM item_tags it JOIN catalog_items ci ON ci.id = it.item_id WHERE ci.library_id = $1) AS item_tags,
         (SELECT count(*)::int FROM item_people ip JOIN catalog_items ci ON ci.id = ip.item_id WHERE ci.library_id = $1) AS item_people`,
      [library.id],
    );
    console.log('  library_id  ', library.id);
    for (const [key, value] of Object.entries(counts[0])) {
      console.log(`  ${key.padEnd(14)} ${value}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('seed-large: failed, rolled back.', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
