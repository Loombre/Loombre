// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/tvdb.live.spec.ts
//
// Network-optional live contract test. Skipped unless
// LOOMBRE_LIVE_PROVIDER_TESTS and LOOMBRE_TVDB_API_KEY are both set.

import { describe, expect, it } from 'vitest';
import { createDb } from '@loombre/db';
import { createTvdbProvider } from '../../../src/metadata/providers/tvdb.js';

const LIVE = process.env.LOOMBRE_LIVE_PROVIDER_TESTS === '1' && !!process.env.LOOMBRE_TVDB_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

describe.skipIf(!LIVE)('tvdb live contract', () => {
  it('logs in, searches, and fetches series details matching ProviderDetails shape', async () => {
    const db = createDb(DATABASE_URL);
    try {
      const provider = createTvdbProvider({ db });
      const results = await provider.search({ mediaKind: 'tv', title: 'Breaking Bad' });
      expect(results.length).toBeGreaterThan(0);
      const top = results[0]!;

      const details = await provider.fetchDetails(top.ref);
      expect(details.itemType).toBe('series');
      expect(details.providerIds.tvdb).toBe(top.ref.externalId);
    } finally {
      await db.destroy();
    }
  }, 30_000);
});
