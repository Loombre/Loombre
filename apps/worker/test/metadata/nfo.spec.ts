// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/nfo.spec.ts
//
// Fixture-tested Kodi-dialect NFO parsing (P1.7). Fixtures live in
// test/metadata/fixtures/nfo/*.nfo — checked in, not generated.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNfo } from '../../src/metadata/nfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'nfo');

function read(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('parseNfo', () => {
  it('parses a movie.nfo (Kodi dialect): title/sorttitle/year/plot/mpaa/genres/tags/actors/uniqueids/premiered', () => {
    const result = parseNfo(read('movie.nfo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nfo.root).toBe('movie');
    expect(result.nfo.title).toBe('The Great Heist');
    expect(result.nfo.sortTitle).toBe('Great Heist, The');
    expect(result.nfo.year).toBe(2014);
    expect(result.nfo.plot).toBe('A crew pulls one last job.');
    expect(result.nfo.mpaa).toBe('R');
    expect(result.nfo.genres).toEqual(['Action', 'Crime']);
    expect(result.nfo.tags).toEqual(['heist', 'ensemble-cast']);
    expect(result.nfo.actors).toEqual([
      { name: 'Jane Doe', role: 'Lead', order: 0 },
      { name: 'John Smith', role: 'Sidekick', order: 1 },
    ]);
    expect(result.nfo.uniqueIds).toEqual([
      { type: 'tmdb', id: '12345' },
      { type: 'imdb', id: 'tt1234567' },
    ]);
    expect(result.nfo.premiered).toBe('2014-06-20');
    expect(result.nfo.season).toBeNull();
    expect(result.nfo.episode).toBeNull();
  });

  it('parses a tvshow.nfo', () => {
    const result = parseNfo(read('tvshow.nfo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nfo.root).toBe('tvshow');
    expect(result.nfo.title).toBe('Late Night Signal');
    expect(result.nfo.genres).toEqual(['Drama', 'Mystery']);
    expect(result.nfo.uniqueIds).toEqual([{ type: 'tvdb', id: '99887' }]);
  });

  it('parses an episodedetails NFO with season/episode', () => {
    const result = parseNfo(read('episode.nfo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nfo.root).toBe('episodedetails');
    expect(result.nfo.title).toBe('Static');
    expect(result.nfo.season).toBe(1);
    expect(result.nfo.episode).toBe(3);
    expect(result.nfo.actors).toEqual([{ name: 'Ada Lin', role: 'Host', order: 0 }]);
  });

  it('returns ok:false with a reason for malformed XML, never throws', () => {
    expect(() => parseNfo(read('malformed.nfo'))).not.toThrow();
    const result = parseNfo(read('malformed.nfo'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/xml parse error/i);
  });

  it('handles unicode content (accents, CJK, emoji) without corruption', () => {
    const result = parseNfo(read('unicode.nfo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nfo.title).toBe('Amélie au pays des merveilles: 東京物語');
    expect(result.nfo.plot).toBe('Café, naïveté, and a journey — with emoji: 🎬🍿.');
    expect(result.nfo.actors[0]?.name).toBe('François Dupont');
  });

  it('ignores unknown/unmapped child elements (passthrough-ignored, not an error)', () => {
    const result = parseNfo(read('unknown-tag.nfo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nfo.title).toBe('Widely Tagged');
    expect(result.nfo.year).toBe(2011);
    expect(result.nfo.genres).toEqual(['Documentary']);
    expect(result.nfo.uniqueIds).toEqual([{ type: 'tmdb', id: '55' }]);
  });

  it('returns ok:false for XML with no recognized root element', () => {
    const result = parseNfo('<?xml version="1.0"?><somethingelse><title>x</title></somethingelse>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no recognized root element/);
  });

  it('returns empty arrays/nulls (not a throw) for a minimal NFO missing most fields', () => {
    const result = parseNfo('<?xml version="1.0"?><movie><title>Bare</title></movie>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nfo.title).toBe('Bare');
    expect(result.nfo.year).toBeNull();
    expect(result.nfo.genres).toEqual([]);
    expect(result.nfo.actors).toEqual([]);
    expect(result.nfo.uniqueIds).toEqual([]);
  });
});
