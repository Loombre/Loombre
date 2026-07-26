// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/AmbientHero.tsx
//
// P2.11 "wow factor" ambient depth for item detail pages: backdrop heavily
// blurred/darkened behind a glass content panel tinted with the item's
// dominant_color (P2.20 pairing). Falls back to the neutral-warm token
// (--color-dominant-fallback) when no dominantColor was computed yet.

"use client";

import type { CSSProperties, ReactNode } from "react";
import { buildImageUrl } from "../../lib/image-url.js";
import { posterTransitionName } from "../../lib/view-transition.js";
import styles from "./AmbientHero.module.css";

type CSSVars = CSSProperties & Record<string, string | number | undefined>;

export interface AmbientHeroProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  /** "backdrop" when the item has one; falls back through poster/thumb/
   *  disc/logo (whichever kind actually exists — see the route's
   *  pickHeroImage) so there's always something to blur, on-brand even
   *  without dedicated backdrop art. */
  backdropKind: string;
  dominantColor: string | null;
  title: string;
  children: ReactNode;
}

export function AmbientHero({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  backdropKind,
  dominantColor,
  title,
  children,
}: AmbientHeroProps): React.JSX.Element {
  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: backdropKind, width: 1280 });
  const heroStyle: CSSVars = { "--hero-glow": dominantColor ?? undefined };
  const backdropStyle: CSSVars =
    backdropKind === "poster" ? { viewTransitionName: posterTransitionName(entityId) } : {};

  return (
    <div className={styles.hero} style={heroStyle}>
      <img className={styles.backdrop} src={src} alt="" aria-hidden="true" style={backdropStyle} />
      <div className={styles.scanlines} aria-hidden="true" />
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.content}>
        <h1 className={styles.title}>{title}</h1>
        {children}
      </div>
    </div>
  );
}
