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
// and returns to wherever the user came from, since audio keeps playing
// across navigation by design (see AppProviders.tsx's header).

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
        router.back();
        return;
      }
      // album: enqueue every track in album order.
      const tracks = await apiGet("/albums/{id}/tracks", { params: { path: { id: item.id }, query: { limit: 200 } } });
      musicPlayer.playQueue(
        tracks.items.map((t) => ({ itemId: t.id, title: t.title, subtitle: t.trackNumber ? `Track ${t.trackNumber}` : null, durationMs: t.durationMs, albumId: t.albumId })),
      );
      router.back();
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
      />
    );
  }
  return null;
}
