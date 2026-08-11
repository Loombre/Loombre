// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/events-ordering.spec.ts
//
// Task #9 (STATE.md): proves readEventsForViewer / filterEventsForViewer /
// readUnprocessedEvents (src/query/events.ts) order by `events.seq`, not
// `events.id`, and therefore return same-millisecond sibling events in
// TRUE insertion order even when their UUIDv7 ids happen to sort the
// OPPOSITE way — the exact adversarial-id-ordering technique
// packages/jobs/test/ledger-events.spec.ts's "read order does not depend
// on job.updated ids being insertion-ordered" case established for
// migrations/0039_events_seq.sql's root defect, applied here to the three
// events.ts functions that actually feed viewer/broadcaster delivery
// (that migration's own header + events.ts's header document why `id`
// alone cannot be trusted as an insertion-order tiebreak: loombre_uuidv7()
// fills every non-timestamp bit from plain `random()`).
//
// Self-sufficient (own ensureTestDatabase suffix, own reset — no
// seed/seed.mjs needed): every fixture event below is typed 'user.created',
// a pass-through type absent from events.ts's GATED_TYPES, so it is visible
// to any well-formed ViewerContext with zero catalog/library fixture data
// required. Rows are inserted directly via a raw pg.Client (bypassing
// writeEvent/loombre_uuidv7()) so the id can be chosen adversarially while
// `seq` (Postgres's own identity sequence, assigned at INSERT time
// regardless of the caller-supplied id) still reflects true insertion
// order — precisely mirroring ledger-events.spec.ts's insertRaw helper.
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
import type { ViewerContext } from '../src/context.js';
import { ensureTestDatabase } from '../src/testing.js';
import { filterEventsForViewer, readEventsForViewer, readUnprocessedEvents } from '../src/query/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;
let DATABASE_URL: string;

// No catalog/library association required (pass-through type) — a fixed,
// syntactically-valid UUID stands in for "some authenticated viewer".
const ctx: ViewerContext = {
  userId: '00000000-0000-7000-8000-0000000000c1',
  allowedLibraryIds: [],
  restrictedCleared: false,
};

// Same-millisecond pair, id order DELIBERATELY REVERSED relative to
// insertion order — the exact shape a same-millisecond loombre_uuidv7()
// collision can produce under load (ledger-events.spec.ts's own comment),
// forced here instead of raced so the test cannot flake.
const TS_MS = Date.now();
const FIRST_ID = 'ffffffff-ffff-7fff-8fff-ffffffffffff'; // inserted FIRST, lexicographically LARGEST
const SECOND_ID = '00000000-0000-7000-8000-000000000001'; // inserted SECOND, lexicographically SMALLEST

async function insertRaw(id: string, order: 'first' | 'second'): Promise<void> {
  await rawClient.query(
    `INSERT INTO events (id, type, ts_ms, actor_user_id, payload) VALUES ($1, 'user.created', $2, NULL, $3::jsonb)`,
    [id, TS_MS, JSON.stringify({ marker: 'events-ordering-spec', order })]
  );
}

beforeAll(async () => {
  DATABASE_URL = await ensureTestDatabase(BASE_DATABASE_URL, 'events_ordering_test');
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset'], DATABASE_URL);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  // Physical/seq insertion order: FIRST_ID, then SECOND_ID.
  // Lexicographic (`id ASC`) order: SECOND_ID, then FIRST_ID — the reverse.
  await insertRaw(FIRST_ID, 'first');
  await insertRaw(SECOND_ID, 'second');
}, 30_000);

afterAll(async () => {
  await rawClient.end();
  await db.destroy();
});

describe('events.ts ordering (Task #9: seq, not id)', () => {
  it('readEventsForViewer returns same-millisecond siblings in seq (insertion) order, not id order', async () => {
    const rows = await readEventsForViewer(db, ctx, {});
    const marked = rows.filter((r) => (r.payload as { marker?: string }).marker === 'events-ordering-spec');
    expect(marked.map((r) => (r.payload as { order: string }).order)).toEqual(['first', 'second']);
    // Sanity: if this ever regresses to `ORDER BY id`, the lexicographic
    // id order (SECOND_ID < FIRST_ID) would produce ['second', 'first']
    // instead — this assertion is what catches that regression.
    expect(marked.map((r) => r.id)).toEqual([FIRST_ID, SECOND_ID]);
  });

  it('readEventsForViewer: afterSeq cursors on seq, not id — the first row is excluded by its OWN seq, not skipped/duplicated by an id-ordering artifact', async () => {
    const all = await readEventsForViewer(db, ctx, {});
    const marked = all.filter((r) => (r.payload as { marker?: string }).marker === 'events-ordering-spec');
    const firstRow = marked[0]!;

    const after = await readEventsForViewer(db, ctx, { afterSeq: firstRow.seq });
    const markedAfter = after.filter((r) => (r.payload as { marker?: string }).marker === 'events-ordering-spec');
    expect(markedAfter.map((r) => (r.payload as { order: string }).order)).toEqual(['second']);
  });

  it('filterEventsForViewer returns the SAME (seq, not id) order the websocket broadcaster relies on for ws.send() sequencing', async () => {
    // Passed in id-ascending (i.e. [SECOND_ID, FIRST_ID]) order deliberately
    // — filterEventsForViewer must not just preserve caller order, and must
    // not fall back to id order either.
    const rows = await filterEventsForViewer(db, ctx, [SECOND_ID, FIRST_ID]);
    expect(rows.map((r) => r.id)).toEqual([FIRST_ID, SECOND_ID]);
    expect(rows.map((r) => (r.payload as { order: string }).order)).toEqual(['first', 'second']);
  });

  it('readUnprocessedEvents (the outbox-drain poll) returns unprocessed rows in seq order, not id order', async () => {
    const rows = await readUnprocessedEvents(db, 100);
    const marked = rows.filter((r) => (r.payload as { marker?: string }).marker === 'events-ordering-spec');
    expect(marked.map((r) => r.id)).toEqual([FIRST_ID, SECOND_ID]);
    expect(marked.map((r) => (r.payload as { order: string }).order)).toEqual(['first', 'second']);
  });
});
