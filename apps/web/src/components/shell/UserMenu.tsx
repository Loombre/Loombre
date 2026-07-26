// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, LogOut } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { Avatar } from "../ui/Card.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import styles from "./AppShell.module.css";
import menuStyles from "../ui/Overlay.module.css";

// Wave 2 (lane L8), ground-truthed against MobileHeader.tsx's own header
// comment: the README's "account sheet" ("an avatar that opens the
// account sheet [...] plus a Restricted zone row in the account sheet")
// does NOT exist yet — this dropdown IS today's stopgap avatar affordance
// on both breakpoints (MobileHeader re-docks this exact component). The
// brief's fallback applies: "if it's still the reused UserMenu dropdown,
// add the row there and log" — logged here and in the freeze report.
// Entry hidden entirely for a viewer with no restricted-library
// entitlement (hasRestrictedZoneEntitlement — the same predicate the
// sidebar/Browse-chip/mobile-tab gate on), never a dead/disabled row.
export function UserMenu({ username }: { username: string | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const { count: restrictedCount } = useRestrictedZoneCount();

  useEffect(() => {
    function onClickOutside(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleLogout(): Promise<void> {
    await getAuthStore().logout();
    router.replace("/login");
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => setOpen((v) => !v)}
        aria-label="User menu"
        aria-expanded={open}
      >
        <Avatar label={username ?? "?"} size={32} />
      </button>
      {open && (
        <div
          className={menuStyles.menu}
          role="menu"
          style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 50 }}
        >
          <div style={{ padding: "var(--space-xs) var(--space-sm)", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
            {username ?? "Signed in"}
          </div>
          {hasRestrictedZoneEntitlement(restrictedCount) && (
            <button
              type="button"
              role="menuitem"
              className={menuStyles.menuItem}
              onClick={() => {
                setOpen(false);
                router.push("/restricted");
              }}
            >
              <Icon icon="lock" size="dense" />
              Restricted zone
            </button>
          )}
          {/* Mobile has no dedicated Watchlist tab (README's 6-tab bar is
              Home/Movies/TV/Search/Restricted/Settings) and no real account
              sheet yet (this component's own header) — this is mobile's
              ONLY path to /watchlist until the account sheet lands. Harmless
              redundancy on desktop, which already has the sidebar entry
              (same posture the Wave-0/W1a "Settings" duplication already
              established: capability-preserving beats de-duplicating). */}
          <button
            type="button"
            role="menuitem"
            className={menuStyles.menuItem}
            onClick={() => {
              setOpen(false);
              router.push("/watchlist");
            }}
          >
            <Icon icon={Bookmark} size="dense" />
            Watchlist
          </button>
          <button type="button" role="menuitem" className={menuStyles.menuItem} onClick={handleLogout}>
            <Icon icon={LogOut} size="dense" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
