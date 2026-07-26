// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/SortControl.tsx
//
// The gap-closure lane added sort/order params to the list endpoints
// (packages/contract/openapi.yaml's listMovies/listSeries/listArtists etc.
// now take `sort?: "title"|"added"|"rating"|"year"` + `order?: "asc"|"desc"`,
// SDK regenerated) — all three pills below are now real, wired into
// app/browse/page.tsx's query construction via SORT_PARAMS. Order is left
// to the contract's per-sort default (title: asc; added/rating: desc) since
// this control has no direction toggle; a cursor from one sort+order pair
// is only valid under that SAME pair, which is exactly why changing `sort`
// must reset the cursor feed (see BrowseContent's `resetKey`).

"use client";

import type { components } from "@loombre/sdk";
import styles from "./SortControl.module.css";

export const SORT_OPTIONS = [
  { value: "recently-added", label: "Recently Added" },
  { value: "title", label: "Title A–Z" },
  { value: "rating", label: "Highest Rated" },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]["value"];

/** Maps this control's UI values to the contract's `sort` parameter — order
 *  is omitted so each sort takes the contract's documented default. */
export const SORT_PARAMS: Record<SortValue, components["parameters"]["Sort"]> = {
  "recently-added": "added",
  title: "title",
  rating: "rating",
};

export function SortControl({
  active,
  onChange,
}: {
  active: SortValue;
  onChange: (value: SortValue) => void;
}): React.JSX.Element {
  return (
    <div className={styles.track} role="tablist" aria-label="Sort">
      {SORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === active}
          data-active={option.value === active}
          className={styles.segment}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
