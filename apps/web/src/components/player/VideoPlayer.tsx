// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/VideoPlayer.tsx
//
// Deliverable 1 (P2.4) shipped native-only playback, deliberately structured
// so an hls.js path could slot in later without rework: the old
// `attachMediaSource()` seam was the ONE place that decided how
// `<video>.src` got set, branching on `session.manifestUrl`. Phase 3 §11
// step 6c fills that seam in for real: `attachStrategy` (lib/hls-attach.ts)
// now decides among THREE paths — direct-play (unchanged), Safari-native
// HLS (`video.src` = the manifest URL directly, same as direct-play
// mechanically), and hls.js (dynamically imported ONLY here, never on the
// browse route — perf-web-budget.mjs's browse-route JS budget is
// unaffected by this file).
//
// Flow: fetch item summary (title/backdrop) -> POST /playback/sessions
// directly (no more Step 6b plan-preview short-circuit — see
// lib/playback-session.ts's header for why) -> a real 409/422/429 renders
// UnavailableScreen; anything else attaches per `attachStrategy` -> look up
// existing progress -> resume prompt or autoplay -> wire controls/keyboard/
// heartbeat/token-refresh -> DELETE the session on unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { components } from "@loombre/sdk";
import { fetchItemSummary, backdropImage, type ItemSummary } from "../../lib/item-lookup.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { createPlaybackSession, endPlaybackSession } from "../../lib/playback-session.js";
import {
  appendTokenParam,
  buildHlsManifestUrl,
  buildHlsSubtitleUrl,
  useHlsManifestUrl,
  useSessionFileUrl,
} from "../../lib/media-session-url.js";
import { decideAttachStrategy, isMseAvailable, isNativeHlsSupported } from "../../lib/hls-attach.js";
import { buildHlsJsConfig } from "../../lib/hls-js-config.js";
import { deriveSubtitleTrackInfo, type SubtitleTrackInfo } from "../../lib/subtitle-track.js";
import { resolveUnavailableReasons } from "../../lib/playback-reasons.js";
import { findPlayableFallback, decisionLabel, type FallbackCandidate } from "../../lib/playback-fallback.js";
import { findProgressForItem, isWorthResuming } from "../../lib/progress-lookup.js";
import { HeartbeatScheduler, type HeartbeatSnapshot, type ProgressState } from "../../lib/heartbeat.js";
import { reportProgressOnUnload } from "../../lib/progress-report.js";
import { apiPut } from "../../lib/api-client.js";
import { useToast } from "../ui/Toast.js";
import { AmbientBackdrop } from "./AmbientBackdrop.js";
import { UnavailableScreen } from "./UnavailableScreen.js";
import { ResumePrompt } from "./ResumePrompt.js";
import { PlayerControls } from "./PlayerControls.js";
import { applyAudioTrackSelection } from "./TrackPickers.js";
import type { BufferedRange } from "./Scrubber.js";
import styles from "./VideoPlayer.module.css";

type PlaybackSession = components["schemas"]["PlaybackSession"];
type PlanReason = components["schemas"]["PlanReason"];
// `hls.js`'s own instance type, for the ref only — a TYPE-ONLY import is
// erased at compile time (no runtime module load, confirmed against this
// app's SWC build output), so this does NOT pull hls.js into any bundle;
// only the dynamic `await import("hls.js")` inside the attach effect below
// does that, and only once a session actually needs it.
type HlsInstance = import("hls.js").default;

type Phase = "loading" | "unavailable" | "ready";

const IDLE_HIDE_MS = 3000;

export interface VideoPlayerProps {
  itemId: string;
  hintType?: string;
  onBack: () => void;
}

function readBuffered(video: HTMLVideoElement): BufferedRange[] {
  const ranges: BufferedRange[] = [];
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push({ startMs: video.buffered.start(i) * 1000, endMs: video.buffered.end(i) * 1000 });
  }
  return ranges;
}

export function VideoPlayer({ itemId, hintType, onBack }: VideoPlayerProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [item, setItem] = useState<ItemSummary | null>(null);
  const [unavailableReasons, setUnavailableReasons] = useState<PlanReason[]>([]);
  const [unavailableStatus, setUnavailableStatus] = useState<number | undefined>(undefined);
  const [fallback, setFallback] = useState<FallbackCandidate | null>(null);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [resumeCandidateMs, setResumeCandidateMs] = useState<number | null>(null);
  const [awaitingResumeChoice, setAwaitingResumeChoice] = useState(false);
  const { showToast } = useToast();

  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  // The <video> element tracked in STATE (not only the ref) so effects can
  // depend on "is the element mounted yet". A ref alone can't do this: it
  // mutates without triggering a re-render, so an effect keyed on the
  // token-URL can run while videoRef.current is still null (the element
  // mounts on the same ready render, but the URL resolves a tick later) and
  // then never re-run — the exact bug that left src unattached and playback
  // silently dead (Wave-2 browser E2E). A callback ref flips this state the
  // instant the element attaches/detaches, so the src-attach effect re-runs
  // for real once BOTH the element and the URL exist.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setVideoEl(node);
  }, []);
  const stageRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<HeartbeatScheduler | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef<number | null>(null);
  const progressStateRef = useRef<ProgressState>("in-progress");
  const pendingSeekMsRef = useRef<number | null>(null);
  // Mirrors `awaitingResumeChoice` for the hls.js attach effect below: that
  // effect must NOT re-run (tearing down and recreating the whole Hls
  // instance) merely because the resume-prompt choice flips — it only
  // needs the LATEST value at the moment its one-shot `loadedmetadata`
  // handler actually fires. The direct-play/native-hls effect doesn't need
  // this (it already no-ops via its own `currentSrc === activeSrcUrl`
  // guard on a re-run), so only this ref exists for the hls.js path.
  const awaitingResumeChoiceRef = useRef(false);
  const hlsRef = useRef<HlsInstance | null>(null);

  const serverUrl = getAuthStore().getSnapshot().serverUrl;

  // ── Step 1: item metadata + ambient imagery ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void fetchItemSummary(itemId, hintType).then((summary) => {
      if (!cancelled) setItem(summary);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [itemId, hintType]);

  // ── Step 2: session create (or unavailable) ─────────────────────────────
  // Phase 3 Step 6c: no more plan-preview short-circuit (lib/playback-
  // session.ts's header) — go straight to session create and branch on the
  // REAL session. Only a genuine 409 (unplayable)/422/429 renders
  // UnavailableScreen now; direct-stream/remux/transcode all proceed to the
  // attach-strategy effects below.
  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const result = await createPlaybackSession(itemId);
      if (cancelled) return;
      if (!result.ok) {
        setUnavailableReasons(resolveUnavailableReasons(result.status, result.wouldBeReasons));
        setUnavailableStatus(result.status);
        setPhase("unavailable");
        return;
      }
      setSession(result.session);
      setDurationMs(result.session.media?.durationMs ?? null);
      durationRef.current = result.session.media?.durationMs ?? null;
      const defaultAudio = result.session.media?.audio.find((a) => a.isDefault) ?? result.session.media?.audio[0];
      if (defaultAudio) setSelectedAudioIndex(defaultAudio.index);

      const existing = await findProgressForItem(itemId).catch(() => null);
      if (cancelled) return;
      if (existing && isWorthResuming(existing)) {
        setResumeCandidateMs(existing.positionMs);
        setAwaitingResumeChoice(true);
      } else {
        setAwaitingResumeChoice(false);
      }
      setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // ── Session end on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (session) void endPlaybackSession(session.id);
    };
  }, [session?.id]);

  // ── Playback-refusal fallback lookup (Phosphor W2 lane L5) ──────────────
  // Real alternate-version discovery (lib/playback-fallback.ts) once the
  // item's own media-file list is known AND the primary attempt has been
  // refused. Read-only (POST /playback/plan previews only, against every
  // file the item has) — nothing plays until the user explicitly accepts
  // (handleAcceptFallback below). `item.mediaFiles` is `[]` for the common
  // one-file-per-item case, so this resolves to `null` immediately then.
  useEffect(() => {
    if (phase !== "unavailable" || !item) return undefined;
    let cancelled = false;
    void findPlayableFallback(itemId, item.mediaFiles).then((candidate) => {
      if (!cancelled) setFallback(candidate);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, item, itemId]);

  // ── Media attach: direct-play vs HLS (native vs hls.js) ─────────────────
  // decideAttachStrategy (lib/hls-attach.ts) is the ONE place that decides
  // how the <video> element gets its media — see that module's truth
  // table. `canPlayNativeHls` only matters once `videoEl` mounts (its
  // `canPlayType` answer is a property of the browser, not of the
  // particular element instance, but it can only be asked once a real
  // element exists).
  const usesHls = session?.manifestUrl != null;
  const canPlayNativeHls = videoEl ? isNativeHlsSupported(videoEl.canPlayType("application/vnd.apple.mpegurl")) : false;
  // MSE-first ordering (step 7 owner-smoke finding — see hls-attach.ts's
  // ORDER RATIONALE): Chrome answers "maybe" to the Apple-HLS canPlayType
  // probe with no working native HLS behind it.
  const mseAvailable = typeof window !== "undefined" ? isMseAvailable(window) : false;
  const attachStrategy = decideAttachStrategy(usesHls, mseAvailable, canPlayNativeHls);

  awaitingResumeChoiceRef.current = awaitingResumeChoice;

  // Direct-play's own token-refreshing URL (P2.13/P2.18, unchanged), and
  // the Safari-native HLS manifest URL (Phase 3 Step 6c) — both null
  // unless THIS session actually needs that particular strategy, so only
  // one of the two hooks is ever "live" for a given session.
  const directPlayUrl = useSessionFileUrl(serverUrl, attachStrategy === "direct-play" ? (session?.id ?? null) : null);
  const hlsManifestUrl = useHlsManifestUrl(serverUrl, attachStrategy === "native-hls" ? (session?.id ?? null) : null);

  // Direct-play and Safari-native HLS are mechanically IDENTICAL from here
  // on — both are just "assign video.src to a token-bearing URL and wait
  // for loadedmetadata to resume/autoplay" (Safari's native HLS engine
  // handles the manifest polling and segment fetching itself, propagating
  // the manifest URL's own `?token=` onto every sub-request it makes for
  // that same playback — see lib/media-session-url.ts's header for why
  // that's true for Safari but NOT for hls.js below). One effect covers
  // both; the hls.js branch is handled entirely separately since it has no
  // `video.src` to assign at all.
  const activeSrcUrl = attachStrategy === "direct-play" ? directPlayUrl : attachStrategy === "native-hls" ? hlsManifestUrl : null;

  useEffect(() => {
    const video = videoEl;
    if (!video || !activeSrcUrl) return;

    const wasPlaying = !video.paused;
    const currentSrc = video.src;
    if (currentSrc === activeSrcUrl) return; // no-op on first render duplicate

    const resumeAt = currentSrc ? video.currentTime : (pendingSeekMsRef.current ?? 0) / 1000;
    video.src = activeSrcUrl;
    video.load();
    const onLoaded = (): void => {
      video.currentTime = resumeAt;
      if (wasPlaying || (!currentSrc && !awaitingResumeChoice)) void video.play().catch(() => undefined);
      video.removeEventListener("loadedmetadata", onLoaded);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    // Depends on `videoEl` (STATE, not the ref) so this re-runs the moment the
    // element mounts — activeSrcUrl frequently resolves a tick before the
    // <video> attaches, and a ref-only dependency would miss that mount.
  }, [activeSrcUrl, videoEl, awaitingResumeChoice]);

  // ── Media attach: hls.js (Phase 3 Step 6c) ──────────────────────────────
  // Dynamically imported — this is the ONLY place hls.js is ever imported
  // in apps/web, and only inside this effect body (never at module top
  // level), so the browse route's bundle never sees it (perf-web-budget.mjs
  // only measures /browse's first-load JS, which doesn't touch this file at
  // all). Runs only when `attachStrategy === 'hlsjs'` (non-WebKit browsers
  // playing a direct-stream/remux/transcode session).
  useEffect(() => {
    const video = videoEl;
    if (!video || attachStrategy !== "hlsjs" || !session?.id) return;

    let cancelled = false;
    let hls: HlsInstance | null = null;
    let onLoaded: (() => void) | null = null;

    void (async () => {
      const initialToken = await getAuthStore().getAccessToken();
      if (cancelled || !initialToken) return;
      const manifestUrl = buildHlsManifestUrl(serverUrl, session.id, initialToken);

      const { default: HlsCtor } = await import("hls.js");
      if (cancelled) return;

      if (!HlsCtor.isSupported()) {
        // No MediaSource Extensions at all (very old/unusual browser) — no
        // native fallback exists either (decideAttachStrategy only reaches
        // 'hlsjs' when native HLS was already absent). Logged locally
        // only (D14 — no phone-home), nothing else this lane can do.
        console.error("[player] hls.js reports this browser cannot play HLS (no MediaSource support).");
        return;
      }

      hls = new HlsCtor(
        buildHlsJsConfig({
          // Re-checked on EVERY request (not just the first) so a token
          // rotating mid-playback (15-minute access-token lifetime,
          // lib/auth-store.ts) is picked up on the very next request.
          getToken: () => getAuthStore().getAccessToken(),
          appendToken: appendTokenParam,
        }),
      );
      hlsRef.current = hls;

      // hls.js's own documented fatal-error recovery pattern: retry a
      // network error in place, attempt MSE recovery for a media error,
      // and give up (destroy) for anything else.
      hls.on(HlsCtor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case HlsCtor.ErrorTypes.NETWORK_ERROR:
            hls?.startLoad();
            break;
          case HlsCtor.ErrorTypes.MEDIA_ERROR:
            hls?.recoverMediaError();
            break;
          default:
            hls?.destroy();
            break;
        }
      });

      // Fresh attach every time this effect runs (a new session, since
      // `session.id` is a dependency below) — never a src-swap-in-place
      // like the direct-play/native-hls effect, so `wasPlaying` is always
      // false and autoplay is governed purely by the resume-choice gate.
      const resumeAt = (pendingSeekMsRef.current ?? 0) / 1000;
      onLoaded = (): void => {
        video.currentTime = resumeAt;
        if (!awaitingResumeChoiceRef.current) void video.play().catch(() => undefined);
        if (onLoaded) video.removeEventListener("loadedmetadata", onLoaded);
      };
      video.addEventListener("loadedmetadata", onLoaded);

      // hls.js's own documented order: loadSource() before attachMedia().
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);
    })();

    return () => {
      cancelled = true;
      if (onLoaded) video.removeEventListener("loadedmetadata", onLoaded);
      hls?.destroy(); // deliverable 5: no leaked MediaSource on unmount/session change.
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [attachStrategy, videoEl, session?.id, serverUrl]);

  // ── Subtitles: the hls-vtt side-track (Phase 3 Step 6c, deliverable 3) ──
  // burn-in needs nothing (already baked into the video frames); embed/none
  // have no side-track to attach. Built once per session (a plain <track>
  // fetches its VTT file exactly once — no token-refresh loop needed the
  // way the long-lived HLS/direct-play URLs above need one).
  const [subtitleTrack, setSubtitleTrack] = useState<SubtitleTrackInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!session || session.plan.subtitle.strategy !== "hls-vtt") {
      setSubtitleTrack(null);
      return;
    }
    void (async () => {
      const token = await getAuthStore().getAccessToken();
      if (cancelled || !token) return;
      const url = buildHlsSubtitleUrl(serverUrl, session.id, token);
      setSubtitleTrack(
        deriveSubtitleTrackInfo(session.plan.subtitle.strategy, session.plan.subtitle.streamIndex, session.media?.subtitle ?? [], url),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [session, serverUrl]);

  // ── Heartbeat ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    heartbeatRef.current = new HeartbeatScheduler({
      getSnapshot: (): HeartbeatSnapshot => ({
        positionMs: positionRef.current,
        durationMs: durationRef.current,
        state: progressStateRef.current,
      }),
      send: (snapshot) => {
        void apiPut("/progress/{itemId}", {
          params: { path: { itemId } },
          body: {
            positionMs: Math.round(snapshot.positionMs),
            durationMs: snapshot.durationMs,
            state: snapshot.state,
            sessionId: session.id,
          },
        }).catch(() => undefined);
      },
    });
    return () => heartbeatRef.current?.stop();
  }, [session, itemId]);

  useEffect(() => {
    function onPageHide(): void {
      if (!session) return;
      reportProgressOnUnload(
        { serverUrl, itemId, sessionId: session.id },
        { positionMs: positionRef.current, durationMs: durationRef.current, state: progressStateRef.current },
      );
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [session, itemId, serverUrl]);

  // ── Video element event wiring ──────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = (): void => {
      const ms = video.currentTime * 1000;
      positionRef.current = ms;
      setPositionMs(ms);
      setBuffered(readBuffered(video));
    };
    const onLoadedMetadata = (): void => {
      if (Number.isFinite(video.duration)) {
        durationRef.current = video.duration * 1000;
        setDurationMs(video.duration * 1000);
      }
    };
    const onPlay = (): void => {
      setIsPlaying(true);
      progressStateRef.current = "in-progress";
      heartbeatRef.current?.start();
    };
    const onPause = (): void => {
      setIsPlaying(false);
      heartbeatRef.current?.stop();
      heartbeatRef.current?.flushNow();
    };
    const onEnded = (): void => {
      progressStateRef.current = "played";
      heartbeatRef.current?.flushNow();
      heartbeatRef.current?.stop();
    };
    const onWaiting = (): void => setBuffering(true);
    const onPlaying = (): void => setBuffering(false);
    const onVolumeChange = (): void => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [phase]);

  // ── Fullscreen ───────────────────────────────────────────────────────────
  useEffect(() => {
    function onChange(): void {
      setIsFullscreen(document.fullscreenElement === stageRef.current);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen();
  }, []);

  // ── Auto-hide controls ──────────────────────────────────────────────────
  const resetIdleTimer = useCallback(() => {
    setControlsVisible(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, IDLE_HIDE_MS);
  }, []);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  // ── Controls handlers ────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, ms / 1000);
    positionRef.current = ms;
    setPositionMs(ms);
    heartbeatRef.current?.flushNow();
  }, []);

  const seekRelative = useCallback(
    (deltaMs: number) => {
      const video = videoRef.current;
      if (!video) return;
      seek(Math.max(0, video.currentTime * 1000 + deltaMs));
    },
    [seek],
  );

  const setVolumeAndApply = useCallback((v: number) => {
    const video = videoRef.current;
    if (video) video.volume = Math.min(1, Math.max(0, v));
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, []);

  const selectAudio = useCallback((index: number) => {
    setSelectedAudioIndex(index);
    if (videoRef.current && session?.media) applyAudioTrackSelection(videoRef.current, index, session.media.audio);
  }, [session]);

  const selectSubtitle = useCallback((index: number | null) => setSelectedSubtitleIndex(index), []);

  // ── Keyboard shortcuts (space/arrows/f/m) ───────────────────────────────
  useEffect(() => {
    if (phase !== "ready") return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          // Wave 2 L7 (U7): matches PlayerControls' forward-30 button
          // exactly — see that file's header for why the amount changed
          // from a symmetric ±10s to the prototype's back-15/forward-30
          // (the seek buttons' numerals are baked into the glyph now, so
          // keyboard and click must agree on the actual amount).
          seekRelative(30_000);
          break;
        case "ArrowLeft":
          seekRelative(-15_000);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolumeAndApply((videoRef.current?.volume ?? 1) + 0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolumeAndApply((videoRef.current?.volume ?? 1) - 0.05);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        default:
          break;
      }
      resetIdleTimer();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, togglePlay, seekRelative, setVolumeAndApply, toggleFullscreen, toggleMute, resetIdleTimer]);

  const backdropUrl = useMemo(() => {
    if (!item) return null;
    const backdrop = backdropImage(item.images);
    if (!backdrop) return null;
    return buildImageUrl({
      serverUrl,
      accessToken: getAuthStore().getSnapshot().accessToken ?? "",
      entityType: item.itemType,
      entityId: item.id,
      kind: "backdrop",
      width: 1280,
    });
  }, [item, serverUrl]);

  const dominantColor = useMemo(() => {
    if (!item) return null;
    return backdropImage(item.images)?.dominantColor ?? null;
  }, [item]);

  function handleResume(): void {
    if (videoRef.current && resumeCandidateMs !== null) {
      videoRef.current.currentTime = resumeCandidateMs / 1000;
    }
    pendingSeekMsRef.current = resumeCandidateMs;
    setAwaitingResumeChoice(false);
    void videoRef.current?.play().catch(() => undefined);
  }
  function handleStartOver(): void {
    setAwaitingResumeChoice(false);
    void videoRef.current?.play().catch(() => undefined);
  }
  /** Escape/scrim-tap/the sheet's own Done button on the resume prompt —
   *  neither choice is auto-selected on an unstructured dismiss (see
   *  ResumePrompt.tsx's header), so this leaves the user exactly where they
   *  came from, same as the unavailable screen's Back control. */
  function handleDismissResume(): void {
    onBack();
  }

  /** Accepting a playback-refusal fallback (lib/playback-fallback.ts) —
   *  re-attempts session creation pinned to that specific alternate file.
   *  Never automatic: this only runs from the user's own tap on the
   *  fallback button (UnavailableScreen.tsx). A still-refused result (race:
   *  the file was removed, or policy changed, since the preview) stays on
   *  the unavailable screen with the FRESH real reasons — it never pretends
   *  the switch happened. */
  async function handleAcceptFallback(candidate: FallbackCandidate): Promise<void> {
    const result = await createPlaybackSession(itemId, "stream", candidate.mediaFileId);
    if (!result.ok) {
      setUnavailableReasons(resolveUnavailableReasons(result.status, result.wouldBeReasons));
      setUnavailableStatus(result.status);
      setFallback(null);
      return;
    }
    setSession(result.session);
    setDurationMs(result.session.media?.durationMs ?? null);
    durationRef.current = result.session.media?.durationMs ?? null;
    const defaultAudio = result.session.media?.audio.find((a) => a.isDefault) ?? result.session.media?.audio[0];
    if (defaultAudio) setSelectedAudioIndex(defaultAudio.index);
    setAwaitingResumeChoice(false);
    setUnavailableReasons([]);
    setFallback(null);
    // design/phosphor/README.md "Interactions & behavior -> Playback
    // refusal": "a toast confirms `SWITCHED TO 1080P SDR — DIRECT PLAY`"
    // (uppercase/mono come from Toast.module.css itself, never applied
    // here) — `candidate.label` and the decision are both real (the
    // former from the item's own MediaFileSummary, the latter from the
    // NEW session's own real plan.decision).
    showToast(`Switched to ${candidate.label} — ${decisionLabel(result.session.plan.decision)}`, { variant: "accent" });
    setPhase("ready");
  }

  if (phase === "unavailable") {
    return (
      <UnavailableScreen
        title={item?.title ?? "This item"}
        backdropUrl={backdropUrl}
        dominantColor={dominantColor}
        reasons={unavailableReasons}
        statusCode={unavailableStatus}
        fallback={fallback}
        onAcceptFallback={(candidate) => void handleAcceptFallback(candidate)}
        onBack={onBack}
      />
    );
  }

  const idle = !controlsVisible && isPlaying;

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      data-idle={idle}
      onMouseMove={resetIdleTimer}
      onTouchStart={resetIdleTimer}
    >
      {(phase === "loading" || (!isPlaying && positionMs === 0)) && <AmbientBackdrop imageUrl={backdropUrl} dominantColor={dominantColor} />}
      {phase === "loading" ? (
        <div className={styles.loading}>Preparing playback…</div>
      ) : (
        <>
          <video
            ref={setVideoNode}
            className={styles.video}
            data-visible={phase === "ready"}
            playsInline
            onClick={togglePlay}
          >
            {subtitleTrack && (
              <track
                kind="subtitles"
                src={subtitleTrack.src}
                label={subtitleTrack.label}
                {...(subtitleTrack.lang ? { srcLang: subtitleTrack.lang } : {})}
                default
              />
            )}
          </video>
          {resumeCandidateMs !== null && (
            <ResumePrompt
              open={awaitingResumeChoice}
              positionMs={resumeCandidateMs}
              durationMs={durationMs}
              // No real "which device" fact exists anywhere in this system
              // today — see ResumePrompt.tsx's header (Progress carries no
              // device column at any layer). Always null, never fabricated.
              deviceLabel={null}
              onResume={handleResume}
              onStartOver={handleStartOver}
              onDismiss={handleDismissResume}
            />
          )}
          <PlayerControls
            visible={controlsVisible || !isPlaying}
            title={item?.title ?? ""}
            isPlaying={isPlaying}
            positionMs={positionMs}
            durationMs={durationMs}
            buffered={buffered}
            volume={volume}
            muted={muted}
            isFullscreen={isFullscreen}
            buffering={buffering}
            audioStreams={session?.media?.audio ?? []}
            subtitleStreams={session?.media?.subtitle ?? []}
            selectedAudioIndex={selectedAudioIndex}
            selectedSubtitleIndex={selectedSubtitleIndex}
            // H6 (W3 fidelity audit, FX4): PlayerControls' capability chips
            // read the session's REAL decision — this is the one-line seam
            // threading it through; VideoPlayer.tsx itself is outside FX4's
            // exclusive file list, so this is deliberately the only touch.
            plan={session?.plan ?? null}
            videoElement={videoRef.current}
            onBack={onBack}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onSeekRelative={seekRelative}
            onVolumeChange={setVolumeAndApply}
            onToggleMute={toggleMute}
            onToggleFullscreen={toggleFullscreen}
            onSelectAudio={selectAudio}
            onSelectSubtitle={selectSubtitle}
          />
        </>
      )}
    </div>
  );
}
