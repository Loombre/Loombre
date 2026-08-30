// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneWatchlistToggle.tsx
//
// RZI-D2a (run RZI-2026-08-30): the zone scene detail's watchlist toggle.
// Deliberately NOT detail/WatchlistToggle.tsx — that control reads
// membership from useWatchlistIds(), whose id map derives from the
// GENERAL-surface GET /watchlist and (by §6.4 surface scoping) never
// contains a restricted row, so it would always render "not watchlisted"
// here. Membership instead arrives on the scene detail itself
// (RestrictedScene.watchlisted) and lives as local state seeded from it;
// the PUT/DELETE /watchlist/{itemId} writes are the same item-addressed
// full-clearance ops the general toggle uses (RZI-D3). The rows this
// toggle creates render ONLY in the zone home's watchlistInZone rail.

import { useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { useToast } from "../ui/Toast.js";
import { apiDelete, apiPut } from "../../lib/api-client.js";
import styles from "./ZoneWatchlistToggle.module.css";

export interface ZoneWatchlistToggleProps {
  itemId: string;
  /** Membership at load, from RestrictedScene.watchlisted. */
  initialWatchlisted: boolean;
}

export function ZoneWatchlistToggle({ itemId, initialWatchlisted }: ZoneWatchlistToggleProps): React.JSX.Element {
  const { showToast } = useToast();
  const [watchlisted, setWatchlisted] = useState(initialWatchlisted);
  const [pending, setPending] = useState(false);

  async function handleClick(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      if (watchlisted) {
        await apiDelete("/watchlist/{itemId}", { params: { path: { itemId } } });
        setWatchlisted(false);
        showToast("REMOVED FROM WATCHLIST");
      } else {
        await apiPut("/watchlist/{itemId}", { params: { path: { itemId } } });
        setWatchlisted(true);
        showToast("ADDED TO WATCHLIST");
      }
    } catch {
      // Best-effort, same posture as detail/WatchlistToggle.tsx: a failed
      // request leaves the toggle in its previous state and a retry is a
      // plain second click.
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={styles.button}
      data-active={watchlisted}
      onClick={() => void handleClick()}
      disabled={pending}
      aria-pressed={watchlisted}
    >
      <Icon icon={watchlisted ? BookmarkCheck : Bookmark} size="dense" aria-hidden />
      {watchlisted ? "Watchlisted" : "Watchlist"}
    </button>
  );
}
