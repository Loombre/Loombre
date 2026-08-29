// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/advanced/SectionSwitcher.tsx
//
// UIFIX-2026-08-29 Lane K, UD-2 (advanced-only): Settings › Advanced is the
// ONE section that folds the tab column into its own page title. The other
// nine sections keep SettingsTabs untouched — this component is not a
// replacement for it, it is this page's local navigation because the
// workbench needs the full width for three panes.
//
// Sections come from components/settings/section-registry.ts, never from a
// transcription. D-5 anomaly A3: the prototype's own SECTIONS array is
// wrong three ways — 8 entries instead of 10 (omits server/mail/about,
// invents a "restricted" section), two hrefs that do not resolve
// (/settings/restricted, /settings/remote), and two drifted labels
// ("Advanced" for "Advanced Server", "Remote access" for "Remote Access").
//
// Dismissal (the prototype had all three; this adds the ARIA it lacked):
// picking an item, a pointerdown outside the menu, and Escape. `pointerdown`
// rather than the prototype's `mousedown` so a touch tap outside closes it
// too.

import { useEffect, useId, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { SETTINGS_SECTIONS, type SettingsSectionKey } from "../section-registry.js";
import styles from "./SectionSwitcher.module.css";

export interface SectionSwitcherProps {
  current: SettingsSectionKey;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Rendered under the title row — the page's one-line purpose statement. */
  subtitle: ReactNode;
}

export function SectionSwitcher({ current, open, onToggle, onClose, subtitle }: SectionSwitcherProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const label = SETTINGS_SECTIONS.find((s) => s.key === current)?.label ?? "Settings";
  // Read through a ref so the effect depends on `open` alone — onClose is an
  // inline arrow at the call site, and depending on it would tear down and
  // re-attach both document listeners on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event): void => {
      const node = menuRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header className={styles.header}>
      <div className={styles.titleColumn}>
        <div className={styles.crumbRow}>
          <Link className={styles.backLink} href="/settings">
            <span className={styles.backGlyph} aria-hidden="true">
              ←
            </span>
            All settings
          </Link>
          <span className={styles.separator} aria-hidden="true">
            /
          </span>
          <div className={styles.menuAnchor} ref={menuRef}>
            <h1 className={styles.title}>
              <button
                type="button"
                className={styles.titleButton}
                aria-expanded={open}
                aria-haspopup="menu"
                aria-controls={menuId}
                onClick={onToggle}
              >
                <span className={styles.titleText}>{label}</span>
                {/* A11: decorative — the accessible name must stay the
                    section label, not "Advanced Server ⌄". */}
                <span className={styles.chevron} data-open={open} aria-hidden="true">
                  <Icon icon={ChevronDown} size="dense" strokeWidth={1.55} aria-hidden />
                </span>
              </button>
            </h1>
            {open && (
              <div className={styles.menu} role="menu" id={menuId} aria-label="Settings sections">
                {SETTINGS_SECTIONS.map((section) => {
                  const isCurrent = section.key === current;
                  return (
                    <Link
                      key={section.key}
                      role="menuitem"
                      className={styles.menuItem}
                      data-current={isCurrent}
                      href={section.href}
                      aria-current={isCurrent ? "page" : undefined}
                      onClick={onClose}
                    >
                      <span className={styles.menuLabel}>{section.label}</span>
                      {isCurrent && (
                        <span className={styles.hereBadge} aria-hidden="true">
                          Here
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
    </header>
  );
}
