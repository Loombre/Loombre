// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/WatchlistToggle.tsx
//
// Phosphor Wave 2 lane L3 — design/phosphor README.md's detail-screen
// watchlist toggle ("Toggle from any detail screen; toasts ADDED TO /
// REMOVED FROM WATCHLIST"). Deliberately its OWN component/file, not inlined
// into the movie/series/album detail branches in
// app/items/[itemType]/[id]/page.tsx — sibling lane L4 owns movie-detail's
// metadata card/mark-watched in that same file, so keeping this toggle
// isolated to one importable component makes both lanes' diffs land beside
// each other (this one only ever ADDS a `<WatchlistToggle itemId={...} />`
// line, never touches surrounding markup) rather than conflicting inside a
// shared block.
//
// State: useWatchlistIds() (lib/watchlist-sync.ts) is the shared "watchlist
// (id -> bool)" client state the README's State management section
// describes — this component only reads/mutates it, never owns a second
// copy. PUT/DELETE /watchlist/{itemId} do the actual write (server-side
// guarded — see packages/db/src/query/watchlist.ts); markAdded/markRemoved
// update this tab's own view optimistically the instant the request
// resolves, while the watchlist.added/watchlist.removed websocket event
// (delivered to every one of this user's OTHER signed-in devices/tabs) is
// what makes OTHER sessions pick up the same change live.

import { useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { useToast } from "../ui/Toast.js";
import { apiDelete, apiPut } from "../../lib/api-client.js";
import { useWatchlistIds } from "../../lib/watchlist-sync.js";
import styles from "./WatchlistToggle.module.css";

export interface WatchlistToggleProps {
  itemId: string;
}

export function WatchlistToggle({ itemId }: WatchlistToggleProps): React.JSX.Element {
  const { ids, loading, markAdded, markRemoved } = useWatchlistIds();
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);
  const inWatchlist = ids.has(itemId);

  async function handleClick(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      if (inWatchlist) {
        await apiDelete("/watchlist/{itemId}", { params: { path: { itemId } } });
        markRemoved(itemId);
        showToast("REMOVED FROM WATCHLIST");
      } else {
        await apiPut("/watchlist/{itemId}", { params: { path: { itemId } } });
        markAdded(itemId);
        showToast("ADDED TO WATCHLIST");
      }
    } catch {
      // Best-effort: a failed request leaves the toggle in its PREVIOUS
      // state (neither markAdded nor markRemoved ran) so the control just
      // reads as "didn't take" and a retry is a plain second click — the
      // prototype specifies no dedicated error copy for this flow.
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={styles.button}
      data-active={inWatchlist}
      onClick={() => void handleClick()}
      disabled={loading || pending}
      aria-pressed={inWatchlist}
    >
      <Icon icon={inWatchlist ? BookmarkCheck : Bookmark} size="dense" aria-hidden />
      {inWatchlist ? "Watchlisted" : "Watchlist"}
    </button>
  );
}
