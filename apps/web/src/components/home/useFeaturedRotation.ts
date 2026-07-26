// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/home/useFeaturedRotation.ts
//
// Thin React wiring around lib/featured-rotation.ts's FeaturedRotationScheduler
// (the actual dwell/crossfade/pause state machine — kept there so it's
// unit-testable with fake timers, no DOM). This hook owns exactly the
// three real, ground-truthed "pause" inputs (see the scheduler's own header
// for the full signal ledger):
//   - prefers-reduced-motion, via the existing shared useMediaQuery hook
//     (components/ui/use-media-query.ts) — real, already used elsewhere.
//   - the music mini player's queue drawer, via useMusicPlayer()'s
//     `queueDrawerOpen` — a REAL, already-exported global boolean
//     (components/music/MusicPlayerProvider.tsx), legitimately an "a
//     sheet is open on top of Home" signal since the mini player/queue
//     drawer persists across navigation.
//   - pointer hover, exposed as `setHovering` for FeaturedBanner to wire
//     to onMouseEnter/onMouseLeave.
//
// "Any modal is open" and "the command palette is open" are NOT wired
// here: there is no cross-cutting registry for either in this codebase
// today (every sheet/modal/dialog tracks its own open boolean locally,
// and no command palette exists at all yet) — see the freeze report.
// "The player is open" needs no handling here either: /watch/{id} is a
// full route navigation away from /home, so this hook (and the whole
// Home tree) unmounts before any player state could exist.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../ui/use-media-query.js";
import { useMusicPlayer } from "../music/MusicPlayerProvider.js";
import { FeaturedRotationScheduler, type FeaturedRotationSnapshot } from "../../lib/featured-rotation.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface FeaturedRotationHandle extends FeaturedRotationSnapshot {
  controlClusterVisible: boolean;
  next: () => void;
  prev: () => void;
  jumpTo: (index: number) => void;
  setHovering: (hovering: boolean) => void;
}

export function useFeaturedRotation(poolLength: number): FeaturedRotationHandle {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const { queueDrawerOpen } = useMusicPlayer();

  const [snapshot, setSnapshot] = useState<FeaturedRotationSnapshot>({
    activeIndex: 0,
    previousIndex: null,
    crossfading: false,
  });
  const [controlClusterVisible, setControlClusterVisible] = useState(poolLength > 1);

  const schedulerRef = useRef<FeaturedRotationScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = new FeaturedRotationScheduler({
      poolLength,
      onChange: (next) => setSnapshot(next),
    });
  }

  useEffect(() => {
    const scheduler = schedulerRef.current!;
    scheduler.start();
    return () => scheduler.stop();
    // Mount/unmount only (deliberately empty deps — the scheduler instance
    // is stable for this component's lifetime) — Home unmounting (e.g.
    // navigating to /watch) is exactly the "player open" case this hook
    // doesn't otherwise handle; stop() here is what makes that safe.
  }, []);

  useEffect(() => {
    const scheduler = schedulerRef.current!;
    scheduler.setPoolLength(poolLength);
    setControlClusterVisible(scheduler.isControlClusterVisible());
  }, [poolLength]);

  useEffect(() => {
    schedulerRef.current!.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    schedulerRef.current!.setOverlayPaused(queueDrawerOpen);
  }, [queueDrawerOpen]);

  return useMemo(
    () => ({
      ...snapshot,
      controlClusterVisible,
      next: () => schedulerRef.current!.next(),
      prev: () => schedulerRef.current!.prev(),
      jumpTo: (index: number) => schedulerRef.current!.jumpTo(index),
      setHovering: (hovering: boolean) => schedulerRef.current!.setHoverPaused(hovering),
    }),
    [snapshot, controlClusterVisible],
  );
}
