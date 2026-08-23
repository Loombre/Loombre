// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/RowMenu.tsx
//
// The "⋯" row-action menu design/phosphor/README.md's Users & Profiles and
// Libraries rows both call for. Same click-outside-to-close shape as
// components/shell/UserMenu.tsx (this codebase's existing convention for a
// small popover menu — copied rather than imported since UserMenu is
// shell-specific and takes no children/actions), composed on the same
// Overlay.module.css `.menu`/`.menuItem` recipe.

import { useEffect, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { useEscapeKey } from "../ui/overlay-hooks.js";
import menuStyles from "../ui/Overlay.module.css";
import styles from "./RowMenu.module.css";

export interface RowMenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function RowMenu({ actions, label }: { actions: RowMenuAction[]; label: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEscapeKey(open, () => setOpen(false));

  return (
    <div ref={ref} className={styles.wrap}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((v) => !v)} aria-label={label} aria-expanded={open}>
        <Icon icon={MoreVertical} size="dense" />
      </button>
      {open && (
        <div className={menuStyles.menu} role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 50 }}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={[menuStyles.menuItem, action.danger ? styles.danger : ""].filter(Boolean).join(" ")}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
