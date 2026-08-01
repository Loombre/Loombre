// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/layers.spec.ts
//
// Unit tests for the buildLayers/toProvenanceMap extraction (see
// layers.ts's header — lifted verbatim out of metadata/consumer.ts so
// apps/worker/src/stash/apply.ts can reuse the exact same layer-seeding
// behavior). consumer.spec.ts already proves the extraction didn't change
// consumer.ts's own behavior; this file is the focused unit-level coverage
// buildLayers never had on its own (it was a private, untested-in-
// isolation helper before this extraction).

import { describe, expect, it } from 'vitest';
import { buildLayers, isEqual, toProvenanceMap } from '../../src/metadata/layers.js';

describe('isEqual', () => {
  it('primitives', () => {
    expect(isEqual(1, 1)).toBe(true);
    expect(isEqual('a', 'b')).toBe(false);
    expect(isEqual(null, null)).toBe(true);
    expect(isEqual(null, undefined)).toBe(false);
  });

  it('arrays compare element-wise, order-sensitive', () => {
    expect(isEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(isEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('plain objects compare via JSON.stringify', () => {
    expect(isEqual({ name: 'Jane', role: 'actor' }, { name: 'Jane', role: 'actor' })).toBe(true);
    expect(isEqual({ name: 'Jane' }, { name: 'John' })).toBe(false);
  });
});

describe('toProvenanceMap', () => {
  it('keys provenance rows by field', () => {
    const map = toProvenanceMap([
      { field: 'title', source: 'nfo', locked: true },
      { field: 'overview', source: 'provider:tmdb', locked: false },
    ]);
    expect(map).toEqual({
      title: { source: 'nfo', locked: true },
      overview: { source: 'provider:tmdb', locked: false },
    });
  });

  it('empty input yields an empty map', () => {
    expect(toProvenanceMap([])).toEqual({});
  });
});

describe('buildLayers', () => {
  it('seeds the nfo layer from the current value when provenance says nfo, alongside a provider layer', () => {
    const layers = buildLayers(
      'movie',
      { title: 'Provider Title' },
      { title: 'NFO Title' },
      { title: { source: 'nfo', locked: false } }
    );
    expect(layers.title).toEqual({ nfo: 'NFO Title', provider: 'Provider Title' });
  });

  it('does not seed a layer for a source the field provenance does not name', () => {
    const layers = buildLayers('movie', { title: 'Provider Title' }, { title: 'Untracked Title' }, {});
    // No provenance row at all — nfo/tags/filename stay unseeded even
    // though `current` has a value, matching the documented "the DB has
    // no separate shadow copy of each source's value" rule.
    expect(layers.title).toEqual({ provider: 'Provider Title' });
  });

  it('a field present only in `current` (absent from providerFields) still gets a layer entry (possibly empty)', () => {
    const layers = buildLayers('movie', {}, { tagline: 'Existing tagline' }, {});
    expect(layers.tagline).toEqual({});
  });

  it('always includes genres/tags/people field slots even when absent from both current and providerFields', () => {
    const layers = buildLayers('movie', {}, {}, {});
    expect(layers.genres).toEqual({});
    expect(layers.tags).toEqual({});
    expect(layers.people).toEqual({});
  });

  it('a providerFields value of explicit null still counts as "present" (field in providerFields)', () => {
    const layers = buildLayers('movie', { overview: null }, {}, {});
    expect(layers.overview).toEqual({ provider: null });
  });
});
