// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/use-watched-state.ts
//
// Single source of truth for an item's watched state (real PUT /progress/
// {itemId}, see MarkWatchedButton.tsx's header for the ground-truth
// reasoning). Factored OUT of that component so MovieDetailScreen.tsx can
// call it once and hand the same state + toggle down to BOTH the desktop
// and mobile action rows — those two trees coexist in the DOM (CSS-swapped
// at the breakpoint, same convention as AppShell's sidebar/mobile chrome),
// so a self-fetching button component would double the real
// GET /progress/{itemId} network call on every page load and risk the two
// instances' optimistic state drifting apart. One hook, one fetch, one
// source of truth; MarkWatchedButton is a plain controlled component.

import { useEffect, useState } from "react";
import { apiPut, LoombreApiError } from "./api-client.js";
import { findProgressForItem } from "./progress-lookup.js";
import { useToast } from "../components/ui/Toast.js";

export type WatchedState = "loading" | "unwatched" | "watched";

export interface UseWatchedStateResult {
  state: WatchedState;
  busy: boolean;
  toggle: () => void;
}

/** `itemId: null` is the "not ready yet" case (e.g. the item is still
 *  loading) — lets a caller call this hook unconditionally at the top of
 *  its component (React's rules-of-hooks) even before it has a real id,
 *  without firing a wasted fetch. */
export function useWatchedState(itemId: string | null, runtimeMs: number | null): UseWatchedStateResult {
  const [state, setState] = useState<WatchedState>("loading");
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (itemId === null) return;
    let cancelled = false;
    setState("loading");
    findProgressForItem(itemId)
      .then((progress) => {
        if (cancelled) return;
        setState(progress?.state === "played" ? "watched" : "unwatched");
      })
      .catch(() => {
        if (!cancelled) setState("unwatched");
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  function toggle(): void {
    if (itemId === null || busy || state === "loading") return;
    const markingWatched = state !== "watched";
    const previous = state;
    setBusy(true);
    setState(markingWatched ? "watched" : "unwatched"); // optimistic

    apiPut("/progress/{itemId}", {
      params: { path: { itemId } },
      body: {
        state: markingWatched ? "played" : "unplayed",
        positionMs: markingWatched ? (runtimeMs ?? 0) : 0,
        durationMs: runtimeMs,
      },
    })
      .then(() => {
        showToast(markingWatched ? "MARKED WATCHED · SYNCED TO ALL DEVICES" : "MARKED UNWATCHED · SYNCED TO ALL DEVICES");
      })
      .catch((err: unknown) => {
        setState(previous); // revert on failure — never leave the UI claiming an unconfirmed state
        const message = err instanceof LoombreApiError ? err.message : "Could not update watched status";
        showToast(message, { variant: "danger" });
      })
      .finally(() => setBusy(false));
  }

  return { state, busy, toggle };
}
