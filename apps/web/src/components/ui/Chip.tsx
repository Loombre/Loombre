// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import styles from "./Chip.module.css";

export function Chip({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.chip}>{children}</span>;
}

export function Tag({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.tag}>{children}</span>;
}

export function Badge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.badge}>{children}</span>;
}
