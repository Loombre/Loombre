// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/items/[itemType]/[id]/page.tsx
//
// Item detail — one dynamic route for every leaf/branch catalog type the
// contract can fetch directly by id: movie, series, episode, artist,
// album, track. "season" is deliberately NOT a route here — the contract
// has no `GET /seasons/{id}` (only a list-by-series and a list-episodes-by-
// season-id), so season navigation lives inline on the series screen
// instead (Phosphor W2 L4: season PILL TABS over all eagerly-fetched
// seasons — see components/detail/SeriesDetailScreen.tsx's header; this
// replaced the pre-Phosphor per-season <details> disclosure, which is
// gone).
//
// Movie/Series/Album now render through dedicated Phosphor screen
// components (components/detail/MovieDetailScreen.tsx /
// SeriesDetailScreen.tsx / components/music/AlbumDetailScreen.tsx — full
// prototype structure, both breakpoints) instead of the generic
// AmbientHero this route still uses for episode/artist/track (out of this
// lane's scope; P2.11's inset ambient-hero treatment is still correct
// there). Phosphor Wave-3 fix lane FX3 moved Album onto its own screen
// (design/phosphor/dc:525-576) — see that component's own header for the
// full per-field ground truth.
//
// People/versions (P2 work item 4): Movie/Series/Episode/Artist responses
// carry an optional `people[]` (PersonCredit[]) and Movie/Episode/Track
// carry an optional `mediaFiles[]` (MediaFileSummary[]) when fetched via
// their GET /{id} route (absent on list responses) — see PersonCard.tsx/
// VersionRow.tsx headers for the per-row rendering and the still-open
// per-version-playback-selection gap.

"use client";

import { use, useEffect, useState } from "react";
import { notFound } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { AmbientHero } from "../../../../components/detail/AmbientHero.js";
import { PlayLink } from "../../../../components/detail/PlayLink.js";
import { MusicPlayButton } from "../../../../components/detail/MusicPlayButton.js";
import { MovieDetailScreen } from "../../../../components/detail/MovieDetailScreen.js";
import { SeriesDetailScreen } from "../../../../components/detail/SeriesDetailScreen.js";
import { AlbumDetailScreen } from "../../../../components/music/AlbumDetailScreen.js";
import { ChildPosterGrid } from "../../../../components/detail/ChildPosterGrid.js";
import { PersonCard } from "../../../../components/detail/PersonCard.js";
import { VersionRow } from "../../../../components/detail/VersionRow.js";
import { Tag } from "../../../../components/ui/Chip.js";
import { Skeleton } from "../../../../components/skeleton/Skeleton.js";
import { formatRuntime } from "../../../../components/detail/format.js";
import { pickHeroImage } from "../../../../lib/pick-hero-image.js";
import { fetchArtistQueue } from "../../../../lib/play-queue.js";
import { apiGet } from "../../../../lib/api-client.js";
import { getAuthStore } from "../../../../lib/auth-store.js";
import styles from "./page.module.css";

type Episode = components["schemas"]["Episode"];
type Artist = components["schemas"]["Artist"];
type Album = components["schemas"]["Album"];
type Track = components["schemas"]["Track"];

const DIRECTLY_ROUTABLE = new Set(["movie", "series", "episode", "artist", "album", "track"]);

function useAuthedFetchContext(): { serverUrl: string; accessToken: string | null } {
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAuthStore()
      .getAccessToken()
      .then((token) => {
        if (!cancelled) setAccessToken(token);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { serverUrl, accessToken };
}

function DetailSkeleton(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <Skeleton radius="lg" height={360} />
      <Skeleton radius="sm" height={16} width="40%" />
      <Skeleton radius="sm" height={16} width="70%" />
    </div>
  );
}

function MetaLine({ items }: { items: (string | null | undefined)[] }): React.JSX.Element | null {
  const visible = items.filter((item): item is string => Boolean(item));
  if (visible.length === 0) return null;
  return (
    <div className={styles.metaLine}>
      {visible.map((item, i) => (
        <span key={i}>{item}</span>
      ))}
    </div>
  );
}

function GenreChips({ genres }: { genres: string[] }): React.JSX.Element | null {
  if (genres.length === 0) return null;
  return (
    <div className={styles.chips}>
      {genres.map((g) => (
        <Tag key={g}>{g}</Tag>
      ))}
    </div>
  );
}

type PersonCredit = components["schemas"]["PersonCredit"];
type MediaFileSummary = components["schemas"]["MediaFileSummary"];

function PeopleSection({ people }: { people: PersonCredit[] | undefined }): React.JSX.Element | null {
  if (!people || people.length === 0) return null;
  const sorted = people.slice().sort((a, b) => a.order - b.order);
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>Cast &amp; Crew</h2>
      <div className={styles.peopleScroller} role="list" aria-label="Cast and crew">
        {sorted.map((person) => (
          <PersonCard key={person.id} person={person} />
        ))}
      </div>
    </section>
  );
}

function VersionsSection({ itemId, mediaFiles }: { itemId: string; mediaFiles: MediaFileSummary[] | undefined }): React.JSX.Element | null {
  if (!mediaFiles || mediaFiles.length === 0) return null;
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>Versions</h2>
      <div className={styles.versionsList}>
        {mediaFiles.map((file) => (
          <VersionRow key={file.id} itemId={itemId} file={file} />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────── Movie ───────────────────────────────
// Full Phosphor screen — see components/detail/MovieDetailScreen.tsx.

// ─────────────────────────────────────── Series ──────────────────────────────
// Full Phosphor screen — see components/detail/SeriesDetailScreen.tsx.

// ─────────────────────────────────────── Episode ─────────────────────────────

function EpisodeDetail({ id, serverUrl, accessToken }: { id: string; serverUrl: string; accessToken: string }) {
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [seriesTitle, setSeriesTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet("/episodes/{id}", { params: { path: { id } } }).then((ep) => {
      if (cancelled) return;
      setEpisode(ep);
      apiGet("/series/{id}", { params: { path: { id: ep.seriesId } } })
        .then((s) => {
          if (!cancelled) setSeriesTitle(s.title);
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!episode) return <DetailSkeleton />;
  const hero = pickHeroImage(episode.images);
  return (
    <div className={styles.page}>
      {seriesTitle && (
        <a className={styles.backLink} href={`/items/series/${episode.seriesId}`}>
          ← {seriesTitle}
        </a>
      )}
      <AmbientHero
        serverUrl={serverUrl}
        accessToken={accessToken}
        entityType="episode"
        entityId={episode.id}
        backdropKind={hero.kind}
        dominantColor={hero.dominantColor}
        title={episode.title}
      >
        <MetaLine items={[`Episode ${episode.episodeNumber}`, formatRuntime(episode.runtimeMs)]} />
        <PlayLink itemId={episode.id} />
        {episode.overview && <p className={styles.overview}>{episode.overview}</p>}
      </AmbientHero>
      <PeopleSection people={episode.people} />
      <VersionsSection itemId={episode.id} mediaFiles={episode.mediaFiles} />
    </div>
  );
}

// ─────────────────────────────────────── Artist ──────────────────────────────

function ArtistDetail({ id, serverUrl, accessToken }: { id: string; serverUrl: string; accessToken: string }) {
  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet("/artists/{id}", { params: { path: { id } } }).then((a) => {
      if (!cancelled) setArtist(a);
    });
    apiGet("/artists/{id}/albums", { params: { path: { id }, query: { limit: 100 } } }).then((page) => {
      if (!cancelled) setAlbums(page.items);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!artist) return <DetailSkeleton />;
  const hero = pickHeroImage(artist.images);
  return (
    <div className={styles.page}>
      <AmbientHero
        serverUrl={serverUrl}
        accessToken={accessToken}
        entityType="artist"
        entityId={artist.id}
        backdropKind={hero.kind}
        dominantColor={hero.dominantColor}
        title={artist.title}
      >
        <GenreChips genres={artist.genres} />
        {/* No top-tracks endpoint exists (packages/contract/openapi.yaml) —
            "Play" fetches every album's tracks on click and queues them in
            album order (lib/play-queue.ts's fetchArtistQueue), the honest
            substitute for "top/all tracks queue". */}
        {albums && albums.length > 0 && <MusicPlayButton queue={() => fetchArtistQueue(albums)} />}
        {artist.overview && <p className={styles.overview}>{artist.overview}</p>}
      </AmbientHero>
      <PeopleSection people={artist.people} />
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Albums</h2>
        {albums === null ? (
          <Skeleton radius="md" height={200} />
        ) : (
          <ChildPosterGrid
            emptyMessage="No albums found."
            serverUrl={serverUrl}
            accessToken={accessToken}
            items={albums.map((album) => ({
              id: album.id,
              title: album.title,
              subtitle: album.year ? String(album.year) : undefined,
              blurhash: album.images?.find((img) => img.kind === "poster")?.blurhash ?? null,
              href: `/items/album/${album.id}`,
              entityType: "album",
            }))}
          />
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────── Album ───────────────────────────────
// Full Phosphor screen — see components/music/AlbumDetailScreen.tsx.

// ─────────────────────────────────────── Track ───────────────────────────────

function TrackDetail({ id, serverUrl, accessToken }: { id: string; serverUrl: string; accessToken: string }) {
  const [track, setTrack] = useState<Track | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet("/tracks/{id}", { params: { path: { id } } }).then((t) => {
      if (!cancelled) setTrack(t);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!track) return <DetailSkeleton />;
  const hero = pickHeroImage(track.images);
  return (
    <div className={styles.page}>
      <a className={styles.backLink} href={`/items/album/${track.albumId}`}>
        ← Back to album
      </a>
      <AmbientHero
        serverUrl={serverUrl}
        accessToken={accessToken}
        entityType="track"
        entityId={track.id}
        backdropKind={hero.kind}
        dominantColor={hero.dominantColor}
        title={track.title}
      >
        <MetaLine
          items={[
            track.trackNumber ? `Track ${track.trackNumber}` : null,
            track.discNumber ? `Disc ${track.discNumber}` : null,
            formatRuntime(track.durationMs),
          ]}
        />
        <PlayLink itemId={track.id} />
      </AmbientHero>
      <VersionsSection itemId={track.id} mediaFiles={track.mediaFiles} />
    </div>
  );
}

// ─────────────────────────────────────── Route entry ─────────────────────────

function DetailContent({ itemType, id }: { itemType: string; id: string }): React.JSX.Element {
  const { serverUrl, accessToken } = useAuthedFetchContext();

  if (!DIRECTLY_ROUTABLE.has(itemType)) {
    notFound();
  }
  if (accessToken === null) return <DetailSkeleton />;

  switch (itemType) {
    case "movie":
      return <MovieDetailScreen id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    case "series":
      return <SeriesDetailScreen id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    case "episode":
      return <EpisodeDetail id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    case "artist":
      return <ArtistDetail id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    case "album":
      return <AlbumDetailScreen id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    case "track":
      return <TrackDetail id={id} serverUrl={serverUrl} accessToken={accessToken} />;
    default:
      return <DetailSkeleton />;
  }
}

export default function ItemDetailPage({
  params,
}: {
  params: Promise<{ itemType: string; id: string }>;
}): React.JSX.Element {
  const { itemType, id } = use(params);
  return (
    <AppShell>
      <DetailContent itemType={itemType} id={id} />
    </AppShell>
  );
}
