// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/notices/useNoticeCountdown.ts
//
// Shared per-second countdown ticker for BannerRegion + NoticeOverlayStrip
// (N4): both render "... in 4:32" against a notice's `effectiveAtMs`,
// offset-corrected per NG3 (notice-time.ts), switching to a static "due"
// state at zero. A timer, not a poll (N4's own phrasing) — one
// setInterval(1000) per mounted consumer, cleared on unmount or once
// `effectiveAtMs` stops being set.

import { useEffect, useState } from "react";
import { remainingMs } from "./notice-time.js";

export interface NoticeCountdown {
  remainingMs: number;
  /** True once the countdown target has been reached — callers render a
   *  static "restarting now"-class state instead of a ticking number
   *  (N4: the notice system never restarts anything itself). */
  due: boolean;
}

const TICK_MS = 1000;

/** `effectiveAtMs === null` -> this notice carries no scheduled moment
 *  (N1) -> returns `null` so callers render no countdown UI at all. */
export function useNoticeCountdown(effectiveAtMs: number | null, serverOffsetMs: number): NoticeCountdown | null {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (effectiveAtMs === null) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [effectiveAtMs]);

  if (effectiveAtMs === null) return null;
  const remaining = remainingMs(effectiveAtMs, serverOffsetMs, nowMs);
  return { remainingMs: remaining, due: remaining <= 0 };
}
