// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/SceneBanner.tsx
//
// Movie/Series-detail "scene banner" (design/phosphor/README.md "Movie
// detail" / "Series detail": 340px / 320px full-bleed backdrop with
// scanlines + a bottom scrim + a "← LIBRARY" glass pill). Deliberately a
// NEW component, not a reskin of AmbientHero.tsx: AmbientHero renders an
// INSET, rounded, blurred-backdrop card (the pre-Phosphor P2.11 treatment,
// still correct for episode/artist/album/track detail, out of this lane's
// scope) — the prototype's movie/series banner is a structurally different,
// edge-to-edge, unblurred backdrop with content pulled up ON TOP of it.
// SceneBanner.module.css cancels AppShell's `.main` padding with a matching
// negative margin (see that file's header) to bleed to the content area's
// real edges without touching shell CSS.
//
// Scanlines (U4/L7 seam): design/phosphor/README.md "Other" — "ship it
// behind a user preference or drop it; do not make it non-optional". No
// scanlines preference exists yet (STATE.md: "W2 L7 scope"), so this
// renders the overlay ON by default (matches the prototype) behind a
// `data-scanlines` attribute L7's preference work can flip without
// touching this component — the exact hook the Wave-2 L4 brief asks for.
//
// Missing-artwork fallback (S5, Phosphor W3 fidelity-audit finding): no
// broken-image glyph on a seeded install with no backdrop scanned yet.
// Same onError-flip pattern as DetailPoster.tsx (the established
// "reuse, don't invent" fallback this app already ships): the <img> is
// removed from the tree on error and an oversized translucent initial
// renders over the SAME gradient DetailPoster uses (per-item hue via
// dominantColor -> --banner-glow, falling back to --color-dominant-
// fallback when none is known) — DetailPoster's exact two-stop radial
// recipe, just under a different custom-property name so this
// component's own CSS module owns it. Unlike DetailPoster, the banner
// does NOT duplicate the title as fallback text: SceneBanner always
// receives the real eyebrow+title as `overlay` content already anchored
// on top of it (MovieDetailScreen pulls it further below; SeriesDetail-
// Screen puts it directly in the banner) — printing the title a second
// time on the backdrop itself would be a redundant duplicate label,
// exactly the reasoning DetailPoster's own header already applies to why
// ITS fallback title is real-artwork-free.
//
// `title`/`dominantColor` are OPTIONAL: MovieDetailScreen.tsx/
// SeriesDetailScreen.tsx (this screen's only two callers) are outside
// this fix lane's file grant (FX1 owns SceneBanner.tsx itself, not its
// callers — parallel lanes may be touching those screens this same
// wave), so this component must keep working with zero call-site changes.
// Omitted `title` falls back to a bare "?" glyph; omitted `dominantColor`
// falls back to the flat --color-dominant-fallback tone (same default
// DetailPoster itself uses when a hero has none). Threading
// `movie.title`/`hero.dominantColor` and `series.title`/`hero.
// dominantColor` through at the two call sites (one line each, the data
// already exists there) is a real, honest follow-up — logged in this
// lane's freeze report, not silently left unfixed.

import { useState, type ReactNode } from "react";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./SceneBanner.module.css";

export interface SceneBannerProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  backdropKind: string;
  /** 340 (movie) / 320 (series) per the prototype. This component renders
   *  the DESKTOP treatment only (CSS-hidden below the 767.98px breakpoint,
   *  same coexist-in-DOM/CSS-swap convention as AppShell's sidebar/mobile
   *  chrome) — the mobile screens use MobileSceneCard.tsx instead, a
   *  genuinely different arrangement (compact rounded card, no separate
   *  poster/pull-up), not a squished reflow of this one. */
  desktopHeight: number;
  /** Item title — only its first letter is ever shown, and only behind
   *  the missing-artwork fallback (see this file's header). Optional
   *  (falls back to "?"); see this file's header for why. */
  title?: string;
  /** Real per-item hue (lib/pick-hero-image.ts's HeroImagePick.dominantColor)
   *  for the fallback gradient — null/omitted falls back to the flat
   *  --color-dominant-fallback tone, same as DetailPoster. */
  dominantColor?: string | null;
  /** Bottom-anchored overlay content (series' eyebrow + title sit directly
   *  in the banner; movie's content is pulled up below it instead — see
   *  MovieDetailScreen/SeriesDetailScreen). */
  overlay?: ReactNode;
  /** Default true — see the module header's L7 scanlines-preference seam. */
  scanlines?: boolean;
}

export function SceneBanner({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  backdropKind,
  desktopHeight,
  title,
  dominantColor,
  overlay,
  scanlines = true,
}: SceneBannerProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: backdropKind, width: 1280 });
  const initial = (title ?? "").trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className={styles.banner}
      style={{ "--banner-height": `${desktopHeight}px`, "--banner-glow": dominantColor ?? undefined } as React.CSSProperties}
      data-fallback={failed}
    >
      {failed ? (
        <span className={styles.initial} aria-hidden="true">
          {initial}
        </span>
      ) : (
        <img className={styles.backdrop} src={src} alt="" aria-hidden="true" onError={() => setFailed(true)} />
      )}
      <div className={styles.scanlines} data-scanlines={scanlines ? "on" : "off"} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />
      <a href="/browse" className={styles.backPill}>
        ← LIBRARY
      </a>
      {overlay && <div className={styles.overlay}>{overlay}</div>}
    </div>
  );
}
