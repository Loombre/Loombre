// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/browse/SearchSeriesRow.tsx
//
// Phosphor H5 search retheme (design/phosphor/dc:328-339, "SERIES"): wide
// 88x50 thumb rows + chevron, stacked vertically. Ground truth for the
// meta line: the prototype fixture shows "{{ s.meta }} · {{ s.status }}"
// where `s.meta` is a fixture-baked "years · N seasons" string — Series
// (packages/contract/openapi.yaml) has a real `year` (single, no end-year
// field — same honest substitution Wave-2 lane L9 already made for the
// Home featured banner's series spec line) but NO season-count field on
// the list/search item shape (that requires a separate per-series
// GET /series/{id}/seasons call — L9's header calls this out as the one
// exception it fetches, bounded to ≤5 pool items; doing it per SEARCH
// RESULT here has no such bound and would turn every keystroke's debounced
// fetch into an N+1 storm, which is exactly what the prototype's own
// "RESULTS AS YOU TYPE" promise argues against). So this shows real
// year + real status only, season count omitted.

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import styles from "./SearchSeriesRow.module.css";

type SearchResult = components["schemas"]["SearchResult"];
type Series = components["schemas"]["Series"];

const STATUS_LABEL: Record<NonNullable<Series["status"]>, string> = {
  continuing: "Continuing",
  ended: "Ended",
  cancelled: "Cancelled",
};

function metaFor(series: Series): string {
  const parts = [series.year ? String(series.year) : null, series.status ? STATUS_LABEL[series.status] : null].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join(" · ");
}

export function SearchSeriesRow({
  results,
  serverUrl,
  accessToken,
  activeId,
}: {
  results: SearchResult[];
  serverUrl: string;
  accessToken: string;
  activeId?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={styles.list} role="list">
      {results.map((result) => {
        const series = result.item as Series;
        const posterImage = series.images?.find((img) => img.kind === "poster");
        const placeholderUri = posterImage?.blurhash ? blurhashToDataUri(posterImage.blurhash) : null;
        const src = buildImageUrl({ serverUrl, accessToken, entityType: "series", entityId: series.id, kind: "poster", width: 176 });
        return (
          <Link
            key={series.id}
            href={`/items/series/${series.id}`}
            className={styles.row}
            role="listitem"
            data-search-id={series.id}
            data-search-active={series.id === activeId}
          >
            <span className={styles.thumb}>
              {placeholderUri && <img className={styles.thumbPlaceholder} src={placeholderUri} alt="" aria-hidden="true" />}
              <img className={styles.thumbImage} src={src} alt="" loading="lazy" />
            </span>
            <span className={styles.info}>
              <span className={styles.title}>{series.title}</span>
              <span className={styles.meta}>{metaFor(series)}</span>
            </span>
            <Icon icon={ChevronRight} size="dense" className={styles.chevron ?? ""} />
          </Link>
        );
      })}
    </div>
  );
}
