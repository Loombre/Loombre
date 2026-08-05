// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/stash-connections.spec.ts
//
// Live-DB tests for src/query/stash-connections.ts (migrations/
// 0018_stash_provider_core.sql's library_stash_connections +
// library_path_mappings). Mirrors library-provider-chains.spec.ts's own
// reset+reseed convention.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import {
  LibraryNotFoundForStashError,
  StashConnectionNotConfiguredError,
  deleteLibraryStashConnection,
  getLibraryPathMappings,
  getLibraryStashConnection,
  recordStashConnectionOutcome,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
} from '../src/query/stash-connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('libraries')
    .values({ name: `lib-${randomUUID()}`, media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('library_stash_connections config + outcome writers', () => {
  it('upsertLibraryStashConnectionConfig creates a row defaulting to never_connected', async () => {
    const libraryId = await makeLibrary();
    const row = await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/data/stash.sqlite', nowMs: Date.now() });
    expect(row).toMatchObject({ library_id: libraryId, sqlite_path: '/data/stash.sqlite', enabled: true, status: 'never_connected' });
  });

  it('rejects a nonexistent library', async () => {
    await expect(upsertLibraryStashConnectionConfig(db, { libraryId: randomUUID(), sqlitePath: '/x.sqlite', nowMs: Date.now() })).rejects.toThrow(
      LibraryNotFoundForStashError
    );
  });

  it('a config-only update never touches status/last_seen_schema_version', async () => {
    const libraryId = await makeLibrary();
    const now = Date.now();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/a.sqlite', nowMs: now });
    await recordStashConnectionOutcome(db, { libraryId, status: 'ok', lastSeenSchemaVersion: 85, nowMs: now + 1000 });

    const updated = await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/b.sqlite', nowMs: now + 2000 });
    expect(updated).toMatchObject({ sqlite_path: '/b.sqlite', status: 'ok', last_seen_schema_version: 85 });
  });

  it('recordStashConnectionOutcome requires an existing configured row', async () => {
    await expect(recordStashConnectionOutcome(db, { libraryId: randomUUID(), status: 'ok', nowMs: Date.now() })).rejects.toThrow(
      StashConnectionNotConfiguredError
    );
  });

  it('recordStashConnectionOutcome advances last_connected_at_ms only on status=ok', async () => {
    const libraryId = await makeLibrary();
    const now = Date.now();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/a.sqlite', nowMs: now });

    const unsupported = await recordStashConnectionOutcome(db, {
      libraryId,
      status: 'unsupported_schema',
      statusDetail: 'Stash schema v58 unsupported; supported: 67-85',
      lastSeenSchemaVersion: 58,
      nowMs: now + 1000,
    });
    expect(unsupported.last_connected_at_ms).toBeNull();
    expect(unsupported.last_checked_at_ms).toBe(now + 1000);
    expect(unsupported.status_detail).toBe('Stash schema v58 unsupported; supported: 67-85');

    const ok = await recordStashConnectionOutcome(db, { libraryId, status: 'ok', lastSeenSchemaVersion: 85, nowMs: now + 2000 });
    expect(ok.last_connected_at_ms).toBe(now + 2000);
    expect(ok.status_detail).toBeNull();
  });

  it('getLibraryStashConnection / deleteLibraryStashConnection round-trip', async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/a.sqlite', nowMs: Date.now() });
    expect(await getLibraryStashConnection(db, libraryId)).not.toBeUndefined();
    await deleteLibraryStashConnection(db, libraryId);
    expect(await getLibraryStashConnection(db, libraryId)).toBeUndefined();
  });
});

describe('library_path_mappings', () => {
  it('replaceLibraryPathMappings wholesale-replaces, preserving array order as position', async () => {
    const libraryId = await makeLibrary();
    const inserted = await replaceLibraryPathMappings(db, libraryId, [
      { stashPrefix: '/mnt/stash', loombrePrefix: '/media/general' },
      { stashPrefix: '/mnt/stash/scenes', loombrePrefix: '/media/adult/scenes' },
    ]);
    expect(inserted.map((m) => m.position)).toEqual([0, 1]);

    const replaced = await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: '/only', loombrePrefix: '/one' }]);
    expect(replaced).toHaveLength(1);

    const rows = await getLibraryPathMappings(db, libraryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stash_prefix: '/only', loombre_prefix: '/one', position: 0 });
  });

  it('an empty array legally clears all mappings', async () => {
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: '/a', loombrePrefix: '/b' }]);
    await replaceLibraryPathMappings(db, libraryId, []);
    expect(await getLibraryPathMappings(db, libraryId)).toEqual([]);
  });

  it('detaching a connection preserves path mappings for a future re-attach', async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: '/a.sqlite', nowMs: Date.now() });
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: '/a', loombrePrefix: '/b' }]);
    await deleteLibraryStashConnection(db, libraryId);
    expect(await getLibraryPathMappings(db, libraryId)).toHaveLength(1);
  });

  // V1-011: replaceLibraryPathMappings must be all-or-nothing, matching
  // replaceLibraryProviderChain's transactional convention. A failure
  // partway through the delete+insert loop must leave the PRIOR mapping
  // set intact, not a mix of neither-old-nor-new. The second entry's
  // null stash_prefix (cast past the type system — this function accepts
  // caller input no differently at runtime) trips the column's real
  // NOT NULL constraint only after the first entry's insert has already
  // gone through, forcing a genuine mid-loop failure.
  it('a failure partway through the replace rolls back to the PRIOR mapping set — no partial write', async () => {
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: '/mnt/stash', loombrePrefix: '/media/general' }]);

    await expect(
      replaceLibraryPathMappings(db, libraryId, [
        { stashPrefix: '/new/one', loombrePrefix: '/media/new-one' },
        { stashPrefix: null as unknown as string, loombrePrefix: '/media/new-two' },
      ])
    ).rejects.toThrow();

    const rows = await getLibraryPathMappings(db, libraryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stash_prefix: '/mnt/stash', loombre_prefix: '/media/general', position: 0 });
  });
});
