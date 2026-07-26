// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/blaze-paths.ts
//
// STATE.md "Blaze logo rollout", D1 + D3: the ONE geometry source for the
// Blaze mark ("three-tongue flame, inner flame as negative space"). No path
// string, gradient stop, or scanline pattern constant may be copy-pasted
// anywhere else in the tree — every consumer (BlazeMark.tsx today; the W1
// boot-splash and spinner lanes later) imports from here. Values below are
// transcribed byte-for-byte from the design masters in
// design/blaze/assets/svg/ (loombre-mark.svg / -mark-flat.svg /
// -mark-scanline.svg) — blaze-provenance.test.ts pins that transcription
// mechanically (readFileSync the masters, diff against these exports) so
// drift here or in the masters fails CI, not just an eyeball review.
//
// viewBox is fixed 0 0 96 96 (design/blaze/README.md "The Mark") — every
// BlazeMark render uses this viewBox regardless of the `size` prop, which
// only drives the rendered width/height.
export const BLAZE_VIEWBOX = "0 0 96 96";

// Outer flame subpath (the visible three-tongue silhouette).
export const BLAZE_OUTER_D =
  "M56 6 C50 12 44 20 41 30 C37 27 33 23 28 18 C26 28 21 34 19 44 C16 55 19 66 27 73 C34 79 41 83 48 84 C57 84 65 79 69 70 C72 63 72 55 68 46 C67 43 66 41 67 38 C70 36 74 33 77 28 C73 25 68 24 64 24 C59 18 57 12 56 6 Z";

// Inner core subpath — the negative-space cut-out (design/blaze/README.md
// "The Mark": "Combine both in ONE <path> with fill-rule=evenodd so the
// core is a true hole").
export const BLAZE_CORE_D =
  "M50 34 C47 40 43 45 42 52 C40 49 38 47 36 46 C34 52 33 57 34 62 C36 71 42 77 49 78 C56 77 62 71 63 62 C63 54 58 47 54 41 C52 38 51 36 50 34 Z";

// Static-mode single-path `d` — outer + core, space-joined exactly as the
// masters author it (verified byte-equal to the masters' own `d` attribute
// by blaze-provenance.test.ts).
export const BLAZE_COMBINED_D = `${BLAZE_OUTER_D} ${BLAZE_CORE_D}`;

export interface BlazeGradientStop {
  offset: string;
  color: string;
}

// design/blaze/README.md "Variants": "vertical gradient #FFD9A0 (0%) →
// #FFB454 (50%) → #E08F2E (100%), bottom→top" — x1/y1/x2/y2 below encode
// "bottom→top" (y1=1 is the bottom edge of the viewBox, y2=0 the top).
export const BLAZE_GRADIENT_X1 = "0";
export const BLAZE_GRADIENT_Y1 = "1";
export const BLAZE_GRADIENT_X2 = "0";
export const BLAZE_GRADIENT_Y2 = "0";

export const BLAZE_GRADIENT_STOPS: readonly BlazeGradientStop[] = [
  { offset: "0", color: "#FFD9A0" },
  { offset: "0.5", color: "#FFB454" },
  { offset: "1", color: "#E08F2E" },
];

// Flat-variant fill is the brand-fixed amber token (G4 — NEVER
// --color-accent, which is user-swappable).
export const BLAZE_FLAT_FILL = "var(--brand-amber)";

// design/blaze/README.md "Variants": "loombre-mark-scanline.svg — gradient +
// horizontal scanlines (1.2px black @ 35% every 3.2px), clipped to the
// flame." Transcribed from the mark-scanline.svg master's <pattern>/<rect>.
export interface BlazeScanlinePattern {
  width: number;
  height: number;
  lineHeight: number;
  color: string;
  opacity: number;
}

export const BLAZE_SCANLINE_PATTERN: BlazeScanlinePattern = {
  width: 96,
  height: 3.2,
  lineHeight: 1.2,
  color: "#000000",
  opacity: 0.35,
};

// The master's overlay <rect> that the scanline pattern fills, clipped to
// the flame's clipPath.
export interface BlazeScanlineOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BLAZE_SCANLINE_OVERLAY_RECT: BlazeScanlineOverlayRect = {
  x: 14,
  y: 2,
  width: 68,
  height: 86,
};
