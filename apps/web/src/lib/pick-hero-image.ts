// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/pick-hero-image.ts
//
// Shared "which image kind backs this item's hero art" preference order —
// factored out of app/items/[itemType]/[id]/page.tsx (P2 work item 4) so
// the new Phosphor screen components (MovieDetailScreen.tsx,
// SeriesDetailScreen.tsx) can share it with every other detail screen
// instead of each re-deriving the same fallback chain.

export interface ImageDescriptorLike {
  kind: string;
  dominantColor?: string | null;
}

export interface HeroImagePick {
  kind: string;
  dominantColor: string | null;
}

const PREFERENCE_ORDER = ["backdrop", "poster", "thumb", "disc", "logo"];

export function pickHeroImage(images: ImageDescriptorLike[] | undefined): HeroImagePick {
  for (const kind of PREFERENCE_ORDER) {
    const found = images?.find((img) => img.kind === kind);
    if (found) return { kind, dominantColor: found.dominantColor ?? null };
  }
  return { kind: "poster", dominantColor: null };
}
