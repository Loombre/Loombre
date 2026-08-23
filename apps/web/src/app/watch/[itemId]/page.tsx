// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/watch/[itemId]/page.tsx
//
// Deliverate 1's route. Deliberately NOT wrapped in the shell-owned
// AppShell — a full-bleed immersive player (its own back control) matches
// how every mainstream player surface behaves, and keeps this route free
// of any layout ownership overlap with the other Wave-2 lane.
//
// Handles both video (movie/episode) and audio (track/album) item ids so a
// single /watch/{itemId} link works everywhere: video renders inline here;
// audio hands off to the persistent music mini player (components/music/)
// and lands the user on the item's own detail page, since audio keeps
// playing across navigation by design (see AppProviders.tsx's header).
//
// QA gap-F8 — why the audio branch ends in `router.replace(itemHref)` and
// NOT `router.back()`: the MusicPlayerProvider that receives the queue is
// mounted ABOVE this route by the root layout, so the handoff only
// survives if the browser stays in THIS document. A history traversal
// cannot promise that. Reached by a typed URL / bookmark / new tab (the
// reported repro) the previous history entry is a different DOCUMENT:
// going back to it tears the provider down — queue included — before it
// ever reaches POST /playback/sessions, which is exactly the reported
// "fetches the item, then nothing: no session, no mini player, no error".
// With no previous entry at all, `back()` does nothing and the user is
// stranded on a route whose own render is `null`. `replace()` to the
// item's page is a client-side navigation in every arrival case (so the
// provider, the queue and the <audio> elements all live on), and
// replacing rather than pushing keeps /watch out of the history stack so
// a later Back doesn't bounce through here and restart the track.

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { VideoPlayer } from "../../../components/player/VideoPlayer.js";
import { useMusicPlayer } from "../../../components/music/MusicPlayerProvider.js";
import { fetchItemSummary } from "../../../lib/item-lookup.js";
import { apiGet } from "../../../lib/api-client.js";
import { getAuthStore } from "../../../lib/auth-store.js";

export default function WatchPage(): React.JSX.Element | null {
  const params = useParams<{ itemId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const musicPlayer = useMusicPlayer();
  const [routed, setRouted] = useState<"video" | "pending">("pending");
  const startedRef = useRef(false);

  const itemId = params.itemId;
  const hintType = searchParams.get("type") ?? undefined;
  // Which VERSION of the item to play (components/detail/VersionRow.tsx
  // links here with its own row's file id). Absent = the item's primary
  // media_files row, which is PlanRequest's own documented default
  // (packages/contract/openapi.yaml) — so a plain /watch/{itemId} link
  // behaves exactly as before.
  const mediaFileId = searchParams.get("mediaFileId") ?? undefined;
  // Deep-link start offset (S7 chapters): app/restricted/scenes/[id]/
  // page.tsx's markers list already links here with `?t=<wholeSeconds>`
  // (Math.floor(marker.startMs / 1000)) — `t`, not `startMs`, to keep the
  // URL short/shareable the way a video site's timestamp link reads;
  // converted to ms (VideoPlayer's/CLAUDE.md invariant 5's unit) at this
  // one boundary. Ignored if missing/non-numeric/negative rather than
  // thrown — a malformed deep link should degrade to "start from the
  // beginning" (or the normal resume prompt), never a crashed route.
  const tParam = searchParams.get("t");
  const startSeconds = tParam !== null ? Number(tParam) : NaN;
  const startMs = Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds * 1000 : undefined;

  useEffect(() => {
    const store = getAuthStore();
    if (!store.isAuthenticated()) {
      router.replace("/login");
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    void fetchItemSummary(itemId, hintType).then(async (item) => {
      if (item.itemType === "movie" || item.itemType === "episode") {
        setRouted("video");
        return;
      }
      if (item.itemType === "track") {
        musicPlayer.playTrack({
          itemId: item.id,
          title: item.title,
          subtitle: item.subtitle,
          durationMs: item.durationMs,
          ...(mediaFileId ? { mediaFileId } : {}),
        });
        router.replace(`/items/track/${item.id}`);
        return;
      }
      // album: enqueue every track in album order.
      const tracks = await apiGet("/albums/{id}/tracks", { params: { path: { id: item.id }, query: { limit: 200 } } });
      const queue = tracks.items.map((t) => ({ itemId: t.id, title: t.title, subtitle: t.trackNumber ? `Track ${t.trackNumber}` : null, durationMs: t.durationMs, albumId: t.albumId }));
      // An empty album must not reach playQueue: SET_QUEUE with no tracks
      // resets lib/queue.ts to `{ items: [], currentIndex: null }`, i.e. it
      // would STOP whatever the user is currently listening to as the price
      // of opening a link to an album with nothing in it.
      if (queue.length > 0) musicPlayer.playQueue(queue);
      router.replace(`/items/album/${item.id}`);
    });
    // `musicPlayer.playTrack`/`playQueue` are useCallback-stabilized
    // (MusicPlayerProvider), so only the primitives below need to be
    // dependencies — including the whole context value here would re-run
    // this on every position tick while something else is playing.
  }, [itemId, hintType, mediaFileId, router, musicPlayer.playTrack, musicPlayer.playQueue]);

  if (routed === "video") {
    return (
      <VideoPlayer
        itemId={itemId}
        onBack={() => router.back()}
        {...(hintType ? { hintType } : {})}
        {...(mediaFileId ? { mediaFileId } : {})}
        {...(startMs !== undefined ? { startMs } : {})}
      />
    );
  }
  return null;
}
