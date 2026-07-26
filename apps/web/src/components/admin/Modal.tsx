// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/Modal.tsx
//
// Minimal real dialog (open/close state, Escape-to-close, scrim click-to-
// close) built on the SAME glass scrim/dialog recipe
// components/ui/Overlay.module.css already defines for the styleguide
// demos — this is the first LIVE consumer of that CSS, reused rather than
// re-declared.

import { useEffect, type ReactNode } from "react";
import overlayStyles from "../ui/Overlay.module.css";
import styles from "./Modal.module.css";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className={overlayStyles.scrim}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${overlayStyles.dialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
