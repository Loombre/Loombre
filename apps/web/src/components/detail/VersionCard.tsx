// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionCard.tsx
//
// Movie-detail VERSIONS card (design/phosphor/README.md "Movie detail":
// "per-file cards with DEFAULT badge, size, codec specs, direct-play line,
// full path"). Real data only, from the additive MediaFileSummary fields
// (packages/db/src/query/catalog-detail.ts's "full house" extension —
// path/isDefault/videoCodec/bitDepth/hdr/audioTracks/subtitleTracks are all
// real, already-probed media_files/media_streams columns).
//
// The prototype's third row reads "● DIRECT PLAY · <path>" — a per-version
// direct-play CLAIM. That specific claim is deliberately DROPPED here: the
// only way to know a real per-file direct-play verdict is a
// POST /playback/plan call (or a session), and lib/playback-session.ts's
// own header documents that the client-side pre-play plan PREVIEW was
// intentionally removed in Phase 3 Step 6c ("VideoPlayer.tsx now goes
// straight to createPlaybackSession() and branches on the real session's
// own plan.decision") — rebuilding an approximate preview here, for a
// single file, on a page that never plays it, would resurrect exactly the
// pattern the team already retired. Ground-truth per the Wave-2 L4 brief:
// "if the direct-play verdict isn't client-available pre-play, omit the
// line + log" — so this card keeps the real facts (codec specs, full path)
// and drops the unverifiable claim. Logged in the freeze report.
import type { components } from "@loombre/sdk";
import { formatAudioTrackLabel, formatFileSize, formatResolution, formatRuntime } from "./format.js";
import styles from "./VersionCard.module.css";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

const VIDEO_CODEC_LABEL: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  mpeg2: "MPEG-2",
  vc1: "VC-1",
  mpeg4: "MPEG-4",
  unknown: "Unknown codec",
};

function hdrLabel(hdr: MediaFileSummary["hdr"]): string | null {
  if (!hdr || hdr === "none") return "SDR";
  if (hdr === "hdr10") return "HDR10";
  if (hdr === "hlg") return "HLG";
  if (hdr === "dv") return "Dolby Vision";
  return null;
}

function specsLine(file: MediaFileSummary): string {
  const parts = [
    formatResolution(file.height ?? null),
    file.videoCodec ? hdrLabel(file.hdr ?? null) : null,
    file.videoCodec ? (VIDEO_CODEC_LABEL[file.videoCodec] ?? file.videoCodec.toUpperCase()) : null,
    file.audioTracks && file.audioTracks.length > 0 ? formatAudioTrackLabel(file.audioTracks[0]!) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "Not yet probed";
}

export function VersionCard({ file }: { file: MediaFileSummary }): React.JSX.Element {
  const size = formatFileSize(file.sizeBytes ?? null);
  const runtime = formatRuntime(file.durationMs ?? null);
  return (
    <div className={styles.card} data-default={file.isDefault ?? false}>
      <div className={styles.headRow}>
        <span className={styles.name}>{file.versionLabel ?? "Original"}</span>
        {file.isDefault && <span className={styles.defaultBadge}>DEFAULT</span>}
        <span className={styles.size}>{size ?? runtime ?? ""}</span>
      </div>
      <div className={styles.specs}>{specsLine(file)}</div>
      {file.path !== undefined && <div className={styles.path}>{file.path}</div>}
    </div>
  );
}
