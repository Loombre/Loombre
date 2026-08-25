// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/seed-music-playable.spec.ts
//
// d3-m1 regression guard: the seeded Music library was UNPLAYABLE. seed.mjs
// created 1 artist + 2 albums + 6 tracks and gave the tracks no media_files
// rows at all, so `getMediaInfoAssembly` returned undefined for every one of
// them — which apps/server's POST /playback/sessions surfaces as
// `404 "Item or media file not found."` (sessions.controller.ts). In the dev
// stack that reads as the MiniPlayerBar mounting and being skipped away
// within ~40 ms with a toast: no seeded track could EVER play.
//
// Live-DB spec (reset + reseed in beforeAll, the convention this directory
// uses — see catalog-detail.spec.ts's header). Connection: DATABASE_URL,
// default postgres://loombre:loombre@localhost:5442/loombre.
//
// The on-disk half is ffmpeg-gated the same way apps/worker's integration
// suites are (test/support/require-ffmpeg.ts): a graceful skip locally, a
// HARD failure under LOOMBRE_REQUIRE_FFMPEG=1 (set on CI's gate job, which
// installs ffmpeg on all three runners), so a runner that lost ffmpeg can
// never masquerade as green. The DB-shape half is NEVER skipped — the seed
// writes those rows unconditionally, precisely so the seeded catalog has one
// deterministic shape regardless of whether the box could encode the blobs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { getMediaInfoAssembly } from '../src/query/media-info.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL = resolveTestDatabaseUrl();

/** The six titles seed.mjs mints as `track` items (2 albums x 3). */
const SEED_TRACK_TITLES = ['Tideline', 'Salt & Static', 'Low Water', 'Departures', 'Coastal Drift', 'Harbor Hymn'];

function run(script: string, args: string[]): string {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

/** Same resolution order as seed/audio-fixtures.mjs (env override, then a
 *  PATH scan) — inlined rather than imported so this spec stays a plain
 *  consumer of the seed's OUTPUT, not of its internals. */
function ffmpegResolvable(): boolean {
  const override = process.env['LOOMBRE_FFMPEG'];
  const isExec = (candidate: string): boolean => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  const onPath = (): boolean => {
    const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
    const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
    return dirs.some((dir) => exts.some((ext) => isExec(path.join(dir, `ffmpeg${ext}`))));
  };
  const found = override && override.length > 0 ? isExec(override) : onPath();
  if (!found && process.env['LOOMBRE_REQUIRE_FFMPEG']) {
    throw new Error(
      'LOOMBRE_REQUIRE_FFMPEG is set but ffmpeg is not resolvable (LOOMBRE_FFMPEG env / PATH) — ' +
        'refusing to silently skip the seed audio-fixture assertions'
    );
  }
  return found;
}

let db: Kysely<DB>;
let adminCtx: ViewerContext;
let trackIds: Map<string, string>;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);

  const admin = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', 'admin')
    .executeTakeFirstOrThrow();
  const libraries = await db.selectFrom('libraries').select(['id', 'content_class']).execute();
  adminCtx = {
    userId: admin.id,
    allowedLibraryIds: libraries.map((l) => l.id),
    restrictedCleared: true,
  };

  const tracks = await db
    .selectFrom('catalog_items')
    .select(['id', 'title'])
    .where('item_type', '=', 'track')
    .execute();
  trackIds = new Map(tracks.map((t) => [t.title, t.id]));
}, 120_000);

afterAll(async () => {
  await db?.destroy();
});

describe('seeded music is playable (d3-m1)', () => {
  it('seeds all six tracks', () => {
    expect([...trackIds.keys()].sort()).toEqual([...SEED_TRACK_TITLES].sort());
  });

  it('gives every seeded track a probed, present media_files row', async () => {
    for (const title of SEED_TRACK_TITLES) {
      const itemId = trackIds.get(title);
      expect(itemId, `no seeded track titled ${title}`).toBeDefined();

      const files = await db
        .selectFrom('media_files')
        .selectAll()
        .where('item_id', '=', itemId!)
        .execute();

      expect(files, `track "${title}" has no media_files row — POST /playback/sessions 404s`).toHaveLength(1);
      const file = files[0]!;
      // "Not ready" per src/query/media-info.ts: any of these NULL and the
      // assembly refuses to build a MediaInfo at all.
      expect(file.container).toBe('mp3');
      expect(file.duration_ms).toBeGreaterThan(0);
      expect(file.probed_at_ms).not.toBeNull();
      // A file whose every row is missing is hidden from EVERY guarded read
      // (src/query/guard.ts) — the opposite of the fix.
      expect(file.missing_since_ms).toBeNull();
      expect(file.size_bytes).toBeGreaterThan(0);
      expect(path.isAbsolute(file.path)).toBe(true);
    }
  });

  it('gives every seeded track exactly one default audio stream and no video stream', async () => {
    for (const title of SEED_TRACK_TITLES) {
      const streams = await db
        .selectFrom('media_streams')
        .innerJoin('media_files', 'media_files.id', 'media_streams.file_id')
        .select([
          'media_streams.stream_type',
          'media_streams.codec',
          'media_streams.channels',
          'media_streams.sample_rate',
          'media_streams.is_default',
        ])
        .where('media_files.item_id', '=', trackIds.get(title)!)
        .execute();

      expect(streams, `track "${title}" has no media_streams rows`).toHaveLength(1);
      expect(streams[0]!.stream_type).toBe('audio');
      expect(streams[0]!.codec).toBe('mp3');
      expect(streams[0]!.channels).toBeGreaterThan(0);
      expect(streams[0]!.sample_rate).toBeGreaterThan(0);
      expect(streams[0]!.is_default).toBe(true);
    }
  });

  // The actual defect, at the exact seam apps/server's POST
  // /playback/sessions consults: `undefined` here IS the 404 the QA run saw.
  it('assembles a MediaInfo for every seeded track (the seam POST /playback/sessions 404s on)', async () => {
    for (const title of SEED_TRACK_TITLES) {
      const assembly = await getMediaInfoAssembly(db, adminCtx, { itemId: trackIds.get(title)! });
      expect(assembly, `getMediaInfoAssembly returned undefined for "${title}" — the session create 404s`).toBeDefined();
      expect(assembly!.media.container).toBe('mp3');
      expect(assembly!.media.video).toHaveLength(0);
      expect(assembly!.media.audio).toHaveLength(1);
      expect(assembly!.media.audio[0]!.codec).toBe('mp3');
      expect(assembly!.media.durationMs).toBeGreaterThan(0);
      expect(assembly!.media.overallBitrateBps).toBeGreaterThan(0);
    }
  });

  it('keeps the tracks distinguishable: each gets its own file and its own duration', async () => {
    const rows = await db
      .selectFrom('media_files')
      .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
      .select(['media_files.path', 'media_files.duration_ms'])
      .where('catalog_items.item_type', '=', 'track')
      .execute();
    expect(new Set(rows.map((r) => r.path)).size).toBe(SEED_TRACK_TITLES.length);
    expect(new Set(rows.map((r) => r.duration_ms)).size).toBe(SEED_TRACK_TITLES.length);
  });

  it('keeps track_details.duration_ms honest against the real file', async () => {
    const rows = await db
      .selectFrom('track_details')
      .innerJoin('media_files', 'media_files.item_id', 'track_details.item_id')
      .select(['track_details.duration_ms as track_duration_ms', 'media_files.duration_ms as file_duration_ms'])
      .execute();
    expect(rows).toHaveLength(SEED_TRACK_TITLES.length);
    for (const row of rows) {
      expect(row.track_duration_ms).toBe(row.file_duration_ms);
    }
  });

  describe.skipIf(!ffmpegResolvable())('backing audio blobs', () => {
    it('writes a real, tiny audio file at every seeded path, with a truthful size_bytes', async () => {
      const files = await db
        .selectFrom('media_files')
        .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
        .select(['media_files.path', 'media_files.size_bytes'])
        .where('catalog_items.item_type', '=', 'track')
        .execute();

      // Never vacuous: no rows means the seed wrote no track files at all,
      // which is the defect itself, not a pass.
      expect(files).toHaveLength(SEED_TRACK_TITLES.length);
      for (const file of files) {
        const stat = statSync(file.path); // throws (fails the test) if absent
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBeGreaterThan(0);
        // "keep them tiny, seconds not minutes" — a fixture that grows into
        // megabytes is a regression in its own right.
        expect(stat.size).toBeLessThan(512 * 1024);
        expect(file.size_bytes).toBe(stat.size);
      }
    });
  });
});
