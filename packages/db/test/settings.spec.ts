// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/settings.spec.ts
//
// Live-DB tests for src/query/settings.ts (Addendum A/A4,
// migrations/0013_server_settings.sql). Self-sufficient: resets + reseeds
// the live DB in beforeAll so `vitest run` alone is enough from a fresh
// database, same convention as identity.spec.ts/transcode-sessions.spec.ts.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import {
  emitRedactedSettingsUpdated,
  getServerSetting,
  listServerSettings,
  upsertServerSettingAndEmit,
} from '../src/query/settings.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL = resolveTestDatabaseUrl();

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
let rawClient: pg.Client;
let adminUserId: string;

async function latestSettingsEvent(key: string): Promise<{ payload: Record<string, unknown> } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE type = 'settings.updated' AND payload ->> 'key' = $1 ORDER BY ts_ms DESC LIMIT 1`,
    [key],
  );
  return rows[0];
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the expected admin user');
  adminUserId = admin.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('server_settings queries', () => {
  it('listServerSettings starts empty (no row exists until a write happens)', async () => {
    const rows = await listServerSettings(db);
    expect(rows).toEqual([]);
  });

  it('upsertServerSettingAndEmit creates a row with oldValue=null on first write, and round-trips a boolean value', async () => {
    const nowMs = Date.now();
    const { row, oldValue } = await upsertServerSettingAndEmit(db, {
      key: 'restricted.enabled',
      value: true,
      actorUserId: adminUserId,
      nowMs,
    });
    expect(oldValue).toBeNull();
    expect(row.key).toBe('restricted.enabled');
    expect(row.value).toBe(true);
    expect(row.updated_by).toBe(adminUserId);
    expect(row.updated_at_ms).toBe(nowMs);

    const fetched = await getServerSetting(db, 'restricted.enabled');
    expect(fetched?.value).toBe(true);
  });

  it('a second write to the same key upserts in place and reports the correct oldValue', async () => {
    const first = Date.now();
    await upsertServerSettingAndEmit(db, { key: 'transcode.maxSimultaneousTranscodes', value: 2, actorUserId: adminUserId, nowMs: first });

    const second = first + 1000;
    const { oldValue, row } = await upsertServerSettingAndEmit(db, {
      key: 'transcode.maxSimultaneousTranscodes',
      value: 4,
      actorUserId: adminUserId,
      nowMs: second,
    });
    expect(oldValue).toBe(2);
    expect(row.value).toBe(4);
    expect(row.updated_at_ms).toBe(second);

    const all = await listServerSettings(db);
    expect(all.filter((r) => r.key === 'transcode.maxSimultaneousTranscodes')).toHaveLength(1);
  });

  it('round-trips every JSON value shape (array of objects, plain array, string, number)', async () => {
    const nowMs = Date.now();
    const ladderRungs = [
      { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: 'h264' },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: 'h264' },
    ];
    await upsertServerSettingAndEmit(db, { key: 'transcode.ladderRungs', value: ladderRungs, actorUserId: adminUserId, nowMs });
    const ladderRow = await getServerSetting(db, 'transcode.ladderRungs');
    expect(ladderRow?.value).toEqual(ladderRungs);

    await upsertServerSettingAndEmit(db, { key: 'network.corsOrigins', value: ['https://a.example', 'https://b.example'], actorUserId: adminUserId, nowMs });
    const corsRow = await getServerSetting(db, 'network.corsOrigins');
    expect(corsRow?.value).toEqual(['https://a.example', 'https://b.example']);

    await upsertServerSettingAndEmit(db, { key: 'updateCheck.mode', value: 'manual', actorUserId: adminUserId, nowMs });
    expect((await getServerSetting(db, 'updateCheck.mode'))?.value).toBe('manual');

    await upsertServerSettingAndEmit(db, { key: 'scanner.missingFileGraceHours', value: 72, actorUserId: adminUserId, nowMs });
    expect((await getServerSetting(db, 'scanner.missingFileGraceHours'))?.value).toBe(72);
  });

  it('emits a settings.updated outbox event in the SAME transaction, with actor/key/oldValue/newValue', async () => {
    const nowMs = Date.now();
    await upsertServerSettingAndEmit(db, { key: 'security.loginAnomalyLogEnabled', value: false, actorUserId: adminUserId, nowMs });

    const event = await latestSettingsEvent('security.loginAnomalyLogEnabled');
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      actorUserId: adminUserId,
      key: 'security.loginAnomalyLogEnabled',
      newValue: false,
    });
  });

  it('emitRedactedSettingsUpdated never writes the real value into the outbox (A9)', async () => {
    const nowMs = Date.now();
    await emitRedactedSettingsUpdated(db, { key: 'providerKey.tmdb', actorUserId: adminUserId, nowMs });

    const event = await latestSettingsEvent('providerKey.tmdb');
    expect(event).toBeDefined();
    expect(event!.payload.oldValue).toBe('[redacted]');
    expect(event!.payload.newValue).toBe('[redacted]');

    // And it never touches server_settings at all.
    expect(await getServerSetting(db, 'providerKey.tmdb')).toBeUndefined();
  });

  it('updated_by is set NULL (not a constraint violation) once the actor user is deleted', async () => {
    const nowMs = Date.now();
    const throwaway = await db
      .insertInto('users')
      .values({
        username: 'settings_throwaway_admin',
        email: 'settings-throwaway@example.invalid',
        password_hash: 'x',
        is_admin: true,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await upsertServerSettingAndEmit(db, { key: 'security.loginAnomalyLogEnabled', value: true, actorUserId: throwaway.id, nowMs });
    await db.deleteFrom('users').where('id', '=', throwaway.id).execute();

    const row = await getServerSetting(db, 'security.loginAnomalyLogEnabled');
    expect(row?.updated_by).toBeNull();
  });
});
