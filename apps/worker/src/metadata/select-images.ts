// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/select-images.ts
//
// One poster and one backdrop per item — chosen HERE, before anything is
// enqueued. The image pipeline stores exactly one file per (entity, kind)
// (poster-original + its variants, backdrop-original + variants), so every
// image job for the same kind overwrites the previous one, and the visible
// poster is simply whichever download finished last. A provider like TMDB
// returns the FULL image set for a title (435 posters and backdrops for one
// film on the reference box): enqueueing them all meant hundreds of
// wasted downloads per title and artwork that changed on every page
// refresh while the queue drained.
//
// Pure: a ranking over what the provider already told us, no I/O.

import type { ProviderImageRef } from './provider.js';

export interface SelectPrimaryImagesOptions {
  /** ISO 639-1 code the instance prefers for text-bearing artwork.
   *  Posters carry a title, so a poster in this language ranks first;
   *  backdrops are best textless, so a language-neutral backdrop ranks
   *  above one in any language. */
  preferredLanguage?: string;
}

const SELECTED_KINDS = ['poster', 'backdrop'] as const;
type SelectedKind = (typeof SELECTED_KINDS)[number];

function languageRank(kind: SelectedKind, language: string | null | undefined, preferred: string): number {
  const neutral = language === null || language === undefined || language === '';
  if (kind === 'backdrop') {
    if (neutral) return 3;
    return language === preferred ? 2 : 1;
  }
  if (language === preferred) return 3;
  if (neutral) return 2;
  return 1;
}

function pixels(image: ProviderImageRef): number {
  return (image.width ?? 0) * (image.height ?? 0);
}

/**
 * Returns at most one poster and at most one backdrop from `images`, in
 * that order; logos and every other kind are dropped (the metadata
 * consumer never enqueued them either). Ranking per kind: language (see
 * languageRank), then the provider's vote average, then vote count, then
 * pixel count; ties keep the provider's own order, which for TMDB is
 * already its popularity ordering.
 */
export function selectPrimaryImages(images: readonly ProviderImageRef[], options: SelectPrimaryImagesOptions = {}): ProviderImageRef[] {
  const preferred = (options.preferredLanguage ?? 'en').toLowerCase();
  const chosen: ProviderImageRef[] = [];
  for (const kind of SELECTED_KINDS) {
    let best: ProviderImageRef | undefined;
    let bestKey: readonly number[] | undefined;
    for (const image of images) {
      if (image.kind !== kind) continue;
      const key = [
        languageRank(kind, image.language?.toLowerCase(), preferred),
        image.voteAverage ?? -1,
        image.voteCount ?? -1,
        pixels(image),
      ] as const;
      if (bestKey === undefined || compareKeys(key, bestKey) > 0) {
        best = image;
        bestKey = key;
      }
    }
    if (best !== undefined) chosen.push(best);
  }
  return chosen;
}

/** Lexicographic compare; strictly greater only — an equal key keeps the
 *  earlier candidate (stable). */
function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
}
