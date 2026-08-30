// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/clearance.ts
//
// clearanceDigest — leak todo 6 ("recently-added / home rows are computed
// per-ViewerContext and never cached across differing clearances"). This is
// the cache-key ingredient a caller mixes into any memoization key for a
// per-viewer computation (getRecentlyAdded, getContinueWatching, search,
// ...): two ViewerContexts with the same clearance produce the same digest
// and may safely share a cache entry; two with different clearance produce
// different digests and therefore different cache entries, so a stale
// cleared-viewer's cache entry can never leak to an uncleared viewer via a
// shared key. This module does no caching itself — it only computes the
// key material.
//
// Pure function of ctx alone, no DB access — allowedLibraryIds is sorted
// before hashing so digest identity depends only on the SET of allowed
// libraries, not the order a caller happened to build the array in.

import { createHash } from 'node:crypto';
import type { ViewerContext } from '../context.js';

const DIGEST_HEX_LENGTH = 16;

export function clearanceDigest(ctx: ViewerContext): string {
  const material = JSON.stringify({
    userId: ctx.userId,
    restrictedCleared: ctx.restrictedCleared,
    // RZI surface scoping: general- and restricted-surface reads of the
    // same cleared viewer return different rows, so they may never share
    // a cache entry.
    surface: ctx.surface,
    allowedLibraryIds: [...ctx.allowedLibraryIds].sort(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, DIGEST_HEX_LENGTH);
}
