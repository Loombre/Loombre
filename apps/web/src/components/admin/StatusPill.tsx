// SPDX-License-Identifier: AGPL-3.0-only
import type { PillTone } from "../../lib/admin-status.js";
import styles from "./StatusPill.module.css";

export function StatusPill({ label, tone }: { label: string; tone: PillTone }): React.JSX.Element {
  return (
    <span className={styles.pill} data-tone={tone}>
      {label}
    </span>
  );
}
