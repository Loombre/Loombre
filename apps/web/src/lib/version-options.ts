// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/version-options.ts
//
// Version selection (owner report from the Linux reference box: an item
// with four files always played the default 2160p VP9 one — the VERSIONS
// cards were inert and the player had no way to pick). Two pure helpers
// shared by the item page's cards and the player's Version picker:
//
//   versionOptionsFor(files, currentId) — the picker's rows: one per
//     media_files row, labelled the way playback-fallback.ts's toast
//     already labels alternates (versionLabel, else the resolution bucket),
//     with a codec/HDR/container detail line and the CURRENT file flagged.
//   versionSwitchHref(...) — the /watch URL a switch navigates to. The URL
//     stays the single source of truth for "which file is playing"
//     (app/watch/[itemId]/page.tsx reads ?mediaFileId on every render and
//     VideoPlayer's session-create effect re-runs on that prop), so a
//     switch is a router.replace, not a second session-management path.
//     The current position rides along as ?t=<seconds> so an alternate
//     encode of the same cut resumes where the viewer was.

import type { components } from "@loombre/sdk";
import { fallbackLabel } from "./playback-fallback.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

export interface VersionOption {
  id: string;
  label: string;
  /** "H.264 · HDR10 · MKV" style line, or null when nothing is probed yet. */
  detail: string | null;
  isCurrent: boolean;
  isDefault: boolean;
}

const VIDEO_CODEC_LABEL: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  mpeg2: "MPEG-2",
  vc1: "VC-1",
  mpeg4: "MPEG-4",
};

function detailFor(file: MediaFileSummary): string | null {
  const parts: string[] = [];
  if (file.videoCodec) parts.push(VIDEO_CODEC_LABEL[file.videoCodec] ?? file.videoCodec.toUpperCase());
  // `null` = no confident HDR verdict; "none" = probed SDR. Only a positive
  // HDR format is worth a word here (VersionCard.tsx's hdrLabel reasoning).
  if (file.hdr && file.hdr !== "none") parts.push(file.hdr.toUpperCase().replace("_", " "));
  if (file.container) parts.push(file.container.toUpperCase());
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Which file is "current" when the URL names none: the item's default
 *  media_files row (PlanRequest's documented default), else the first. */
export function currentVersionId(files: readonly MediaFileSummary[], mediaFileId: string | undefined): string | undefined {
  if (mediaFileId !== undefined) return mediaFileId;
  return files.find((f) => f.isDefault)?.id ?? files[0]?.id;
}

export function versionOptionsFor(files: readonly MediaFileSummary[], mediaFileId: string | undefined): VersionOption[] {
  const current = currentVersionId(files, mediaFileId);
  return files.map((file) => ({
    id: file.id,
    label: fallbackLabel(file),
    detail: detailFor(file),
    isCurrent: file.id === current,
    isDefault: file.isDefault === true,
  }));
}

/** Positions under this are "the start" — not worth a ?t= that would only
 *  skip the resume prompt for nothing. */
const MIN_CARRY_POSITION_MS = 5_000;

export function versionSwitchHref(
  itemId: string,
  mediaFileId: string,
  options: { hintType?: string | undefined; positionMs?: number | undefined } = {},
): string {
  const query = new URLSearchParams();
  if (options.hintType) query.set("type", options.hintType);
  query.set("mediaFileId", mediaFileId);
  if (options.positionMs !== undefined && Number.isFinite(options.positionMs) && options.positionMs >= MIN_CARRY_POSITION_MS) {
    query.set("t", String(Math.floor(options.positionMs / 1000)));
  }
  return `/watch/${itemId}?${query.toString()}`;
}
