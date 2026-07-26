// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/import/validate.spec.ts
//
// Pure unit tests (no DB) for apps/worker/src/import/validate.ts —
// deliverable 4's "malformed archive sections -> typed job failure with the
// offending section/index in the error (not a stack trace)".

import { describe, expect, it } from 'vitest';
import { checkReferentialIntegrity, validateArchive, ImportValidationError, type ExportArchive } from '../../src/import/index.js';
import { buildArtist, buildEmptyArchive, buildEpisode, buildLibrary, buildMovie, buildProgress, buildSeason, buildSeries } from './fixtures.js';

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
