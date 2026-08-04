// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/NoticeOverlayStrip.tsx
//
// N3's player review checkpoint: a system notice must surface even inside
// the REAL Fullscreen API, which paints ONLY the fullscreen element's own
// subtree — the toast viewport and the shell's BannerRegion both vanish
// then (STATE.md NG9). VideoPlayer.tsx mounts this as a direct child of
// `stageRef` (the fullscreen target) — the one DOM position proven to
// survive real fullscreen, same reasoning as AmbientBackdrop/ResumePrompt/
// PlayerControls already living there.
//
// ALL severities appear here (unlike the shell, which only gets
// warning/critical — info is the toast elsewhere, see
// SystemNoticeProvider.tsx): info auto-hides after ~6s, warning gets the
// SAME shared per-session dismiss flag BannerRegion uses (one dismiss,
// both surfaces — dismissing here also clears the top banner and vice
// versa, by design: NG10's per-session dismiss is one flag, not
// per-surface), critical persists with no dismiss control ever.
//
// `pointer-events: none` on the strip's own container so it never steals
// clicks meant for the video/controls beneath it (N6) — only the dismiss
// button (itself `pointer-events: auto`) is interactive. Playback state
// (play/pause/seek/volume/etc.) is never read or touched here — this
// component is purely a render of SystemNoticeProvider's shared state.
// VISIBILITY stays independent of PlayerControls' idle-hide (this strip
// never hides because controls did) but POSITION yields (review R-F4):
// while the controls' top bar is shown, `belowControls` shifts the strip
// under that bar so the Back button and title are never covered — the
// collision otherwise recurs at the highest-attention moment, every time
// controls are revealed during a persistent warning/critical notice.
// Under real fullscreen the strip is the ONLY notice surface a screen
// reader can perceive (banner + toast live outside the fullscreen
// subtree), so it carries the same role split BannerRegion uses:
// critical = role "alert", info/warning = role "status" (review R-F5).

import { useEffect, useState } from "react";
import { AlertTriangle, Info, OctagonAlert, X } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { defaultFormatTime } from "./Scrubber.js";
import { useSystemNotice, type NoticeSeverity } from "../notices/SystemNoticeProvider.js";
import { useNoticeCountdown } from "../notices/useNoticeCountdown.js";
import styles from "./NoticeOverlayStrip.module.css";

const INFO_AUTO_HIDE_MS = 6000;

const SEVERITY_ICON: Record<NoticeSeverity, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: OctagonAlert,
};

export function NoticeOverlayStrip({ belowControls = false }: { belowControls?: boolean } = {}): React.JSX.Element | null {
  const { notice, severity, dismissed, dismiss, serverOffsetMs } = useSystemNotice();
  const countdown = useNoticeCountdown(notice?.effectiveAtMs ?? null, serverOffsetMs);
  const [autoHiddenId, setAutoHiddenId] = useState<string | null>(null);

  // Info-only local auto-hide — a fresh timer per notice id, independent
  // of the toast's own 2.6s (that fires once, elsewhere; a fullscreen
  // viewer never sees it, so the strip needs its own read window).
  useEffect(() => {
    if (!notice || severity !== "info") return undefined;
    const id = notice.id;
    const timer = setTimeout(() => setAutoHiddenId(id), INFO_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice?.id, severity]);

  if (!notice || !severity) return null;

  const visible =
    severity === "critical" || (severity === "warning" && !dismissed) || (severity === "info" && autoHiddenId !== notice.id);
  if (!visible) return null;

  return (
    <div
      className={styles.strip}
      data-severity={severity}
      data-below-controls={belowControls ? "true" : undefined}
      role={severity === "critical" ? "alert" : "status"}
    >
      <Icon icon={SEVERITY_ICON[severity]} size="dense" aria-hidden />
      <div className={styles.text}>
        <span className={styles.message}>{notice.message}</span>
        {countdown && (
          <span className={styles.countdown}>
            {countdown.due ? "Restarting now" : `Restarting in ${defaultFormatTime(countdown.remainingMs)}`}
          </span>
        )}
      </div>
      {severity === "warning" && (
        <button type="button" className={styles.dismiss} aria-label="Dismiss notice" onClick={dismiss}>
          <Icon icon={X} size="dense" />
        </button>
      )}
    </div>
  );
}
