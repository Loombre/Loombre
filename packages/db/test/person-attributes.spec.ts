// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/person-attributes.spec.ts
//
// Live-DB tests for src/internal/person-attributes.ts (migrations/0019 K3
// — the person-scoped twin of item_attributes). SELF-SUFFICIENT like
// test/internal.spec.ts.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { findOrCreatePerson, getPersonAttributes, upsertPersonAttribute } from '../src/internal/index.js';
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

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

describe('person-attributes', () => {
  it('upsertPersonAttribute inserts a new (person_id, namespace, key) row', async () => {
    const person = await findOrCreatePerson(db, 'Jane Doe', 'restricted');
    const row = await upsertPersonAttribute(db, { personId: person.id, namespace: 'stash', key: 'birthdateMs', value: { raw: '1990-05-01', ms: 641865600000 } });
    expect(row.person_id).toBe(person.id);
    expect(row.value).toEqual({ raw: '1990-05-01', ms: 641865600000 });
  });

  it('re-upserting the SAME key updates in place — same row id, no duplicate row', async () => {
    const person = await findOrCreatePerson(db, 'John Smith', 'restricted');
    const first = await upsertPersonAttribute(db, { personId: person.id, namespace: 'stash', key: 'aliases', value: { aliases: ['J.S.'] } });
    const second = await upsertPersonAttribute(db, { personId: person.id, namespace: 'stash', key: 'aliases', value: { aliases: ['J.S.', 'Johnny'] } });
    expect(second.id).toBe(first.id);

    const rows = await getPersonAttributes(db, person.id, 'stash');
    expect(rows.filter((r) => r.key === 'aliases')).toHaveLength(1);
    expect(rows.find((r) => r.key === 'aliases')?.value).toEqual({ aliases: ['J.S.', 'Johnny'] });
  });

  it('attributes are scoped per person — two people sharing a namespace/key never collide', async () => {
    const a = await findOrCreatePerson(db, 'Person Alpha', 'restricted');
    const b = await findOrCreatePerson(db, 'Person Beta', 'restricted');
    await upsertPersonAttribute(db, { personId: a.id, namespace: 'stash', key: 'country', value: { country: 'USA' } });
    await upsertPersonAttribute(db, { personId: b.id, namespace: 'stash', key: 'country', value: { country: 'CAN' } });

    expect((await getPersonAttributes(db, a.id, 'stash')).find((r) => r.key === 'country')?.value).toEqual({ country: 'USA' });
    expect((await getPersonAttributes(db, b.id, 'stash')).find((r) => r.key === 'country')?.value).toEqual({ country: 'CAN' });
  });

  it('deleting the owning person cascades (person_attributes FK ON DELETE CASCADE)', async () => {
    const person = await findOrCreatePerson(db, 'Ephemeral Person', 'restricted');
    await upsertPersonAttribute(db, { personId: person.id, namespace: 'stash', key: 'measurements', value: { measurements: '34-24-35' } });

    await db.deleteFrom('people').where('id', '=', person.id).execute();

    const rows = await getPersonAttributes(db, person.id, 'stash');
    expect(rows).toHaveLength(0);
  });
});
