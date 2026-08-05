// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/ComparisonTable.tsx
//
// R8's "honest comparison card" — renders packages/shared/src/remote/
// comparison.ts's PATH_COMPARISON, the single source of this content (see
// that file's header: the ops docs' remote-access landing page reads the
// SAME module, so this component owns presentation only, never copy).

import { comparisonRows } from "@loombre/shared/remote";
import { ALL_PATH_IDS, PATH_LABELS } from "./path-labels.js";
import type { PathId } from "@loombre/shared/remote";
import styles from "./ComparisonTable.module.css";

export function ComparisonTable({ highlight }: { highlight?: PathId }): React.JSX.Element {
  const rows = comparisonRows();

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.axisHeader} />
            {ALL_PATH_IDS.map((path) => (
              <th key={path} scope="col" className={styles.pathHeader} data-highlight={path === highlight}>
                {PATH_LABELS[path]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.axis}>
              <th scope="row" className={styles.axisHeader}>
                {row.label}
              </th>
              {ALL_PATH_IDS.map((path) => (
                <td key={path} data-highlight={path === highlight}>
                  {row.values[path]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
