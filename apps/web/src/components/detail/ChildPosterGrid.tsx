// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/ChildPosterGrid.tsx
//
// Non-virtualized poster grid for a detail page's children (an artist's
// albums, say) — these are always small (tens, not tens of thousands), so
// VirtualPosterGrid's windowing would be pure overhead here; a plain
// flex-wrap of PosterCell reuses the same visual language without it.

"use client";

import { PosterCell } from "../browse/PosterCell.js";
import styles from "./ChildPosterGrid.module.css";

export interface ChildPosterItem {
  id: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
  entityType: string;
}

export function ChildPosterGrid({
  items,
  serverUrl,
  accessToken,
  emptyMessage,
}: {
  items: ChildPosterItem[];
  serverUrl: string;
  accessToken: string;
  emptyMessage: string;
}): React.JSX.Element {
  if (items.length === 0) return <div className={styles.empty}>{emptyMessage}</div>;
  return (
    <div className={styles.grid}>
      {items.map((item) => (
        <div key={item.id} className={styles.cell}>
          <PosterCell
            serverUrl={serverUrl}
            accessToken={accessToken}
            entityType={item.entityType}
            entityId={item.id}
            href={item.href}
            title={item.title}
            subtitle={item.subtitle}
            blurhash={item.blurhash}
            tabIndex={0}
            cellRef={() => {}}
            onFocus={() => {}}
          />
        </div>
      ))}
    </div>
  );
}
