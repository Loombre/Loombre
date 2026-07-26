// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/manifest.ts
//
// STATE.md "Blaze logo rollout" D7 / Wave 0 task B (G1: apps/web served NO
// manifest before this run — this file CREATES the wiring, there was
// nothing to replace). Next's file-based metadata convention: this
// module's default export is picked up automatically, served at
// /manifest.webmanifest, and Next injects the <link rel="manifest"> tag
// into every route's <head> with no further wiring needed in layout.tsx —
// see the W0 freeze report for the served <head> proof.
//
// theme_color/background_color below are two REAL Phosphor tokens
// (src/styles/tokens.css), not invented hex:
//   - theme_color: --brand-amber (#FFB454) — the brand-fixed flat-mark
//     amber (G4: NEVER --color-accent, the user-swappable four-way
//     preference) — what should tint OS chrome for an installed PWA.
//   - background_color: --color-bg (#0B0C0F) — the app-wide near-black
//     background, shown by the OS behind the icon while an installed app
//     is still loading.
//
// Icon: the 1024x1024 dark app-icon PNG (design/blaze/README.md "App Icons
// & Favicons" — bg #101218, flat amber mark at 680px centered, x 183/y
// 193) doubles as both "any" and "maskable" purpose — the mark already
// sits well inside a safe-zone circle at 680/1024 ≈ 66% of the icon's
// width, comfortably inside the ~80% maskable safe zone, so an OS clipping
// it to a circle/squircle/rounded-square never crops the flame.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Loombre",
    short_name: "Loombre",
    description: "Loombre — self-hosted media streaming platform",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0c0f", // --color-bg
    theme_color: "#ffb454", // --brand-amber (G4 — brand-fixed, never --color-accent)
    icons: [
      {
        src: "/loombre-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/loombre-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
