// SPDX-License-Identifier: AGPL-3.0-only
"use client";

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
//
// LD-18 (rc.6): that full path renders under ONE convention on desktop and
// mobile — monospace, word-break: break-all, no line clamp, no ellipsis —
// with a copy button beside it. MovieDetailScreen renders this card in both
// its desktop and mobile trees (CSS swaps which one displays), so fixing it
// here fixes both.
import { useEffect, useRef, useState } from "react";
import { BoxSelect, Check, Copy } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { Button } from "../ui/Button.js";
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
  // browser-items-F6: `null` and the enum member `"none"` are NOT the same
  // claim. `"none"` is a positive probed verdict (packages/db's
  // deriveHdrForDisplay / toHdr, catalog-detail.ts) — "SDR" is correct.
  // `null` means no confident HDR signal was derivable at all (unset hdr
  // column + a color_transfer that doesn't indicate HDR either) — asserting
  // "SDR" there would be exactly the misleading claim this finding is
  // about, so it's omitted from the specs line instead (specsLine's
  // `.filter(Boolean)` below drops it).
  if (hdr === "none") return "SDR";
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

/** How long the copied/selected transient state stays up before reverting
 *  to the idle "Copy" affordance. Same 2s as CommandBlock. */
const COPY_RESET_MS = 2000;

type CopyState = "idle" | "copied" | "selected";

/**
 * LD-18 (rc.6): the file path plus its copy button. The three-state copy
 * pattern is CommandBlock's, verbatim in behaviour — Copy → Check for 2s,
 * the reset timer held in a ref so unmounting inside the window cancels it
 * (CommandBlock finding 16), and the non-secure-context guard
 * (CommandBlock finding 7): `navigator.clipboard` is UNDEFINED on a
 * plain-HTTP LAN address, which is this product's normal case, so an absent
 * API must not throw uncaught — it falls back to selecting the path text and
 * showing the BoxSelect "Select & copy" affordance, one Cmd/Ctrl-C from the
 * same result.
 *
 * The path and the button sit in separate flex tracks (.pathRow), so the
 * wrapped path is never covered or clipped by the button at any width.
 */
function FilePathRow({ path }: { path: string }): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  const pathRef = useRef<HTMLDivElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  function scheduleReset(): void {
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setState("idle");
    }, COPY_RESET_MS);
  }

  function selectPathText(): void {
    const node = pathRef.current;
    const selection = window.getSelection();
    if (node === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function handleCopy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) {
        // Same shape as a denied/rejected call below — one catch, one
        // fallback for both.
        throw new Error("Clipboard API unavailable");
      }
      // The EXACT full path string, nothing trimmed or elided.
      await navigator.clipboard.writeText(path);
      setState("copied");
    } catch {
      selectPathText();
      setState("selected");
    }
    scheduleReset();
  }

  const icon = state === "copied" ? Check : state === "selected" ? BoxSelect : Copy;
  const title = state === "copied" ? "Copied" : state === "selected" ? "Select & copy" : "Copy";

  return (
    <div className={styles.pathRow}>
      <div className={styles.path} ref={pathRef}>
        {path}
      </div>
      <Button
        type="button"
        variant="ghost"
        iconOnly
        className={styles.copyButton}
        aria-label="Copy file path"
        title={title}
        onClick={() => void handleCopy()}
      >
        <Icon icon={icon} size="dense" />
      </Button>
    </div>
  );
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
      {file.path !== undefined && <FilePathRow path={file.path} />}
    </div>
  );
}
