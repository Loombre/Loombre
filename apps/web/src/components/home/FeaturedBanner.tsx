// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/home/FeaturedBanner.tsx
//
// design/phosphor/README.md §Screens -> Home's rotating Featured banner,
// both breakpoints as ONE component tree (U2) — CSS media queries (see
// FeaturedBanner.module.css) reflow the SAME markup between the desktop
// form (vertical flex: a 30px header row holding the dot/arrow cluster
// right-aligned, then a flex:1 body row of poster + text column) and the
// mobile form (fixed 232px, dots absolute top-right, text absolutely
// bottom-anchored over a scrim, poster hidden, no arrows, no separate
// Details pill — README §Mobile lists Play + watchlist pills only).
//
// Three geometry lessons the README calls "expensive" (three prototype
// rounds to get right) and how each is honored here:
//   1. Row, not column, separation between the controls and the text:
//      .headerRow (dots/arrows) and .bodyRow (poster/text) are SIBLING
//      flex children of the outer vertical flex column — never a grid
//      column reserved for controls — so collision between a long title
//      and the control cluster is geometrically impossible.
//   2. `min-height` (never `height`) on the banner, `-webkit-line-clamp:2`
//      + `overflow-wrap:anywhere` on the title (bounds growth at ~282px
//      instead of the banner clipping a 4-line-wrapped title), and
//      `white-space:nowrap` on the three pills (their labels can't wrap
//      inside the pill).
//   3. The exclusion set is a real query constraint (see lib/featured-
//      pool.ts), not a preference ordering — `pool` here is ALREADY the
//      post-exclusion, capped-at-5 result; this component doesn't re-
//      filter or re-order it.
//
// Rotation (dwell/crossfade/pause) is entirely owned by
// useFeaturedRotation.ts + lib/featured-rotation.ts — this component only
// renders whatever snapshot it hands back. Crossfade technique: the
// CURRENT candidate's art/content layer sits at constant opacity:1
// underneath; the PREVIOUS candidate's layer sits ON TOP at an opacity
// that transitions 1->0 (CSS `transition: opacity`, compositor-only), so
// the fade reveals the new content that's already fully painted beneath
// it — no ping-pong bookkeeping needed, and it degrades to an instant
// swap for free under reduced-motion (the scheduler never sets
// `crossfading` true in that case, so the "previous" layer is never
// visible at all).

import { useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { candidatePosterImage, candidateSceneImage, type FeaturedCandidate } from "../../lib/featured-fields.js";
import { useFeaturedRotation } from "./useFeaturedRotation.js";
import { WatchlistToggle } from "../detail/WatchlistToggle.js";
import styles from "./FeaturedBanner.module.css";

export interface FeaturedBannerProps {
  /** Already post-exclusion, already capped at 5 (lib/featured-pool.ts) —
   *  this component renders it as-is. */
  pool: FeaturedCandidate[];
  serverUrl: string;
  accessToken: string;
  /** Scanlines-overlay hook for a future accent/scanlines preference (U7,
   *  Wave 2 lane L7) — default on, per the README ("opacity toggled by a
   *  `scanlines` boolean prop (default on)"). This lane doesn't build the
   *  preference UI; it just makes the class conditional on a prop so L7
   *  can wire one in without touching this component's structure. */
  scanlinesEnabled?: boolean;
}

function SceneArt({
  candidate,
  serverUrl,
  accessToken,
}: {
  candidate: FeaturedCandidate;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  const image = candidateSceneImage(candidate.images);
  if (!image) {
    // Missing-artwork fallback ONLY (README "Assets": "a cool oklch-style
    // gradient... keep the gradient as the missing-artwork fallback" — same
    // convention already established at app/styleguide/page.module.css's
    // .demoTileGradient). Ground-truthed against the prototype: the
    // oversized initial-letter treatment decorates POSTER-shaped tiles
    // only (every `{{ x.initial }}` binding in the bundle sits on a
    // poster/album tile, never on a full-bleed scene/backdrop) — the
    // banner's own poster (PosterArt below) gets one; this full-bleed
    // scene layer is gradient-only, same as AmbientHero/AmbientBackdrop's
    // existing no-letter backdrop fallback elsewhere in this app.
    return <div className={styles.sceneFallback} />;
  }
  const src = buildImageUrl({ serverUrl, accessToken, entityType: candidate.itemType, entityId: candidate.id, kind: image.kind, width: 1280 });
  // Full-bleed hero art, above the fold — plain <img>, no blurhash LQIP
  // sub-crossfade and no lazy-loading, matching the existing
  // AmbientHero/AmbientBackdrop convention for hero-sized artwork
  // (blurhash LQIP is reserved for poster GRIDS elsewhere in this app).
  return <img className={styles.sceneImage} src={src} alt="" aria-hidden="true" />;
}

function PosterArt({
  candidate,
  serverUrl,
  accessToken,
}: {
  candidate: FeaturedCandidate;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const image = candidatePosterImage(candidate.images);
  if (!image) {
    return (
      <div className={styles.posterFallback}>
        <span className={styles.posterInitial} aria-hidden="true">
          {candidate.initial}
        </span>
      </div>
    );
  }
  const src = buildImageUrl({ serverUrl, accessToken, entityType: candidate.itemType, entityId: candidate.id, kind: "poster", width: 320 });
  const placeholderUri = image.blurhash ? blurhashToDataUri(image.blurhash) : null;
  // Blurhash LQIP crossfade, same recipe as PosterCard.tsx elsewhere in
  // this app (poster-sized art, unlike the full-bleed scene art above).
  return (
    <div className={styles.posterArt}>
      {placeholderUri && <img className={styles.posterPlaceholder} data-loaded={loaded} src={placeholderUri} alt="" aria-hidden="true" />}
      <img className={styles.posterImage} data-loaded={loaded} src={src} alt="" aria-hidden="true" onLoad={() => setLoaded(true)} />
    </div>
  );
}

function BannerBody({
  candidate,
  serverUrl,
  accessToken,
}: {
  candidate: FeaturedCandidate;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  return (
    <>
      <div className={styles.poster}>
        <PosterArt candidate={candidate} serverUrl={serverUrl} accessToken={accessToken} />
      </div>
      <div className={styles.textColumn}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          <span className={styles.eyebrowText}>FEATURED · {candidate.tag}</span>
        </div>
        {/* next/link for all three of this banner's links (QA d3-c3): the
            Play pill's href is `candidate.playHref` — a /watch entry built in
            lib/featured-fields.ts — so a raw <a> made it a FULL document
            navigation, which is what browser-items-F1 is about (the /watch
            audio handoff and the route's own unmount path both need the
            document to survive). The title/Details links are the same defect
            class one hop later: a full reload of an app already loaded. */}
        <Link href={candidate.href} className={styles.title}>
          {candidate.title}
        </Link>
        {candidate.specLine && <div className={styles.specLine}>{candidate.specLine}</div>}
        {candidate.blurb && <p className={styles.blurb}>{candidate.blurb}</p>}
        <div className={styles.pillRow}>
          <Link href={candidate.playHref} className={styles.pillPrimary}>
            <Icon icon={Play} size="dense" aria-hidden />
            Play
          </Link>
          {/* Desktop only (CSS-hidden on mobile — README §Mobile lists Play
              + watchlist pills only for the vertical form); the title link
              above is the mobile form's "open detail" affordance. */}
          <Link href={candidate.href} className={styles.pillSecondary}>
            Details
          </Link>
          {/* L3's real watchlist toggle in L9's reserved slot (Wave-2
              landing reconciliation). It ships its own pill styling in its
              own CSS module; this module styles only the Play/Details
              pills. */}
          <WatchlistToggle itemId={candidate.id} />
        </div>
      </div>
    </>
  );
}

export function FeaturedBanner({ pool, serverUrl, accessToken, scanlinesEnabled = true }: FeaturedBannerProps): React.JSX.Element | null {
  const rotation = useFeaturedRotation(pool.length);
  const dotRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (pool.length === 0) return null;

  const activeCandidate = pool[rotation.activeIndex];
  const previousCandidate = rotation.previousIndex !== null ? pool[rotation.previousIndex] : null;
  if (!activeCandidate) return null;

  // Item 1 (Wave A, radiogroup sweep): arrow keys move focus AND
  // selection together, Home/End jump to the ends — same WAI-ARIA APG
  // Radio Group pattern as ui/SegmentedControl.tsx, applied directly here
  // since these are icon-only carousel indicator dots.
  function focusAndJump(index: number): void {
    if (index < 0 || index >= pool.length) return;
    dotRefs.current[index]?.focus();
    rotation.jumpTo(index);
  }

  function handleDotKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        focusAndJump((index + 1) % pool.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        focusAndJump((index - 1 + pool.length) % pool.length);
        break;
      case "Home":
        event.preventDefault();
        focusAndJump(0);
        break;
      case "End":
        event.preventDefault();
        focusAndJump(pool.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <section
      className={styles.banner}
      data-scanlines={scanlinesEnabled}
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => rotation.setHovering(true)}
      onMouseLeave={() => rotation.setHovering(false)}
    >
      <div className={styles.artStack} aria-hidden="true">
        <div className={styles.artLayer} key={activeCandidate.id}>
          <SceneArt candidate={activeCandidate} serverUrl={serverUrl} accessToken={accessToken} />
        </div>
        {previousCandidate && (
          <div className={styles.artLayer} data-visible={rotation.crossfading} key={previousCandidate.id}>
            <SceneArt candidate={previousCandidate} serverUrl={serverUrl} accessToken={accessToken} />
          </div>
        )}
      </div>
      <div className={styles.scanlinesLayer} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />

      <div className={styles.headerRow}>
        {rotation.controlClusterVisible && (
          <>
            <div className={styles.dots} role="radiogroup" aria-label="Featured titles">
              {pool.map((candidate, index) => (
                <button
                  key={candidate.id}
                  ref={(el) => {
                    dotRefs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={index === rotation.activeIndex}
                  aria-label={`Show featured title: ${candidate.title}`}
                  data-active={index === rotation.activeIndex}
                  tabIndex={index === rotation.activeIndex ? 0 : -1}
                  className={styles.dot}
                  onClick={() => rotation.jumpTo(index)}
                  onKeyDown={(event) => handleDotKeyDown(event, index)}
                />
              ))}
            </div>
            <div className={styles.arrows}>
              <button type="button" className={styles.arrowButton} aria-label="Previous featured title" onClick={rotation.prev}>
                <Icon icon={ChevronLeft} size="dense" strokeWidth={2.2} aria-hidden />
              </button>
              <button type="button" className={styles.arrowButton} aria-label="Next featured title" onClick={rotation.next}>
                <Icon icon={ChevronRight} size="dense" strokeWidth={2.2} aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>

      <div className={styles.bodyRow}>
        <div className={styles.contentStack}>
          <div className={styles.contentLayer}>
            <BannerBody candidate={activeCandidate} serverUrl={serverUrl} accessToken={accessToken} />
          </div>
          {previousCandidate && (
            <div className={styles.contentLayer} data-visible={rotation.crossfading} key={previousCandidate.id}>
              <BannerBody candidate={previousCandidate} serverUrl={serverUrl} accessToken={accessToken} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
