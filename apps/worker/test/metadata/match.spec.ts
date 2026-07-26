// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/match.spec.ts

import { describe, expect, it, vi } from 'vitest';
import { pickBestMatch, titleSimilarity } from '../../src/metadata/match.js';
import type { ProviderSearchResult } from '../../src/metadata/provider.js';

function result(title: string, year: number | null, externalId: string): ProviderSearchResult {
  return { ref: { provider: 'fake', externalId, mediaKind: 'movie' }, title, year };
}

describe('titleSimilarity', () => {
  it('is 1 for identical titles', () => {
    expect(titleSimilarity('The Great Heist', 'The Great Heist')).toBe(1);
  });

  it('is 1 for titles differing only in case/punctuation', () => {
    expect(titleSimilarity('The Great Heist', 'the great heist!')).toBe(1);
  });

  it('is lower for dissimilar titles', () => {
    const close = titleSimilarity('The Great Heist', 'The Great Heisted');
    const far = titleSimilarity('The Great Heist', 'Completely Different Movie');
    expect(close).toBeGreaterThan(far);
  });

  it('ignores diacritics', () => {
    expect(titleSimilarity('Amélie', 'Amelie')).toBe(1);
  });
});

describe('pickBestMatch', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickBestMatch({ mediaKind: 'movie', title: 'x' }, [])).toBeNull();
  });

  it('picks the exact title+year match over a same-title-different-year candidate', () => {
    const candidates = [result('The Great Heist', 2020, 'a'), result('The Great Heist', 2014, 'b')];
    const best = pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist', year: 2014 }, candidates);
    expect(best?.ref.externalId).toBe('b');
  });

  it('picks the closer title match when years are equal', () => {
    const candidates = [result('The Great Heisted Movie', 2014, 'a'), result('The Great Heist', 2014, 'b')];
    const best = pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist', year: 2014 }, candidates);
    expect(best?.ref.externalId).toBe('b');
  });

  it('is deterministic: first candidate wins an exact tie', () => {
    const candidates = [result('Same Title', 2000, 'a'), result('Same Title', 2000, 'b')];
    const best1 = pickBestMatch({ mediaKind: 'movie', title: 'Same Title', year: 2000 }, candidates);
    const best2 = pickBestMatch({ mediaKind: 'movie', title: 'Same Title', year: 2000 }, candidates);
    expect(best1?.ref.externalId).toBe('a');
    expect(best2?.ref.externalId).toBe('a');
  });

  it('ignores year distance when the query has no year', () => {
    const candidates = [result('The Great Heist', 1950, 'a')];
    const best = pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist' }, candidates);
    expect(best?.ref.externalId).toBe('a');
  });

  it('logs an ambiguity warning when the top two candidates are close', () => {
    const log = vi.fn();
    // Neither candidate matches the query title exactly; their similarity
    // scores land within the ambiguity margin of each other.
    const candidates = [result('The Great Heists', 2014, 'a'), result('The Great Meist', 2014, 'b')];
    const best = pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist', year: 2014 }, candidates, { log });
    expect(best?.ref.externalId).toBe('a');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/ambiguous match/i);
  });

  it('does not log when the top candidate is clearly ahead', () => {
    const log = vi.fn();
    const candidates = [result('The Great Heist', 2014, 'a'), result('Something Totally Unrelated', 1975, 'b')];
    pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist', year: 2014 }, candidates, { log });
    expect(log).not.toHaveBeenCalled();
  });

  it('does not log when there is only one candidate', () => {
    const log = vi.fn();
    pickBestMatch({ mediaKind: 'movie', title: 'The Great Heist', year: 2014 }, [result('The Great Heist', 2014, 'a')], {
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
