// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/tmdb.live.spec.ts
//
// Network-optional live contract test: asserts the real TMDB API still
// matches the shapes test/metadata/fixtures/tmdb/*.json encode. Skipped
// entirely unless LOOMBRE_LIVE_PROVIDER_TESTS and LOOMBRE_TMDB_API_KEY are
// both set — this repo's CI runners never set either, so this suite is a
// local/manual opt-in check, not part of `pnpm gate`.

import { describe, expect, it } from 'vitest';
import { createDb } from '@loombre/db';
import { createTmdbProvider } from '../../../src/metadata/providers/tmdb.js';

const LIVE = process.env.LOOMBRE_LIVE_PROVIDER_TESTS === '1' && !!process.env.LOOMBRE_TMDB_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

describe.skipIf(!LIVE)('tmdb live contract', () => {
  it('search("The Matrix") returns a result shaped like ProviderSearchResult, and fetchDetails matches ProviderDetails shape', async () => {
    const db = createDb(DATABASE_URL);
    try {
      const provider = createTmdbProvider({ db });
      const results = await provider.search({ mediaKind: 'movie', title: 'The Matrix', year: 1999 });
      expect(results.length).toBeGreaterThan(0);
      const top = results[0]!;
      expect(typeof top.ref.externalId).toBe('string');
      expect(top.ref.mediaKind).toBe('movie');

      const details = await provider.fetchDetails(top.ref);
      expect(details.itemType).toBe('movie');
      expect(typeof details.title).toBe('string');
      expect(details.providerIds.tmdb).toBe(top.ref.externalId);

      const images = await provider.fetchImages(top.ref);
      expect(Array.isArray(images)).toBe(true);
    } finally {
      await db.destroy();
    }
  }, 30_000);
});
