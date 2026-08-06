// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/cursor-row-id-validation.spec.ts
//
// Live-DB regression suite for V1-002 (audit fafa47f, Fix Wave 4 lane
// FW4-A): every cursor-payload validator across this package's list/search
// surfaces binds its row-id field (`id`/`itemId`) straight into a `uuid`
// column keyset comparison. The shared codec's isCursorRowId() (src/query/
// cursor.ts) is the ONLY check that rejects a non-uuid value BEFORE it
// reaches the driver — without it, Postgres itself raises 22P02 ("invalid
// input syntax for type uuid") for what is an ordinary client input
// mistake (a corrupt/truncated/hand-edited cursor), which the HTTP layer
// can only render as an uncaught 500 (apps/server/src/gateway/
// problem-json.filter.ts only special-cases MalformedCursorError as a
// 422). Four zone surfaces (restricted-browse/performers/search/studios)
// already used isCursorRowId before this wave — see
// packages/db/test/leak.spec.ts's "THE SECOND FINDING" for their coverage;
// this file is the same test applied to the SEVENTEEN surfaces that had
// NOT been routed through it (the audit's own evidence said sixteen;
// re-enumerating from source turned up one more — see STATE.md). Two
// validators named in the audit's evidence are deliberately absent below:
// catalog-detail.ts's isListCursorPayload already validated its `id`
// against the same UUID_PATTERN inline (not broken, just not sharing the
// codec), and stash-sync-reports.ts's isStashSceneCursorPayload keys its
// cursor on Stash's own external scene id (TEXT, not uuid) — applying
// isCursorRowId there would be wrong, not a fix.
//
// Why a non-uuid id needs a REAL Postgres connection to prove the bug (and
// this file cannot be a pure synchronous unit test): every one of these
// functions builds its Kysely query LAZILY — decodeCursor() runs, and can
// throw, before the query is ever awaited. But a well-formed cursor whose
// `id` field is merely the WRONG STRING (not a uuid) still satisfies the
// pre-fix `typeof x.id === 'string'` check, so decodeCursor does NOT throw
// synchronously for that case — the malformed id is silently accepted and
// only fails once the query actually executes against Postgres. Reaching
// that failure (and observing which error class survives it) requires a
// live connection. No seed data is required, though: a malformed uuid
// literal fails Postgres's own type coercion at BIND time, before any row
// is scanned, so a freshly-migrated EMPTY schema reproduces the defect
// exactly as reliably as a seeded one (unlike catalog-detail.spec.ts, this
// file skips seed/seed.mjs entirely and only resets the schema).
//
// items.ts is additionally tested against STRUCTURALLY malformed cursors
// (truncated base64url, non-JSON, wrong shape) — its own local decodeCursor
// (pre-fix) never imported the shared codec at all and threw a bare
// `Error`, not `MalformedCursorError`, for ALL of those cases too — the
// "500s on ANY malformed cursor" claim the finding singles out as the
// worst instance (reachable with an ordinary corrupt/truncated cursor, not
// only a hand-forged one).
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
import type { ViewerContext } from '../src/context.js';
import { MalformedCursorError } from '../src/query/cursor.js';

import {
  listUsersAdmin,
  listDevicesForUser,
  listJobsAdmin,
  listActiveSessionsAdmin,
  listUnmatchedLibraryItemsForViewer,
} from '../src/query/admin.js';
import { listInvitesAdmin } from '../src/query/invites.js';
import { listLibrariesForViewer } from '../src/query/libraries.js';
import { listNoticesAdmin } from '../src/query/notices.js';
import { listPeople, listItemsForPerson } from '../src/query/people.js';
import { listProgress } from '../src/query/progress.js';
import { searchCatalog } from '../src/query/search.js';
import { listTags } from '../src/query/tags.js';
import { listWatchlist } from '../src/query/watchlist.js';
import { listWgPeers } from '../src/query/wg-peers.js';
import { listUnmatchedLoombreFiles } from '../src/query/stash-sync-reports.js';
import { listItems, getRecentlyAdded } from '../src/query/items.js';

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
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let db: Kysely<DB>;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db.destroy();
});

function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// Arbitrary, well-FORMED uuids — none need to reference an existing row:
// the defect under test is the CURSOR's id failing Postgres's type
// coercion, so every other id must itself be valid-shaped to keep the
// failure attributable to the cursor alone.
const SOME_USER_ID = '00000000-0000-7000-8000-000000000001';
const SOME_LIBRARY_ID = '00000000-0000-7000-8000-000000000002';
const SOME_PERSON_ID = '00000000-0000-7000-8000-000000000003';

const ctx: ViewerContext = { userId: SOME_USER_ID, allowedLibraryIds: [SOME_LIBRARY_ID], restrictedCleared: true };

// Not valid `uuid` input format (packages/db/src/query/cursor.ts's own
// UUID_PATTERN) — every value below must be REJECTED by isCursorRowId.
const BAD_IDS = ["not-a-uuid'; --", '', 'short', '00000000-0000-0000-0000-00000000000'];

describe('V1-002: cursor row-id validators reject a non-uuid id with MalformedCursorError, never a raw 500', () => {
  it('admin.ts listUsersAdmin', async () => {
    for (const id of BAD_IDS) {
      await expect(listUsersAdmin(db, { cursor: forge({ createdAtMs: 1, id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('admin.ts listDevicesForUser', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listDevicesForUser(db, SOME_USER_ID, { cursor: forge({ createdAtMs: 1, id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('admin.ts listJobsAdmin', async () => {
    for (const id of BAD_IDS) {
      await expect(listJobsAdmin(db, { cursor: forge({ createdAtMs: 1, id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('admin.ts listActiveSessionsAdmin', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listActiveSessionsAdmin(db, ctx, { cursor: forge({ startedAtMs: 1, id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('admin.ts listUnmatchedLibraryItemsForViewer', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listUnmatchedLibraryItemsForViewer(db, ctx, SOME_LIBRARY_ID, {
          cursor: forge({ addedAtMs: 1, id }),
        })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('invites.ts listInvitesAdmin', async () => {
    for (const id of BAD_IDS) {
      await expect(listInvitesAdmin(db, { cursor: forge({ createdAtMs: 1, id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('libraries.ts listLibrariesForViewer', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listLibrariesForViewer(db, ctx, { cursor: forge({ createdAtMs: 1, id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('notices.ts listNoticesAdmin', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listNoticesAdmin(db, { nowMs: 1, cursor: forge({ createdAtMs: 1, id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('people.ts listPeople', async () => {
    for (const id of BAD_IDS) {
      await expect(listPeople(db, ctx, { cursor: forge({ name: 'a', id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('people.ts listItemsForPerson', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listItemsForPerson(db, ctx, SOME_PERSON_ID, { cursor: forge({ addedAtMs: 1, itemId: id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('progress.ts listProgress', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listProgress(db, ctx, { cursor: forge({ updatedAtMs: 1, itemId: id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('search.ts searchCatalog', async () => {
    for (const id of BAD_IDS) {
      await expect(
        searchCatalog(db, ctx, { q: 'after', cursor: forge({ rank: 1, id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('tags.ts listTags', async () => {
    for (const id of BAD_IDS) {
      await expect(listTags(db, ctx, { cursor: forge({ name: 'a', id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('watchlist.ts listWatchlist', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listWatchlist(db, ctx, { cursor: forge({ addedAtMs: 1, itemId: id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('wg-peers.ts listWgPeers', async () => {
    for (const id of BAD_IDS) {
      await expect(listWgPeers(db, { cursor: forge({ createdAtMs: 1, id }) })).rejects.toThrow(
        MalformedCursorError
      );
    }
  });

  it('stash-sync-reports.ts listUnmatchedLoombreFiles', async () => {
    for (const id of BAD_IDS) {
      await expect(
        listUnmatchedLoombreFiles(db, SOME_LIBRARY_ID, { cursor: forge({ id }) })
      ).rejects.toThrow(MalformedCursorError);
    }
  });

  it('items.ts listItems / getRecentlyAdded — including a non-uuid id', async () => {
    for (const id of BAD_IDS) {
      const cursor = forge({ addedAtMs: 1, id });
      await expect(listItems(db, ctx, { cursor })).rejects.toThrow(MalformedCursorError);
      await expect(getRecentlyAdded(db, ctx, { cursor })).rejects.toThrow(MalformedCursorError);
    }
  });

  // items.ts is "the worst instance" (V1-002): pre-fix its local
  // decodeCursor never imported the shared codec, so even STRUCTURALLY
  // malformed cursors — the ordinary corrupt/truncated case, not only a
  // hand-forged uuid — threw a bare `Error`, never MalformedCursorError.
  it('items.ts listItems / getRecentlyAdded reject STRUCTURALLY malformed cursors (truncated, non-JSON, wrong shape) with MalformedCursorError too — the any-malformed-cursor claim', async () => {
    const structurallyBad = [
      '%%%not-base64%%%',
      Buffer.from('{"addedAtMs":1,"id":', 'utf8').toString('base64url'), // truncated JSON
      Buffer.from('[]', 'utf8').toString('base64url'), // valid JSON, wrong shape (not an object)
      Buffer.from('{"addedAtMs":1}', 'utf8').toString('base64url'), // missing id
    ];
    for (const cursor of structurallyBad) {
      await expect(listItems(db, ctx, { cursor })).rejects.toThrow(MalformedCursorError);
      await expect(getRecentlyAdded(db, ctx, { cursor })).rejects.toThrow(MalformedCursorError);
    }
  });
});
