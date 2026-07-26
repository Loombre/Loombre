// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/precedence.spec.ts
//
// Exhaustive table-driven tests for mergeFields (P1.7): every precedence
// pair (nfo > tags > provider > filename), lock beats all, and absent
// layers skip.

import { describe, expect, it } from 'vitest';
import { mergeFields, type ExistingProvenance, type LayeredFields } from '../../src/metadata/precedence.js';

describe('mergeFields', () => {
  describe('single-layer resolution (absent layers skip)', () => {
    const cases: { name: string; layers: LayeredFields; expectSource: string }[] = [
      { name: 'nfo only', layers: { title: { nfo: 'NFO Title' } }, expectSource: 'nfo' },
      { name: 'tags only', layers: { title: { tags: 'Tag Title' } }, expectSource: 'tag' },
      { name: 'provider only', layers: { title: { provider: 'Provider Title' } }, expectSource: 'provider:tmdb' },
      { name: 'filename only', layers: { title: { filename: 'Filename Title' } }, expectSource: 'filename' },
    ];

    for (const { name, layers, expectSource } of cases) {
      it(`resolves ${name}`, () => {
        const result = mergeFields(layers);
        expect(result.fields.title).toBe(Object.values(layers.title!)[0]);
        expect(result.provenance).toEqual([{ field: 'title', source: expectSource }]);
      });
    }

    it('a field with no layers present at all is skipped entirely', () => {
      const result = mergeFields({ title: {} });
      expect(result.fields).toEqual({});
      expect(result.provenance).toEqual([]);
    });
  });

  describe('pairwise precedence (every ordered pair)', () => {
    const pairCases: {
      name: string;
      layers: LayeredFields;
      expectedValue: string;
      expectedSource: string;
    }[] = [
      { name: 'nfo beats tags', layers: { f: { nfo: 'N', tags: 'T' } }, expectedValue: 'N', expectedSource: 'nfo' },
      { name: 'nfo beats provider', layers: { f: { nfo: 'N', provider: 'P' } }, expectedValue: 'N', expectedSource: 'nfo' },
      { name: 'nfo beats filename', layers: { f: { nfo: 'N', filename: 'F' } }, expectedValue: 'N', expectedSource: 'nfo' },
      { name: 'tags beats provider', layers: { f: { tags: 'T', provider: 'P' } }, expectedValue: 'T', expectedSource: 'tag' },
      { name: 'tags beats filename', layers: { f: { tags: 'T', filename: 'F' } }, expectedValue: 'T', expectedSource: 'tag' },
      { name: 'provider beats filename', layers: { f: { provider: 'P', filename: 'F' } }, expectedValue: 'P', expectedSource: 'provider:tmdb' },
    ];

    for (const { name, layers, expectedValue, expectedSource } of pairCases) {
      it(name, () => {
        const result = mergeFields(layers);
        expect(result.fields.f).toBe(expectedValue);
        expect(result.provenance).toEqual([{ field: 'f', source: expectedSource }]);
      });
    }

    it('full stack: nfo wins over tags+provider+filename all present', () => {
      const result = mergeFields({ f: { nfo: 'N', tags: 'T', provider: 'P', filename: 'F' } });
      expect(result.fields.f).toBe('N');
      expect(result.provenance).toEqual([{ field: 'f', source: 'nfo' }]);
    });
  });

  describe('lock beats all', () => {
    it('a field locked via existingProvenance is never overwritten, even by nfo', () => {
      const existingProvenance: ExistingProvenance = { f: { source: 'provider:tmdb', locked: true } };
      const result = mergeFields({ f: { nfo: 'N', tags: 'T', provider: 'P', filename: 'F' } }, existingProvenance);
      expect(result.fields).toEqual({});
      expect(result.provenance).toEqual([]);
    });

    it('a field locked via the locks override is never overwritten', () => {
      const result = mergeFields({ f: { nfo: 'N' } }, {}, { f: true });
      expect(result.fields).toEqual({});
      expect(result.provenance).toEqual([]);
    });

    it('locks override takes precedence over an existingProvenance locked:false', () => {
      const existingProvenance: ExistingProvenance = { f: { source: 'nfo', locked: false } };
      const result = mergeFields({ f: { provider: 'P' } }, existingProvenance, { f: true });
      expect(result.fields).toEqual({});
    });

    it('a field with locked:false in existingProvenance is still resolved normally', () => {
      const existingProvenance: ExistingProvenance = { f: { source: 'nfo', locked: false } };
      const result = mergeFields({ f: { provider: 'P' } }, existingProvenance);
      expect(result.fields.f).toBe('P');
      expect(result.provenance).toEqual([{ field: 'f', source: 'provider:tmdb' }]);
    });

    it('locking one field does not affect resolution of an independent field', () => {
      const existingProvenance: ExistingProvenance = { locked_field: { source: 'nfo', locked: true } };
      const result = mergeFields(
        { locked_field: { provider: 'P' }, other_field: { provider: 'Q' } },
        existingProvenance
      );
      expect(result.fields).toEqual({ other_field: 'Q' });
      expect(result.provenance).toEqual([{ field: 'other_field', source: 'provider:tmdb' }]);
    });
  });

  describe('multi-field independence', () => {
    it('resolves several fields independently in one call', () => {
      const result = mergeFields({
        title: { nfo: 'NFO Title', provider: 'Provider Title' },
        overview: { provider: 'Provider overview' },
        tagline: { filename: 'from-filename' },
        untouched: {},
      });
      expect(result.fields).toEqual({
        title: 'NFO Title',
        overview: 'Provider overview',
        tagline: 'from-filename',
      });
      expect(result.provenance).toEqual(
        expect.arrayContaining([
          { field: 'title', source: 'nfo' },
          { field: 'overview', source: 'provider:tmdb' },
          { field: 'tagline', source: 'filename' },
        ])
      );
      expect(result.provenance).toHaveLength(3);
    });
  });

  describe('providerSource parameter', () => {
    it('tags the provider layer with whichever provider source is supplied', () => {
      const result = mergeFields({ f: { provider: 'P' } }, {}, {}, 'provider:tvdb');
      expect(result.provenance).toEqual([{ field: 'f', source: 'provider:tvdb' }]);
    });
  });

  describe('falsy-but-defined values are respected (not treated as absent)', () => {
    it('an empty string / 0 / false / null provider value still wins over a lower-precedence layer', () => {
      const result = mergeFields({
        emptyString: { nfo: '', filename: 'fallback' },
        zero: { nfo: 0, filename: 999 },
        falseVal: { nfo: false, filename: true },
        nullVal: { nfo: null, filename: 'fallback' },
      });
      expect(result.fields).toEqual({ emptyString: '', zero: 0, falseVal: false, nullVal: null });
    });
  });
});
