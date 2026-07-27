// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionRow.tsx
//
// P2 work item 4: one media_files row inside a detail page's "Versions"
// section (movie/episode/track — the only item types with a `mediaFiles[]`
// field per the contract; series/artist/album are not directly playable).
//
// Per-version playback selection, end to end: the contract's PlanRequest
// selects a specific file via its optional `mediaFileId` (defaults to the
// item's primary media_files row when omitted — packages/contract/
// openapi.yaml's PlanRequest schema), so this row emits its OWN file.id as
// a `mediaFileId` query param on its /watch/{itemId} link, and the
// receiving end reads it: app/watch/[itemId]/page.tsx threads the param
// into <VideoPlayer> (movie/episode) and into playTrack() (track), each of
// which pins the real session request to that file. Guarded at both ends —
// VersionRow.test.tsx for the href, app/watch/[itemId]/page.test.tsx and
// components/music/MusicPlayerProvider.test.tsx for the session request.

"use client";

import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { formatFileSize, formatResolution, formatRuntime } from "./format.js";
import styles from "./ListRow.module.css";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

export function VersionRow({ itemId, file }: { itemId: string; file: MediaFileSummary }): React.JSX.Element {
  const meta = [
    file.container ? file.container.toUpperCase() : null,
    formatResolution(file.height),
    formatFileSize(file.sizeBytes),
    formatRuntime(file.durationMs),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <a href={`/watch/${itemId}?mediaFileId=${encodeURIComponent(file.id)}`} className={styles.row}>
      <span className={styles.info}>
        <span className={styles.title}>{file.versionLabel ?? "Original"}</span>
        <span className={styles.meta}>{meta || "Not yet probed"}</span>
      </span>
      <Icon icon="play" size="dense" className={styles.playIcon ?? ""} />
    </a>
  );
}
