// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZonePerformerTile.tsx
//
// STATE.md Stash run (S9 zone home rails, Lane E) — the performers rail's
// own tile, a fixed-width rail form of app/restricted/performers/page.tsx's
// own grid card. Avatar-only (no image): RestrictedPerformer carries no
// `images` field in the contract — performer portraits are never exposed
// on this surface today (unlike RestrictedStudio's logo) — so this is
// honest to the available data, not a corner cut; ZoneStudioTile.tsx is
// the sibling component for the surface that DOES have real art.

import { Avatar } from "../ui/Card.js";
import styles from "./ZonePerformerTile.module.css";

export interface ZonePerformerTileProps {
  name: string;
  sceneCount: number;
  href: string;
}

export function ZonePerformerTile({ name, sceneCount, href }: ZonePerformerTileProps): React.JSX.Element {
  return (
    <a href={href} className={styles.tile}>
      <Avatar label={name} size={96} />
      <span className={styles.name}>{name}</span>
      <span className={styles.count}>
        {sceneCount} {sceneCount === 1 ? "scene" : "scenes"}
      </span>
    </a>
  );
}
