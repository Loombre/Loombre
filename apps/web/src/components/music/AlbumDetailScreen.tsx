// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/music/AlbumDetailScreen.tsx
//
// Full Phosphor album screen (design/phosphor/dc:525-576, "MUSIC") —
// desktop and mobile trees coexist in the DOM, CSS-swapped at the shared
// 767.98px breakpoint (same convention as MovieDetailScreen.tsx/
// SeriesDetailScreen.tsx), replacing the generic AmbientHero rendering the
// album branch of app/items/[itemType]/[id]/page.tsx used to route through.
//
// Ground truth (U9 — every prototype fixture field checked against a real
// capability before being wired or omitted):
//   - Art tile: real artwork via the existing image-url/blurhash path,
//     gradient+initial fallback (AlbumArt.tsx). Vinyl-ring ROTATES only
//     while `current?.albumId === album.id && isPlaying` — a real
//     MusicPlayerProvider check, not "this album is merely open".
//   - Eyebrow "ALBUM · <year> · <N> TRACKS": all real (CatalogItemBase.year,
//     the actually-fetched track list's own length — not the separate
//     `album.trackCount` column, so the number on screen always matches
//     what's rendered below it).
//   - "· <container/codec>" (prototype fixture: "FLAC 24/96"): OMITTED.
//     MediaFileSummary (container/audioTracks[].codec) only populates on
//     GET /tracks/{id} — the single-item fetch — never on the
//     GET /albums/{id}/tracks LIST this screen uses (same "absent on list
//     responses" rule as movie/episode mediaFiles). Surfacing it would mean
//     an extra per-album GET /tracks/{id} round trip for one representative
//     track purely to decorate an eyebrow — no such "peek at one row for a
//     summary fact" pattern exists anywhere else in this codebase, and
//     Tier-0 discipline argues against inventing one for a decorative
//     label. No bit-depth/sample-rate field exists on MediaFileSummary at
//     all (the "24/96" half of the fixture), so even a per-track fetch
//     could not reproduce it. Logged as a real gap, not silently dropped.
//   - Shuffle: OMITTED. lib/queue.ts's QueueAction union has no shuffle/
//     randomize action, and MusicPlayerContextValue exposes none — ground-
//     truthed directly against the reducer, not assumed. A "Shuffle" button
//     with nothing to call would be a dead control (U9).
//   - "GAPLESS OK · NO TRANSCODE": OMITTED. The gapless dual-<audio> chain
//     (lib/gapless.ts) is real, but nothing computes a per-album "will
//     THIS queue actually hand off seamlessly" guarantee (codec/sample-rate
//     changes between tracks could break it; no such check exists), and
//     playback is direct-play-only project-wide with no per-item transcode
//     decision surfaced here to honestly claim "no transcode" from. Neither
//     half of this fixture line has a real backing value.
//   - "MORE ALBUMS": real — GET /artists/{id}/albums (the same endpoint
//     ArtistDetail already uses), filtered to exclude the current album.
//     Column omitted entirely (not just emptied) when the artist has no
//     other albums, rather than rendering a heading over nothing.
//   - "Up next" queue-open row: real (MusicPlayerProvider.openQueueDrawer),
//     mobile-only per the prototype's own mobile fixture (dc:1733-1739) —
//     the desktop dc markup (525-576) has no such row at all; the
//     persistent MiniPlayerBar's own queue toggle already covers desktop.
//   - Watchlist toggle: pre-existing real capability on this exact screen,
//     kept as-is (not a prototype fixture — WatchlistToggle.tsx, Wave 2 L3).
//     browser-items-F11: it now renders in BOTH trees. It was desktop-only,
//     which silently made the toggle a desktop privilege on a screen whose
//     mobile tree is otherwise feature-complete.

import { useEffect, useMemo, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "../../lib/api-client.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { tracksToPlayableQueue } from "../../lib/play-queue.js";
import { AlbumArt } from "./AlbumArt.js";
import { useMusicPlayer } from "./MusicPlayerProvider.js";
import { useDetailFetch } from "../detail/useDetailFetch.js";
import { DetailLoadError, DetailNotFound } from "../detail/DetailFetchStatus.js";
import { MusicPlayButton } from "../detail/MusicPlayButton.js";
import { WatchlistToggle } from "../detail/WatchlistToggle.js";
import { TrackRow } from "../detail/TrackRow.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import styles from "./AlbumDetailScreen.module.css";

type Album = components["schemas"]["Album"];
type Artist = components["schemas"]["Artist"];
type Track = components["schemas"]["Track"];

function eyebrowLine(album: Album, trackCount: number): string {
  const parts = [
    "ALBUM",
    album.year ? String(album.year) : null,
    trackCount > 0 ? `${trackCount} TRACK${trackCount === 1 ? "" : "S"}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

// MORE ALBUMS grid tile — fluid (width:100% via CSS grid track, not a
// fixed pixel size), so this does NOT reuse AlbumArt.tsx (that component's
// `size` prop is JS-computed for a fixed tile and the vinyl/initial-letter
// treatment that spot doesn't need). Real artwork with a CSS-only gradient
// fallback layered underneath (no JS onError branch — a decode failure
// just leaves the gradient visible through the broken <img>, hidden via
// this same handler so no browken-image glyph ever shows).
function MoreAlbumTile({
  serverUrl,
  accessToken,
  album,
}: {
  serverUrl: string;
  accessToken: string;
  album: Album;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const posterImage = album.images?.find((img) => img.kind === "poster");
  const placeholderUri = useMemo(() => (posterImage?.blurhash ? blurhashToDataUri(posterImage.blurhash) : null), [posterImage?.blurhash]);
  const src = buildImageUrl({ serverUrl, accessToken, entityType: "album", entityId: album.id, kind: "poster", width: 220 });

  return (
    <a href={`/items/album/${album.id}`} className={styles.moreAlbumTile}>
      <div
        className={styles.moreAlbumArt}
        style={{ "--tile-glow": posterImage?.dominantColor ?? undefined } as React.CSSProperties}
      >
        {!failed && (
          <>
            {placeholderUri && <img className={styles.moreAlbumPlaceholder} src={placeholderUri} alt="" aria-hidden="true" />}
            <img className={styles.moreAlbumImage} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
          </>
        )}
      </div>
      <span className={styles.moreAlbumTitle}>{album.title}</span>
    </a>
  );
}

export function AlbumDetailScreen({
  id,
  serverUrl,
  accessToken,
}: {
  id: string;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  const musicPlayer = useMusicPlayer();

  // browser-items-F4: the album fetch used to be a bare `.then()` whose
  // only render gate was `album === null`, so a 404'd id (deleted,
  // mistyped, or a stale deep link) left the three skeletons below pulsing
  // forever and its rejection went unhandled. This screen now uses the
  // same detail/useDetailFetch.ts hook as every OTHER item type
  // (movie/series/episode/artist/track), so a not-found album reads
  // "Album not found." here exactly as it does there.
  const {
    entity: album,
    notFound,
    error,
    retry,
  } = useDetailFetch<Album>(() => apiGet("/albums/{id}", { params: { path: { id } } }), id);

  const [artist, setArtist] = useState<Artist | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [tracksFailed, setTracksFailed] = useState(false);
  const [otherAlbums, setOtherAlbums] = useState<Album[] | null>(null);

  // Artist-derived fetches, keyed on the artist the loaded album names —
  // previously nested inside the album `.then()`, which is what made that
  // outer promise's missing `.catch()` swallow-nothing so easy to miss.
  const artistId = album?.artistId ?? null;
  useEffect(() => {
    setArtist(null);
    setOtherAlbums(null);
    if (artistId === null) return;
    let cancelled = false;
    apiGet("/artists/{id}", { params: { path: { id: artistId } } })
      .then((ar) => {
        if (!cancelled) setArtist(ar);
      })
      .catch(() => undefined);
    apiGet("/artists/{id}/albums", { params: { path: { id: artistId }, query: { limit: 100 } } })
      .then((page) => {
        if (!cancelled) setOtherAlbums(page.items.filter((other) => other.id !== id));
      })
      .catch(() => {
        if (!cancelled) setOtherAlbums([]);
      });
    return () => {
      cancelled = true;
    };
  }, [artistId, id]);

  // Fired in parallel with the album fetch (not after it) — one round trip
  // saved on the happy path. Its own `.catch` keeps a failed track list
  // from pulsing forever, and keeps the rejection off the console when the
  // id 404s and BOTH requests fail.
  useEffect(() => {
    let cancelled = false;
    setTracks(null);
    setTracksFailed(false);
    apiGet("/albums/{id}/tracks", { params: { path: { id }, query: { limit: 200 } } })
      .then((page) => {
        if (!cancelled) setTracks(page.items);
      })
      .catch(() => {
        if (!cancelled) setTracksFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (notFound) return <DetailNotFound label="Album" />;
  if (error) return <DetailLoadError message={error} onRetry={retry} />;

  if (!album) {
    return (
      <div className={styles.page}>
        <Skeleton radius="md" height={230} width={230} />
        <Skeleton radius="sm" height={16} width="40%" />
        <Skeleton radius="sm" height={16} width="70%" />
      </div>
    );
  }

  const sortedTracks = tracks ? tracks.slice().sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0)) : [];
  const posterImage = album.images?.find((img) => img.kind === "poster");
  const isThisAlbumPlaying = musicPlayer.current?.albumId === album.id && musicPlayer.isPlaying;
  const hasOtherAlbums = (otherAlbums?.length ?? 0) > 0;
  const hasQueue = musicPlayer.queueState.items.length > 0;

  // One element, rendered in BOTH the desktop and mobile trees (they
  // coexist in the DOM, CSS-swapped) so the two can never drift apart.
  const trackSection =
    tracks === null ? (
      tracksFailed ? (
        <div className={styles.emptyNote}>Failed to load tracks.</div>
      ) : (
        <Skeleton radius="md" height={200} />
      )
    ) : sortedTracks.length === 0 ? (
      <div className={styles.emptyNote}>No tracks found.</div>
    ) : (
      <div className={styles.trackList}>
        {sortedTracks.map((track, index) => (
          <TrackRow key={track.id} track={track} albumTracks={sortedTracks} index={index} />
        ))}
      </div>
    );

  return (
    <div className={styles.page}>
      {/* ── Desktop tree (CSS-hidden below 767.98px) ── */}
      <div className={styles.desktopOnly}>
        <div className={styles.header}>
          <AlbumArt
            serverUrl={serverUrl}
            accessToken={accessToken}
            albumId={album.id}
            title={album.title}
            blurhash={posterImage?.blurhash ?? null}
            dominantColor={posterImage?.dominantColor ?? null}
            size={230}
            spinning={isThisAlbumPlaying}
          />
          <div className={styles.metaColumn}>
            <div className={styles.eyebrow}>{eyebrowLine(album, sortedTracks.length)}</div>
            <h1 className={styles.title}>{album.title}</h1>
            {artist && (
              <a href={`/items/artist/${album.artistId}`} className={styles.artist}>
                {artist.title}
              </a>
            )}
            <div className={styles.actionRow}>
              {sortedTracks.length > 0 && <MusicPlayButton queue={tracksToPlayableQueue(sortedTracks)} label="Play album" />}
              <WatchlistToggle itemId={album.id} />
            </div>
          </div>
        </div>
        <div className={styles.body} data-has-more-albums={hasOtherAlbums}>
          <div>
            <div className={styles.sectionEyebrow}>TRACKS</div>
            {trackSection}
          </div>
          {hasOtherAlbums && (
            <div>
              <div className={styles.sectionEyebrow}>MORE ALBUMS</div>
              <div className={styles.moreAlbumsGrid}>
                {otherAlbums!.map((other) => (
                  <MoreAlbumTile key={other.id} serverUrl={serverUrl} accessToken={accessToken} album={other} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile tree (CSS-hidden at/above 767.98px) ── */}
      <div className={styles.mobileOnly}>
        <div className={styles.mobileHeader}>
          <AlbumArt
            serverUrl={serverUrl}
            accessToken={accessToken}
            albumId={album.id}
            title={album.title}
            blurhash={posterImage?.blurhash ?? null}
            dominantColor={posterImage?.dominantColor ?? null}
            size={118}
            spinning={isThisAlbumPlaying}
            showVinyl={false}
          />
          <div className={styles.mobileMetaColumn}>
            <div className={styles.mobileTitle}>{album.title}</div>
            {artist && (
              <a href={`/items/artist/${album.artistId}`} className={styles.mobileArtist}>
                {artist.title}
              </a>
            )}
            <div className={styles.mobileMeta}>{eyebrowLine(album, sortedTracks.length)}</div>
          </div>
        </div>
        {/* browser-items-F11: the same watchlist toggle the desktop tree
            renders — the mobile tree used to omit it, so a phone viewer of
            an album lost a capability desktop viewers have (movie detail
            already kept its toggle in both trees). */}
        <div className={styles.mobileActionRow}>
          {sortedTracks.length > 0 && (
            <MusicPlayButton queue={tracksToPlayableQueue(sortedTracks)} label="Play album" />
          )}
          <WatchlistToggle itemId={album.id} />
        </div>
        {hasQueue && (
          <button type="button" className={styles.upNextRow} onClick={musicPlayer.openQueueDrawer}>
            <span className={styles.upNextLabel}>Up next</span>
            <span className={styles.upNextCount}>{musicPlayer.queueState.items.length}</span>
          </button>
        )}
        {trackSection}
      </div>
    </div>
  );
}
