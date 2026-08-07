// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, LogOut, User } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { Avatar } from "../ui/Card.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import styles from "./UserMenu.module.css";
import shellStyles from "./AppShell.module.css";

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
//
// W11 (Wave 2, this run — IA restructure): restyled to its own Phosphor
// surface (UserMenu.module.css — see that file's header for the elevated-
// surface + hover-pill treatment), gained a "Profile settings" row (D-6:
// the user-scoped settings this avatar menu is now the ONE way every
// user, admin or not, reaches — components/profile/ProfileSettings.tsx at
// /profile), and gained real roving-focus keyboard navigation
// (ArrowUp/ArrowDown/Home/End move focus among items; Escape closes and
// returns focus to the trigger) on top of the existing click-outside-to-
// close and `role="menu"`/`role="menuitem"` semantics.
export function UserMenu({ username }: { username: string | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Which end of the item list to focus once the menu finishes opening —
   *  set by the trigger's own ArrowUp/ArrowDown handler below, consumed
   *  (and reset) by the open-effect right after. Plain click/Enter/Space
   *  opens leave this null, which the effect treats as "first item" — the
   *  conventional default for a freshly opened menu. */
  const focusEndOnOpen = useRef<"first" | "last" | null>(null);
  const { count: restrictedCount } = useRestrictedZoneCount();

  useEffect(() => {
    function onClickOutside(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Moves real DOM focus onto a menu item the instant the menu mounts —
  // this is what makes opening via ArrowDown/ArrowUp keyboard-operable
  // (WAI-ARIA menu-button pattern: opening the menu focuses an item, not
  // the menu container itself).
  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    const target = focusEndOnOpen.current === "last" ? items[items.length - 1] : items[0];
    focusEndOnOpen.current = null;
    target?.focus();
  }, [open]);

  function menuItems(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusEndOnOpen.current = event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const items = menuItems();
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        items[(currentIndex + 1 + items.length) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[(currentIndex - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        // W3-R (opus review, MEDIUM): closing the menu here unmounts the
        // currently focused menuitem — if that happens without first
        // moving focus somewhere else, focus falls back to <body> and the
        // browser's own default Tab action (which computes "next
        // focusable" from whatever's currently focused) starts from
        // scratch instead of continuing naturally past this control. Fix:
        // synchronously refocus the trigger first (same refocus the
        // Escape case below already does), then let Tab's default action
        // run un-prevented — the browser now advances from the trigger to
        // the next element in document order, exactly like a native menu
        // closing on Tab.
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  }

  async function handleLogout(): Promise<void> {
    await getAuthStore().logout();
    router.replace("/login");
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className={shellStyles.iconButton}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar label={username ?? "?"} size={32} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label="User menu"
          onKeyDown={onMenuKeyDown}
          style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 50 }}
        >
          <div className={styles.header}>
            <span className={styles.headerName}>{username ?? "Signed in"}</span>
          </div>

          {hasRestrictedZoneEntitlement(restrictedCount) && (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                router.push("/restricted");
              }}
            >
              <Icon icon="lock" size="dense" />
              Restricted zone
            </button>
          )}

          {/* D-6: the ONE place every user, admin or not, reaches their own
              Profile/Password/Playback/Restricted-opt-in settings now — see
              this file's header and app/profile/page.tsx. */}
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              router.push("/profile");
            }}
          >
            <Icon icon={User} size="dense" />
            Profile settings
          </button>

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
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              router.push("/watchlist");
            }}
          >
            <Icon icon={Bookmark} size="dense" />
            Watchlist
          </button>

          <hr className={styles.divider} />

          <button
            type="button"
            role="menuitem"
            className={[styles.menuItem, styles.menuItemDanger].join(" ")}
            onClick={handleLogout}
          >
            <Icon icon={LogOut} size="dense" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
