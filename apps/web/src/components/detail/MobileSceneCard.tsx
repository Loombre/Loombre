// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/MobileSceneCard.tsx
//
// Mobile Movie/Series-detail hero (design/phosphor/README.md's mobile
// prototype: a 196px rounded scene card with the title + a mono meta line
// bottom-anchored over a scrim — genuinely different from the desktop
// SceneBanner arrangement, not a squished reflow of it, per that
// component's own header). No back pill here: the mobile shell's
// MobileHeader already renders a contextual back chevron (Wave 1 W1a),
// so this card doesn't duplicate it.
//
// Missing-artwork fallback (S5, Phosphor W3 fidelity-audit finding): same
// onError-flip pattern as DetailPoster.tsx/SceneBanner.tsx (reuse, don't
// invent) — the <img> is removed from the tree on error and an oversized
// translucent initial (this card's own `title` prop — already real and
// wired by both callers, unlike SceneBanner's newly-added same-named
// prop) renders over a per-item-hue gradient (`dominantColor` ->
// --card-glow, optional: both current callers predate this prop and are
// outside this fix lane's file grant, so it defaults to the flat
// --color-dominant-fallback tone until a future pass threads the real
// hero.dominantColor through — logged in the freeze report). No separate
// fallback title text is drawn: `.text .title` already renders the real
// title on top of every state (loaded, loading, and failed) via the
// existing scrim, so drawing it a second time on the art layer itself
// would duplicate it.

import { useState } from "react";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./MobileSceneCard.module.css";

export interface MobileSceneCardProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  backdropKind: string;
  title: string;
  metaLine: string;
  /** Real per-item hue (lib/pick-hero-image.ts's HeroImagePick.
   *  dominantColor) for the missing-artwork fallback gradient — optional,
   *  see this file's header; null/omitted falls back to the flat
   *  --color-dominant-fallback tone. */
  dominantColor?: string | null;
}

export function MobileSceneCard({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  backdropKind,
  title,
  metaLine,
  dominantColor,
}: MobileSceneCardProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: backdropKind, width: 720 });
  const initial = title.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className={styles.card} style={{ "--card-glow": dominantColor ?? undefined } as React.CSSProperties} data-fallback={failed}>
      {failed ? (
        <span className={styles.initial} aria-hidden="true">
          {initial}
        </span>
      ) : (
        <img className={styles.backdrop} src={src} alt="" aria-hidden="true" onError={() => setFailed(true)} />
      )}
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        <div className={styles.meta}>{metaLine}</div>
      </div>
    </div>
  );
}
