// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/musicbrainz.live.spec.ts
//
// Network-optional live contract test. Skipped unless
// LOOMBRE_LIVE_PROVIDER_TESTS=1 is set (no API key needed for MusicBrainz).

import { describe, expect, it } from 'vitest';
import { createDb } from '@loombre/db';
import { createMusicBrainzProvider } from '../../../src/metadata/providers/musicbrainz.js';

const LIVE = process.env.LOOMBRE_LIVE_PROVIDER_TESTS === '1';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

describe.skipIf(!LIVE)('musicbrainz live contract', () => {
  it('searches a release-group and fetches album details matching ProviderDetails shape', async () => {
    const db = createDb(DATABASE_URL);
    try {
      const provider = createMusicBrainzProvider({ db });
      const results = await provider.search({ mediaKind: 'music', title: 'Nevermind', entityKind: 'album' });
      expect(results.length).toBeGreaterThan(0);
      const top = results[0]!;

      const details = await provider.fetchDetails(top.ref);
      expect(details.itemType).toBe('album');
      expect(details.providerIds.musicbrainz).toBe(top.ref.externalId);
    } finally {
      await db.destroy();
    }
  }, 30_000);
});
