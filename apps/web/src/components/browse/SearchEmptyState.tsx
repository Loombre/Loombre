// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/browse/SearchEmptyState.tsx
//
// Phosphor H5 search retheme (design/phosphor/dc:367-377): the empty-query
// state — RECENT pills (real, lib/recent-searches.ts — see that file's
// header for the "nothing existed, added it honestly" ground truth) + the
// 40px/900 ghost "SEARCH EVERYTHING" treatment. The RECENT row is omitted
// entirely (not rendered with an empty label) when there are no recent
// searches yet — a first-ever visit shouldn't show a "RECENT" heading over
// nothing.
//
// The prototype's subcopy line is "TITLES · EPISODES · PEOPLE · ALBUMS —
// RESULTS AS YOU TYPE, P95 ≤ 100MS". The first half is real (this app's
// search genuinely is debounced-as-you-type, SearchPanel.tsx); the
// "P95 ≤ 100MS" clause is a specific, unverifiable latency SLO with no
// measurement or enforcement anywhere in this codebase — shipping it as
// copy would present an invented number as a fact (U9), so it's cut,
// logged here rather than silently dropped.

import styles from "./SearchEmptyState.module.css";

export function SearchEmptyState({
  recentQueries,
  onSelectQuery,
}: {
  recentQueries: string[];
  onSelectQuery: (query: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.wrap}>
      {recentQueries.length > 0 && (
        <div className={styles.recentRow}>
          <span className={styles.recentLabel}>RECENT</span>
          {recentQueries.map((query) => (
            <button key={query} type="button" className={styles.pill} onClick={() => onSelectQuery(query)}>
              {query}
            </button>
          ))}
        </div>
      )}
      <div className={styles.ghostWrap}>
        <div className={styles.ghost}>Search Everything</div>
        <div className={styles.ghostSub}>TITLES · EPISODES · PEOPLE · ALBUMS — RESULTS AS YOU TYPE</div>
      </div>
    </div>
  );
}
