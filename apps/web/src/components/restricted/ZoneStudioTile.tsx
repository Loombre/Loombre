// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneStudioTile.tsx
//
// STATE.md Stash run (S9 zone home rails, Lane E) — the studios rail's own
// tile, a fixed-width rail form of app/restricted/studios/page.tsx's own
// grid card (same logo/Avatar-fallback/name/count vocabulary + amber
// hover-border law, S6/K2), extracted here since it's now used in TWO
// places (that grid stays inline — this file is additive, not a refactor
// of it) and Row.tsx's `.scroller` needs a fixed-width child, not a grid
// item.

import { Avatar } from "../ui/Card.js";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./ZoneStudioTile.module.css";

export interface ZoneStudioTileProps {
  serverUrl: string;
  accessToken: string;
  studioId: string;
  name: string;
  sceneCount: number;
  hasLogo: boolean;
  href: string;
}

export function ZoneStudioTile({
  serverUrl,
  accessToken,
  studioId,
  name,
  sceneCount,
  hasLogo,
  href,
}: ZoneStudioTileProps): React.JSX.Element {
  return (
    <a href={href} className={styles.tile}>
      {hasLogo ? (
        <img
          className={styles.logo}
          src={buildImageUrl({ serverUrl, accessToken, entityType: "tag", entityId: studioId, kind: "logo", width: 192 })}
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
    </a>
  );
}
