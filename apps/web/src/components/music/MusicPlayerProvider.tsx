// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/music/MusicPlayerProvider.tsx
//
// P2.5 music playback: HTML5 <audio> direct-play, persistent across
// navigation (mounted once by AppProviders — see that file's header for why
// this MUST live above Next's per-route layout remount boundary), queue
// management (lib/queue.ts), and GAPLESS dual-<audio> chaining (lib/
// gapless.ts's pure state machine drives which of two real <audio> elements
// is "active" vs "preloading").
//
// One playback SESSION per queued track (POST /playback/sessions is keyed
// by itemId — there is no "queue" concept server-side): a session is
// created when a track becomes active, and again ahead of time for the
// next track once playback crosses the near-end threshold (preload). The
// just-finished track's session is ended as soon as its slot is reused.
//
// Gapless handoff sequence, matched to lib/gapless.ts's reducer:
//   1. `timeupdate` on the active element crosses shouldPreload() ->
//      create a session for peekNextTrack(), load it (but do not play) into
//      the OTHER slot, dispatch PRELOAD_NEXT.
//   2. `ended` on the active element:
//        - if the other slot is already loaded with exactly the next
//          queued track -> flip active (TRACK_ENDED) AND advance the queue
//          in the same tick, then .play() the now-active element — this is
//          the gapless path (near-zero JS-scheduling gap; see the wave
//          report for the measured number from a real browser run).
//        - otherwise (queue advanced faster than the threshold, or nothing
//          to preload) -> advance the queue only; the "current track
//          changed but active slot doesn't hold it" effect below falls back
//          to a fresh (non-gapless) load in the SAME slot.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  currentTrack,
  peekNextTrack,
  queueReducer,
  initialQueueState,
  type QueueState,
  type QueueTrack,
} from "../../lib/queue.js";
import { gaplessReducer, initialGaplessState, otherSlot, shouldPreload, type Slot } from "../../lib/gapless.js";
import { createDirectPlaySession, endPlaybackSession } from "../../lib/playback-session.js";
import { buildSessionFileUrl } from "../../lib/media-session-url.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { HeartbeatScheduler, type HeartbeatSnapshot, type ProgressState } from "../../lib/heartbeat.js";
import { reportProgressOnUnload } from "../../lib/progress-report.js";
import { apiPut } from "../../lib/api-client.js";

export interface PlayableTrackInput {
  itemId: string;
  title: string;
  subtitle?: string | null;
  albumId?: string | null;
  durationMs?: number | null;
  blurhash?: string | null;
}

function toQueueTrack(input: PlayableTrackInput): QueueTrack {
  return {
    entryId: (globalThis.crypto?.randomUUID?.() ?? `${input.itemId}-${Date.now()}-${Math.random()}`),
    itemId: input.itemId,
    title: input.title,
    subtitle: input.subtitle ?? null,
    albumId: input.albumId ?? null,
    durationMs: input.durationMs ?? null,
    blurhash: input.blurhash ?? null,
  };
}

export interface MusicPlayerContextValue {
  queueState: QueueState;
  current: QueueTrack | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number | null;
  volume: number;
  muted: boolean;
  queueDrawerOpen: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (ms: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  playTrack: (track: PlayableTrackInput) => void;
  playQueue: (tracks: PlayableTrackInput[], startIndex?: number) => void;
  enqueue: (track: PlayableTrackInput) => void;
  removeFromQueue: (entryId: string) => void;
  reorderQueue: (from: number, to: number) => void;
  jumpTo: (entryId: string) => void;
  openQueueDrawer: () => void;
  closeQueueDrawer: () => void;
}

// Exported (not just the hook) so component tests can render a consumer
// (QueueDrawer, MiniPlayerBar, TrackRow's equalizer) against a hand-built
// MusicPlayerContextValue directly — this provider's real playQueue/
// playTrack drive actual <audio> sessions via createDirectPlaySession's
// network call, which a pure render test has no business exercising.
export const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);

export function MusicPlayerProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [queueState, dispatchQueue] = useReducer(queueReducer, initialQueueState);
  const [gaplessState, dispatchGapless] = useReducer(gaplessReducer, initialGaplessState);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMsState] = useState<number | null>(null);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);

  const audioA = useRef<HTMLAudioElement>(null);
  const audioB = useRef<HTMLAudioElement>(null);
  const refs = useMemo(() => ({ A: audioA, B: audioB }) satisfies Record<Slot, React.RefObject<HTMLAudioElement | null>>, []);

  const gaplessStateRef = useRef(gaplessState);
  gaplessStateRef.current = gaplessState;
  const queueStateRef = useRef(queueState);
  queueStateRef.current = queueState;

  const sessionsRef = useRef<Map<Slot, { sessionId: string; itemId: string }>>(new Map());
  const loadTokenRef = useRef(0);
  const heartbeatRef = useRef<HeartbeatScheduler | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef<number | null>(null);
  const progressStateRef = useRef<ProgressState>("in-progress");

  function activeAudio(): HTMLAudioElement | null {
    return refs[gaplessStateRef.current.active].current;
  }

  const endSlotSession = useCallback((slot: Slot) => {
    const entry = sessionsRef.current.get(slot);
    if (entry) {
      sessionsRef.current.delete(slot);
      void endPlaybackSession(entry.sessionId);
    }
  }, []);

  const stopHeartbeat = useCallback((flush: boolean) => {
    if (heartbeatRef.current) {
      if (flush) heartbeatRef.current.flushNow();
      heartbeatRef.current.stop();
      heartbeatRef.current = null;
    }
  }, []);

  const startHeartbeatFor = useCallback((itemId: string, sessionId: string) => {
    stopHeartbeat(false);
    heartbeatRef.current = new HeartbeatScheduler({
      getSnapshot: (): HeartbeatSnapshot => ({
        positionMs: positionRef.current,
        durationMs: durationRef.current,
        state: progressStateRef.current,
      }),
      send: (snapshot) => {
        void apiPut("/progress/{itemId}", {
          params: { path: { itemId } },
          body: { positionMs: Math.round(snapshot.positionMs), durationMs: snapshot.durationMs, state: snapshot.state, sessionId },
        }).catch(() => {
          /* best-effort heartbeat */
        });
      },
    });
    heartbeatRef.current.start();
  }, [stopHeartbeat]);

  /** Loads `track` fresh into `slot` (creates a new session), optionally
   *  autoplaying once ready. Used for: first play, manual skip/prev/jump,
   *  and the non-gapless fallback when a preload wasn't ready in time. */
  const loadIntoSlot = useCallback(
    async (slot: Slot, track: QueueTrack, opts: { autoplay: boolean; preloadOnly?: boolean }) => {
      const myToken = ++loadTokenRef.current;
      // Music-scoped interim shim (Phase 3 Step 6c): direct-play only —
      // see lib/playback-session.ts's createDirectPlaySession header for
      // the "music HLS transcode playback" open item.
      const result = await createDirectPlaySession(track.itemId);
      if (myToken !== loadTokenRef.current) return; // superseded by a later load

      if (!result.ok) {
        // Music has no dedicated unavailable-state surface (that's the
        // video player's deliverable 2); best-effort: skip this track.
        console.warn(`[music] track ${track.itemId} unavailable for direct-play, skipping`, result.wouldBeReasons);
        endSlotSession(slot);
        if (!opts.preloadOnly) dispatchQueue({ type: "NEXT" });
        return;
      }

      endSlotSession(slot);
      sessionsRef.current.set(slot, { sessionId: result.session.id, itemId: track.itemId });

      const el = refs[slot].current;
      const serverUrl = getAuthStore().getSnapshot().serverUrl;
      const token = await getAuthStore().getAccessToken();
      if (myToken !== loadTokenRef.current || !el || !token) return;

      el.src = buildSessionFileUrl(serverUrl, result.session.id, token);
      el.load();

      if (opts.preloadOnly) {
        dispatchGapless({ type: "PRELOAD_NEXT", trackId: track.itemId });
        return;
      }

      dispatchGapless({ type: "LOAD_ACTIVE", trackId: track.itemId });
      durationRef.current = track.durationMs ?? null;
      setDurationMsState(track.durationMs ?? null);
      positionRef.current = 0;
      setPositionMs(0);
      progressStateRef.current = "in-progress";
      startHeartbeatFor(track.itemId, result.session.id);
      if (opts.autoplay) {
        el.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      }
    },
    [refs, endSlotSession, startHeartbeatFor],
  );

  // Keep both elements' volume/muted in sync regardless of which is active.
  useEffect(() => {
    for (const slot of ["A", "B"] as const) {
      const el = refs[slot].current;
      if (el) {
        el.volume = volume;
        el.muted = muted;
      }
    }
  }, [refs, volume, muted]);

  // When the queue's current track changes and the active slot doesn't
  // already hold it (gapless handoff not applicable), load it fresh.
  useEffect(() => {
    const track = currentTrack(queueState);
    if (!track) {
      activeAudio()?.pause();
      setIsPlaying(false);
      stopHeartbeat(true);
      return;
    }
    if (gaplessState.loaded[gaplessState.active] === track.itemId) return; // already there (gapless handoff already placed it)
    void loadIntoSlot(gaplessState.active, track, { autoplay: true });
  }, [queueState.currentIndex, queueState.items.length]);

  // Per-element event wiring (timeupdate for preload trigger + position,
  // loadedmetadata for duration, ended for gapless handoff / advance).
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    for (const slot of ["A", "B"] as const) {
      const el = refs[slot].current;
      if (!el) continue;

      const onTimeUpdate = (): void => {
        if (gaplessStateRef.current.active !== slot) return;
        const posMs = el.currentTime * 1000;
        positionRef.current = posMs;
        setPositionMs(posMs);

        if (!gaplessStateRef.current.preloadPending) {
          const dur = durationRef.current ?? (Number.isFinite(el.duration) ? el.duration * 1000 : null);
          if (shouldPreload(posMs, dur)) {
            const next = peekNextTrack(queueStateRef.current);
            if (next && gaplessStateRef.current.loaded[otherSlot(slot)] !== next.itemId) {
              void loadIntoSlot(otherSlot(slot), next, { autoplay: false, preloadOnly: true });
            }
          }
        }
      };

      const onLoadedMetadata = (): void => {
        if (gaplessStateRef.current.active !== slot || !Number.isFinite(el.duration)) return;
        durationRef.current = el.duration * 1000;
        setDurationMsState(el.duration * 1000);
      };

      const onEnded = (): void => {
        if (gaplessStateRef.current.active !== slot) return;
        progressStateRef.current = "played";
        stopHeartbeat(true);

        const next = peekNextTrack(queueStateRef.current);
        const nextSlot = otherSlot(slot);
        const nextIsPreloaded = next !== null && gaplessStateRef.current.loaded[nextSlot] === next.itemId;

        if (next && nextIsPreloaded) {
          const nextEl = refs[nextSlot].current;
          dispatchGapless({ type: "TRACK_ENDED" });
          dispatchQueue({ type: "NEXT" });
          durationRef.current = next.durationMs ?? null;
          setDurationMsState(next.durationMs ?? null);
          positionRef.current = 0;
          setPositionMs(0);
          progressStateRef.current = "in-progress";
          const session = sessionsRef.current.get(nextSlot);
          if (session) startHeartbeatFor(next.itemId, session.sessionId);
          nextEl?.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
        } else {
          dispatchQueue({ type: "NEXT" }); // effect above handles the (non-gapless) load-or-stop
        }
      };

      const onPlay = (): void => {
        if (gaplessStateRef.current.active === slot) setIsPlaying(true);
      };
      const onPause = (): void => {
        if (gaplessStateRef.current.active === slot) {
          setIsPlaying(false);
          heartbeatRef.current?.flushNow();
        }
      };

      el.addEventListener("timeupdate", onTimeUpdate);
      el.addEventListener("loadedmetadata", onLoadedMetadata);
      el.addEventListener("ended", onEnded);
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      cleanups.push(() => {
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("loadedmetadata", onLoadedMetadata);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  // Flush a heartbeat reliably on tab/app teardown.
  useEffect(() => {
    function onUnload(): void {
      const track = currentTrack(queueStateRef.current);
      const session = sessionsRef.current.get(gaplessStateRef.current.active);
      if (!track || !session) return;
      reportProgressOnUnload(
        { serverUrl: getAuthStore().getSnapshot().serverUrl, itemId: track.itemId, sessionId: session.sessionId },
        { positionMs: positionRef.current, durationMs: durationRef.current, state: progressStateRef.current },
      );
    }
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, []);

  // End every tracked session if the provider itself ever unmounts (app
  // teardown — this component lives above the route layout by design, so
  // in practice this only fires on a full page close, which pagehide above
  // already covers for progress; this covers explicit session cleanup).
  useEffect(() => {
    return () => {
      for (const slot of ["A", "B"] as const) endSlotSession(slot);
    };
  }, []);

  const play = useCallback(() => {
    activeAudio()?.play().catch(() => undefined);
  }, []);
  const pause = useCallback(() => {
    activeAudio()?.pause();
  }, []);
  const toggle = useCallback(() => {
    const el = activeAudio();
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);
  const next = useCallback(() => dispatchQueue({ type: "NEXT" }), []);
  const prev = useCallback(() => dispatchQueue({ type: "PREV" }), []);
  const seekTo = useCallback((ms: number) => {
    const el = activeAudio();
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    positionRef.current = ms;
    setPositionMs(ms);
    heartbeatRef.current?.flushNow();
  }, []);
  const setVolume = useCallback((v: number) => setVolumeState(Math.min(1, Math.max(0, v))), []);
  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const playTrack = useCallback((track: PlayableTrackInput) => {
    dispatchQueue({ type: "SET_QUEUE", tracks: [toQueueTrack(track)], startIndex: 0 });
    dispatchGapless({ type: "RESET" });
  }, []);
  const playQueue = useCallback((tracks: PlayableTrackInput[], startIndex = 0) => {
    dispatchQueue({ type: "SET_QUEUE", tracks: tracks.map(toQueueTrack), startIndex });
    dispatchGapless({ type: "RESET" });
  }, []);
  const enqueue = useCallback((track: PlayableTrackInput) => dispatchQueue({ type: "ENQUEUE", track: toQueueTrack(track) }), []);
  const removeFromQueue = useCallback((entryId: string) => dispatchQueue({ type: "REMOVE", entryId }), []);
  const reorderQueue = useCallback((from: number, to: number) => dispatchQueue({ type: "REORDER", from, to }), []);
  const jumpTo = useCallback((entryId: string) => dispatchQueue({ type: "JUMP_TO", entryId }), []);
  const openQueueDrawer = useCallback(() => setQueueDrawerOpen(true), []);
  const closeQueueDrawer = useCallback(() => setQueueDrawerOpen(false), []);

  const value = useMemo<MusicPlayerContextValue>(
    () => ({
      queueState,
      current: currentTrack(queueState),
      isPlaying,
      positionMs,
      durationMs,
      volume,
      muted,
      queueDrawerOpen,
      play,
      pause,
      toggle,
      next,
      prev,
      seekTo,
      setVolume,
      toggleMute,
      playTrack,
      playQueue,
      enqueue,
      removeFromQueue,
      reorderQueue,
      jumpTo,
      openQueueDrawer,
      closeQueueDrawer,
    }),
    [
      queueState,
      isPlaying,
      positionMs,
      durationMs,
      volume,
      muted,
      queueDrawerOpen,
      play,
      pause,
      toggle,
      next,
      prev,
      seekTo,
      setVolume,
      toggleMute,
      playTrack,
      playQueue,
      enqueue,
      removeFromQueue,
      reorderQueue,
      jumpTo,
      openQueueDrawer,
      closeQueueDrawer,
    ],
  );

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}
      {/* Both elements always mounted (never conditionally, or the dual-
          buffer preload trick doesn't work) — visually hidden, not
          `display:none` (some browsers pause decode of display:none media). */}
      <audio ref={audioA} preload="auto" style={{ position: "fixed", width: 0, height: 0, opacity: 0, pointerEvents: "none" }} />
      <audio ref={audioB} preload="auto" style={{ position: "fixed", width: 0, height: 0, opacity: 0, pointerEvents: "none" }} />
    </MusicPlayerContext.Provider>
  );
}

export function useMusicPlayer(): MusicPlayerContextValue {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) throw new Error("useMusicPlayer() called outside <MusicPlayerProvider>");
  return ctx;
}
