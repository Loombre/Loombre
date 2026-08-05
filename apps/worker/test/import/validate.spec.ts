// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/import/validate.spec.ts
//
// Pure unit tests (no DB) for apps/worker/src/import/validate.ts —
// deliverable 4's "malformed archive sections -> typed job failure with the
// offending section/index in the error (not a stack trace)".

import { describe, expect, it } from 'vitest';
import { checkReferentialIntegrity, validateArchive, ImportValidationError, type ExportArchive } from '../../src/import/index.js';
import { buildArtist, buildEmptyArchive, buildEpisode, buildLibrary, buildMovie, buildProgress, buildSeason, buildSeries, buildUser } from './fixtures.js';

/** Casts a deliberately malformed/incomplete fixture into the typed slot
 *  under test — every case in this file exists to prove validateArchive()
 *  rejects exactly this kind of input, so the malformed value is the point,
 *  not a mistake `as any` would silently paper over. */
function malformed<T>(value: unknown): T {
  return value as T;
}

describe('validateArchive: structural shape', () => {
  it('accepts a well-formed empty archive', () => {
    expect(() => validateArchive(buildEmptyArchive())).not.toThrow();
  });

  it('rejects a non-object payload', () => {
    expect(() => validateArchive('not an object')).toThrow(ImportValidationError);
    expect(() => validateArchive(null)).toThrow(ImportValidationError);
    expect(() => validateArchive(undefined)).toThrow(ImportValidationError);
  });

  it('rejects a missing top-level array field, naming it', () => {
    const raw = { ...buildEmptyArchive() } as Record<string, unknown>;
    delete raw['items'];
    try {
      validateArchive(raw);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('"items"');
      expect((err as Error).message).not.toMatch(/at Object|at Module|node:internal/); // not a raw stack trace
    }
  });

  it('rejects a library missing a required field, naming section + index', () => {
    const archive = buildEmptyArchive({ libraries: [malformed<ExportArchive['libraries'][number]>({ id: 'x' })] });
    try {
      validateArchive(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('.libraries[0]');
    }
  });

  it('rejects an item with an unknown itemType, naming section + index', () => {
    const lib = buildLibrary();
    const badItem = { ...buildMovie(lib.id), itemType: 'not-a-real-type' };
    const archive = buildEmptyArchive({ libraries: [lib], items: [malformed<ExportArchive['items'][number]>(badItem)] });
    try {
      validateArchive(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('.items[0]');
      expect((err as Error).message).toContain('itemType');
    }
  });

  it('rejects a movie missing required "genres"', () => {
    const lib = buildLibrary();
    const movie = buildMovie(lib.id) as Record<string, unknown>;
    delete movie['genres'];
    const archive = buildEmptyArchive({ libraries: [lib], items: [malformed<ExportArchive['items'][number]>(movie)] });
    expect(() => validateArchive(archive)).toThrow(/\.items\[0\].*genres/s);
  });

  it('rejects a season missing seriesId', () => {
    const lib = buildLibrary();
    const series = buildSeries(lib.id);
    const season = buildSeason(lib.id, series.id, 1) as Record<string, unknown>;
    delete season['seriesId'];
    const archive = buildEmptyArchive({ libraries: [lib], items: [series, malformed<ExportArchive['items'][number]>(season)] });
    expect(() => validateArchive(archive)).toThrow(/\.items\[1\].*seriesId/s);
  });

  it('rejects a progress row at a bad index, naming it', () => {
    const archive = buildEmptyArchive({ progress: [malformed<ExportArchive['progress'][number]>({ itemId: 'x' })] });
    try {
      validateArchive(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('.progress[0]');
    }
  });

  it('rejects an unknown WatchState in a progress row', () => {
    const archive = buildEmptyArchive({
      progress: [buildProgress('some-item', malformed<Partial<ExportArchive['progress'][number]>>({ state: 'watching' }))],
    });
    expect(() => validateArchive(archive)).toThrow(/state/);
  });
});

describe('checkReferentialIntegrity', () => {
  it('accepts a fully self-consistent archive', () => {
    const lib = buildLibrary();
    const series = buildSeries(lib.id);
    const season = buildSeason(lib.id, series.id, 1);
    const episode = buildEpisode(lib.id, season.id, series.id, 1);
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [series, season, episode] }));
    expect(() => checkReferentialIntegrity(archive)).not.toThrow();
  });

  it('rejects an item whose libraryId is not in archive.libraries', () => {
    const lib = buildLibrary();
    const movie = buildMovie('some-other-library-id');
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [movie] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('.items[0]');
      expect((err as Error).message).toContain('libraryId');
    }
  });

  it('rejects a season whose seriesId does not resolve to any archive item', () => {
    const lib = buildLibrary();
    const season = buildSeason(lib.id, 'ghost-series-id', 1);
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [season] }));
    expect(() => checkReferentialIntegrity(archive)).toThrow(/\.items\[0\].*seriesId/s);
  });

  it('rejects an episode whose seriesId is inconsistent with its own season\'s seriesId', () => {
    const lib = buildLibrary();
    const seriesA = buildSeries(lib.id, { title: 'Series A' });
    const seriesB = buildSeries(lib.id, { title: 'Series B' });
    const season = buildSeason(lib.id, seriesA.id, 1);
    const episode = buildEpisode(lib.id, season.id, seriesB.id, 1); // wrong seriesId
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [seriesA, seriesB, season, episode] }));
    expect(() => checkReferentialIntegrity(archive)).toThrow(/inconsistent/);
  });

  it('rejects a progress row whose itemId is not in archive.items', () => {
    const archive = validateArchive(buildEmptyArchive({ progress: [buildProgress('ghost-item-id')] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('.progress[0]');
    }
  });

  it('accepts an artist/album/track chain and rejects a mismatched artistId', () => {
    const lib = buildLibrary({ mediaKind: 'music' });
    const artist = buildArtist(lib.id);
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [artist] }));
    expect(() => checkReferentialIntegrity(archive)).not.toThrow();
  });
});

// AUD-V2-M1 (merged from A2c-002 + A2c-003): checkReferentialIntegrity
// validates every REFERENCE an archive makes but, before this fix, never
// checked that the archive's own identity keys (item id, library id, user
// id/username) were unique — a duplicate item id silently overwrote the
// earlier row (consumer.ts's preserveIds upsert) and a duplicate username
// was silently absorbed as an in-transaction natural-key match
// (consumer.ts's getUserByUsername pre-insert lookup), in both cases with
// the import reporting success. These pure in-memory cases pin the
// fail-fast contract; consumer.spec.ts's live-DB cases prove the database
// is actually untouched when this fires from runImport().
describe('checkReferentialIntegrity: archive-internal uniqueness (AUD-V2-M1)', () => {
  it('rejects a duplicate item id, naming the id and both offending indices', () => {
    const lib = buildLibrary();
    const movieA = buildMovie(lib.id, { id: 'shared-item-id', title: 'First' });
    const movieB = buildMovie(lib.id, { id: 'shared-item-id', title: 'Second (duplicate id)' });
    const archive = validateArchive(buildEmptyArchive({ libraries: [lib], items: [movieA, movieB] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('shared-item-id');
      expect((err as Error).message).toContain('.items[1]');
      expect((err as Error).message).toContain('.items[0]');
    }
  });

  it('rejects a duplicate library id, naming the id and both offending indices', () => {
    const libA = buildLibrary({ id: 'shared-library-id', name: 'First' });
    const libB = buildLibrary({ id: 'shared-library-id', name: 'Second (duplicate id)' });
    const archive = validateArchive(buildEmptyArchive({ libraries: [libA, libB] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('shared-library-id');
      expect((err as Error).message).toContain('.libraries[1]');
    }
  });

  it('rejects a duplicate username across two archive.users rows, naming the username', () => {
    const userA = buildUser({ username: 'dup-name', id: 'user-a-id' });
    const userB = buildUser({ username: 'dup-name', id: 'user-b-id' });
    const archive = validateArchive(buildEmptyArchive({ users: [userA, userB] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('dup-name');
      expect((err as Error).message).toContain('.users[1]');
    }
  });

  it('rejects a duplicate user id even when usernames differ, naming the id', () => {
    const userA = buildUser({ username: 'user-a', id: 'shared-user-id' });
    const userB = buildUser({ username: 'user-b', id: 'shared-user-id' });
    const archive = validateArchive(buildEmptyArchive({ users: [userA, userB] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as Error).message).toContain('shared-user-id');
      expect((err as Error).message).toContain('.users[1]');
    }
  });

  // Reviewer reproduction against runImport (fix wave 2, FW2-B follow-up):
  // users.username is CITEXT NOT NULL UNIQUE (packages/db/migrations/
  // 0001_init.sql:132) and getUserByUsername (packages/db/src/query/
  // identity.ts:43) compares with a plain `=`, so the DATABASE treats "Bob"
  // and "bob" as the SAME username. Before this case, checkArchiveInternalUniqueness
  // keyed its Map on the raw string, so "Bob" and "bob" hashed to different
  // keys and sailed through — the archive then reached runImport(), where
  // "Bob" inserted first and "bob" silently took the natural-key "skip"
  // branch (consumer.ts's users loop, same silent-absorb mechanism AUD-V2-M1
  // already named for an EXACT duplicate). This pins the case-insensitive
  // half of that failure mode at the validator layer, matching the column's
  // real collation.
  it('rejects a same-archive username collision that differs only by case (CITEXT collation), naming both raw spellings', () => {
    const userA = buildUser({ username: 'Bob', id: 'user-a-id', email: 'bob-a@example.com' });
    const userB = buildUser({ username: 'bob', id: 'user-b-id', email: 'bob-b@example.com' });
    const archive = validateArchive(buildEmptyArchive({ users: [userA, userB] }));
    try {
      checkReferentialIntegrity(archive);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      // Both RAW spellings must be named — an operator seeing only "bob"
      // twice cannot tell which row is which.
      expect((err as Error).message).toContain('Bob');
      expect((err as Error).message).toContain('bob');
      expect((err as Error).message).toContain('.users[1]');
    }
  });
});
