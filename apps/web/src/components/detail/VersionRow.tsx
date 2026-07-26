// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionRow.tsx
//
// P2 work item 4: one media_files row inside a detail page's "Versions"
// section (movie/episode/track — the only item types with a `mediaFiles[]`
// field per the contract; series/artist/album are not directly playable).
//
// TODO(watch-version-param): the contract's PlanRequest already supports
// selecting a specific file via an optional `mediaFileId` (defaults to the
// item's primary media_files row when omitted — packages/contract/
// openapi.yaml's PlanRequest schema), so per-version playback selection is
// possible server-side today. But /watch/[itemId] and VideoPlayer (lane
// (ii)'s file ownership) only take an itemId — there is no query param that
// threads a chosen fileId through to createPlaybackSession's PlanRequest.
// Reworking their route/player is out of this lane's scope for this pass
// per the task brief, so every version's Play button intentionally starts
// the item's DEFAULT version until that param is wired.

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
    <a href={`/watch/${itemId}`} className={styles.row}>
      <span className={styles.info}>
        <span className={styles.title}>{file.versionLabel ?? "Original"}</span>
        <span className={styles.meta}>{meta || "Not yet probed"}</span>
      </span>
      <Icon icon="play" size="dense" className={styles.playIcon ?? ""} />
    </a>
  );
}
