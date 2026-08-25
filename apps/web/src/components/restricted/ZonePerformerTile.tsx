// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZonePerformerTile.tsx
//
// STATE.md Stash run (S9 zone home rails, Lane E) — the performers rail's
// own tile, a fixed-width rail form of app/restricted/performers/page.tsx's
// own grid card. FX2 fix wave: RestrictedPerformer now carries an `images`
// field (mirrors RestrictedStudio's own — B ingests performer portraits,
// entity_type='person', kind='thumb'), so this renders the portrait exactly
// like ZoneStudioTile.tsx renders a logo, falling back to the existing
// Avatar initials when the performer has no portrait fixture.

import Link from "next/link";
import { Avatar } from "../ui/Card.js";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./ZonePerformerTile.module.css";

export interface ZonePerformerTileProps {
  serverUrl: string;
  accessToken: string;
  performerId: string;
  name: string;
  sceneCount: number;
  hasPortrait: boolean;
  href: string;
}

export function ZonePerformerTile({
  serverUrl,
  accessToken,
  performerId,
  name,
  sceneCount,
  hasPortrait,
  href,
}: ZonePerformerTileProps): React.JSX.Element {
  return (
    // next/link, never a raw <a href> — same zone re-lock mechanism as
    // ZoneStudioTile.tsx's own note (QA C/zone-sibling-tiles).
    <Link href={href} className={styles.tile}>
      {hasPortrait ? (
        <img
          className={styles.portrait}
          src={buildImageUrl({ serverUrl, accessToken, entityType: "person", entityId: performerId, kind: "thumb", width: 192 })}
          alt=""
          width={96}
          height={96}
          loading="lazy"
        />
      ) : (
        <Avatar label={name} size={96} />
      )}
      <span className={styles.name}>{name}</span>
      <span className={styles.count}>
        {sceneCount} {sceneCount === 1 ? "scene" : "scenes"}
      </span>
    </Link>
  );
}
