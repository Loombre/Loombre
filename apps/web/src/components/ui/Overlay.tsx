// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import styles from "./Overlay.module.css";

export function DialogDemo({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.scrim} style={{ position: "relative", inset: "auto", height: 260 }}>
      <div className={styles.dialog} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function PopoverDemo({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.popover} role="dialog">
      {children}
    </div>
  );
}

export function MenuDemo({ items }: { items: string[] }): React.JSX.Element {
  return (
    <div className={styles.menu} role="menu">
      {items.map((item) => (
        <button key={item} type="button" role="menuitem" className={styles.menuItem}>
          {item}
        </button>
      ))}
    </div>
  );
}
