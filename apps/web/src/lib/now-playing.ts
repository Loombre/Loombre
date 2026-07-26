// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/now-playing.ts
//
// Now-playing pulse hook (P2.11: "Home rows subtle now-playing pulse").
// Exported for the OTHER Wave-2 lane to adopt on PosterCard/Row later (this
// lane doesn't own components/home/**, so it isn't wired into PosterCard
// itself here — see the wave report). Listens to the shared events socket
// for `playback.started`/`playback.progress`/`playback.ended` and tracks
// the set of itemIds currently playing, evicting an entry if no progress
// event refreshes it within STALE_MS (the server throttles playback.progress
// to at most once per 30s per session — packages/contract/event-schemas/
// playback.progress.schema.json — so the eviction window must exceed that).

import { useEffect, useState } from "react";
import { getEventsSocket, type EventEnvelope } from "./events-socket.js";

interface PlaybackStartedPayload {
  sessionId: string;
  itemId: string;
}
interface PlaybackProgressPayload {
  sessionId: string;
  itemId: string;
}
interface PlaybackEndedPayload {
  sessionId: string;
  itemId: string;
}

/** Exceeds the server's 30s-per-session progress throttle with headroom for
 *  one missed tick before an item is considered no-longer-playing. */
const STALE_MS = 75_000;

/** React hook: returns the live Set of itemIds with active playback
 *  sessions, per this client's own websocket view (best-effort presence,
 *  not a source of truth — a missed/late WS message just means a poster's
 *  pulse turns off a little late, never a security-relevant state). */
export function useNowPlayingItemIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const lastSeenMs = new Map<string, number>();

    function recompute(): void {
      const now = Date.now();
      const next = new Set<string>();
      for (const [itemId, seenAt] of lastSeenMs) {
        if (now - seenAt <= STALE_MS) next.add(itemId);
        else lastSeenMs.delete(itemId);
      }
      setIds(next);
    }

    function touch(itemId: string): void {
      lastSeenMs.set(itemId, Date.now());
      recompute();
    }

    const socket = getEventsSocket();
    const unsubscribers = [
      socket.subscribe<PlaybackStartedPayload>("playback.started", (e: EventEnvelope<PlaybackStartedPayload>) =>
        touch(e.payload.itemId),
      ),
      socket.subscribe<PlaybackProgressPayload>("playback.progress", (e: EventEnvelope<PlaybackProgressPayload>) =>
        touch(e.payload.itemId),
      ),
      socket.subscribe<PlaybackEndedPayload>("playback.ended", (e: EventEnvelope<PlaybackEndedPayload>) => {
        lastSeenMs.delete(e.payload.itemId);
        recompute();
      }),
    ];

    const interval = setInterval(recompute, STALE_MS / 2);
    return () => {
      for (const unsub of unsubscribers) unsub();
      clearInterval(interval);
    };
  }, []);

  return ids;
}
