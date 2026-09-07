// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { selectPrimaryImages } from '../../src/metadata/select-images.js';
import type { ProviderImageRef } from '../../src/metadata/provider.js';

function poster(url: string, extra: Partial<ProviderImageRef> = {}): ProviderImageRef {
  return { kind: 'poster', url, width: 2000, height: 3000, ...extra };
}
function backdrop(url: string, extra: Partial<ProviderImageRef> = {}): ProviderImageRef {
  return { kind: 'backdrop', url, width: 3840, height: 2160, ...extra };
}

describe('selectPrimaryImages', () => {
  it('returns at most one poster and one backdrop, in that order, and never a logo', () => {
    const chosen = selectPrimaryImages([
      { kind: 'logo', url: 'l' },
      backdrop('b1'),
      poster('p1'),
      poster('p2'),
      backdrop('b2'),
    ]);
    expect(chosen.map((i) => i.kind)).toEqual(['poster', 'backdrop']);
    expect(chosen).toHaveLength(2);
  });

  it('empty input, or input with no poster/backdrop, selects nothing', () => {
    expect(selectPrimaryImages([])).toEqual([]);
    expect(selectPrimaryImages([{ kind: 'logo', url: 'l' }])).toEqual([]);
  });

  it('a lone poster passes through even with no ranking data', () => {
    expect(selectPrimaryImages([poster('only')])).toEqual([poster('only')]);
  });

  it('poster: the preferred language wins over language-neutral, which wins over another language', () => {
    const chosen = selectPrimaryImages([
      poster('fr', { language: 'fr', voteAverage: 9 }),
      poster('neutral', { language: null, voteAverage: 9 }),
      poster('en', { language: 'en', voteAverage: 5 }),
    ]);
    expect(chosen[0]!.url).toBe('en');
    expect(selectPrimaryImages([poster('fr', { language: 'fr' }), poster('neutral', { language: null })])[0]!.url).toBe('neutral');
  });

  it('backdrop: textless (language-neutral) wins over the preferred language, which wins over another', () => {
    const chosen = selectPrimaryImages([
      backdrop('en', { language: 'en', voteAverage: 9 }),
      backdrop('textless', { language: null, voteAverage: 5 }),
      backdrop('de', { language: 'de', voteAverage: 9 }),
    ]);
    expect(chosen[0]!.url).toBe('textless');
    expect(selectPrimaryImages([backdrop('de', { language: 'de' }), backdrop('en', { language: 'en' })])[0]!.url).toBe('en');
  });

  it('within a language rank: vote average, then vote count, then pixel count decide', () => {
    expect(
      selectPrimaryImages([poster('a', { language: 'en', voteAverage: 5.2 }), poster('b', { language: 'en', voteAverage: 5.6 })])[0]!.url,
    ).toBe('b');
    expect(
      selectPrimaryImages([
        poster('few', { language: 'en', voteAverage: 5.6, voteCount: 3 }),
        poster('many', { language: 'en', voteAverage: 5.6, voteCount: 40 }),
      ])[0]!.url,
    ).toBe('many');
    expect(
      selectPrimaryImages([
        poster('small', { language: 'en', voteAverage: 5.6, voteCount: 40, width: 500, height: 750 }),
        poster('large', { language: 'en', voteAverage: 5.6, voteCount: 40, width: 2000, height: 3000 }),
      ])[0]!.url,
    ).toBe('large');
  });

  it('ties keep the provider\'s own order (TMDB already sorts by popularity)', () => {
    expect(selectPrimaryImages([poster('first'), poster('second')])[0]!.url).toBe('first');
  });

  it('preferredLanguage is honoured and compared case-insensitively', () => {
    const chosen = selectPrimaryImages([poster('en', { language: 'en' }), poster('de', { language: 'DE' })], { preferredLanguage: 'de' });
    expect(chosen[0]!.url).toBe('de');
  });

  it('the field case: hundreds of posters and backdrops collapse to two jobs', () => {
    const many: ProviderImageRef[] = [];
    for (let i = 0; i < 435; i += 1) {
      many.push(i % 2 === 0 ? poster(`p${i}`, { language: i % 7 === 0 ? 'en' : 'xx', voteAverage: (i % 10) / 2 }) : backdrop(`b${i}`, { language: i % 5 === 0 ? null : 'en' }));
    }
    const chosen = selectPrimaryImages(many);
    expect(chosen).toHaveLength(2);
    expect(chosen[0]!.kind).toBe('poster');
    expect(chosen[0]!.language).toBe('en');
    expect(chosen[1]!.kind).toBe('backdrop');
    expect(chosen[1]!.language).toBeNull();
  });
});
