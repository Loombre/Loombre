// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/BannerRegion.tsx
//
// STATE.md NG9: the app's FIRST global banner region. Mounted in
// AppShell.tsx between the fixed Topbar and <main> — in normal document
// flow, never fixed/sticky itself, so it never overlaps the topbar or the
// page beneath it: it carries its own margin-top/left clearing the fixed
// topbar+sidebar exactly (mirrors Topbar's own inset, both breakpoints —
// see the module CSS header), and AppShell.module.css removes the
// DUPLICATE topbar-clearance padding from <main> only while a banner is
// actually rendered (a `data-banner` attribute AppShell sets from the
// same `bannerVisible` this component reads — see that file). When no
// notice is active this component renders null (no DOM node at all), so
// <main>'s ordinary padding is exactly what it always was.
//
// Renders the ACTIVE warning/critical system notice only (N3) — info
// severity never reaches here; SystemNoticeProvider fires the single-slot
// toast for that itself, boot-fetch included. Message is a plain text
// node ONLY (NG10 — never HTML, never dangerouslySetInnerHTML). One row,
// one control (the dismiss button) — never a modal, never intercepts
// clicks outside that one button (N6).

import { AlertTriangle, OctagonAlert, X } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { defaultFormatTime } from "../player/Scrubber.js";
import { useSystemNotice } from "../notices/SystemNoticeProvider.js";
import { useNoticeCountdown } from "../notices/useNoticeCountdown.js";
import styles from "./BannerRegion.module.css";

export function BannerRegion(): React.JSX.Element | null {
  const { notice, severity, dismiss, serverOffsetMs, bannerVisible } = useSystemNotice();
  const countdown = useNoticeCountdown(notice?.effectiveAtMs ?? null, serverOffsetMs);

  if (!bannerVisible || !notice || !severity) return null;

  const isCritical = severity === "critical";

  return (
    <div className={styles.banner} data-severity={severity} role={isCritical ? "alert" : "status"}>
      <Icon icon={isCritical ? OctagonAlert : AlertTriangle} size="dense" aria-hidden />
      <div className={styles.text}>
        <span className={styles.message}>{notice.message}</span>
        {countdown && (
          <span className={styles.countdown}>
            {countdown.due ? "Restarting now" : `Restarting in ${defaultFormatTime(countdown.remainingMs)}`}
          </span>
        )}
      </div>
      {/* Critical: NO dismiss affordance while active (N3). */}
      {!isCritical && (
        <button type="button" className={styles.dismiss} aria-label="Dismiss notice" onClick={dismiss}>
          <Icon icon={X} size="dense" />
        </button>
      )}
    </div>
  );
}
