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
import { acquirePlaybackSessionLease, playbackSessionLeaseKey } from "../../lib/playback-session-lease.js";
import {
  appendTokenParam,
  buildHlsMasterUrl,
  buildHlsSubtitleUrl,
  isSameUrlIgnoringToken,
  useHlsManifestUrl,
  useSessionFileUrl,
} from "../../lib/media-session-url.js";
import { decideAttachStrategy, isMseAvailable, isNativeHlsSupported } from "../../lib/hls-attach.js";
import { buildHlsJsConfig, resolveStartLevel } from "../../lib/hls-js-config.js";
import { QualitySelector, type QualityLevel } from "./QualitySelector.js";
import { deriveSubtitleTrackInfo, type SubtitleTrackInfo } from "../../lib/subtitle-track.js";
import { clientPlaybackErrorReasons, resolveUnavailableReasons } from "../../lib/playback-reasons.js";
import { findPlayableFallback, decisionLabel, type FallbackCandidate } from "../../lib/playback-fallback.js";
import { findProgressForItem, isWorthResuming } from "../../lib/progress-lookup.js";
import { HeartbeatScheduler, type HeartbeatSnapshot, type ProgressState } from "../../lib/heartbeat.js";
import { isRealPlaybackAdvancement, isSourceContinuous } from "../../lib/watched-progress.js";
import { createProgressWriteQueue } from "../../lib/progress-write-queue.js";
import { reportProgressOnUnload } from "../../lib/progress-report.js";
import { apiGet, apiPost, apiPut } from "../../lib/api-client.js";
import {
  armLandingWatch,
  bufferedRangesToSource,
  findLandingFragment,
  hasSourceClock,
  HARD_SEEK_LANDING_TIMEOUT_MS,
  isLandingResumeEvidence,
  sourceToPresentationSec,
  type LandingWatch,
  type ListedFragment,
} from "../../lib/source-time.js";
import {
  anchorAtExplicitPosition,
  anchorAtLanding,
  initialSourceClockState,
  resolveDisplayedSourceMs,
  type SourceClockState,
} from "../../lib/source-clock.js";
import { reopenEndedLevels, startRelocationNudge } from "../../lib/relocation-nudge.js";
import { decideRecovery, sessionFailureReasons } from "../../lib/playback-recovery.js";
import { useToast } from "../ui/Toast.js";
import { AmbientBackdrop } from "./AmbientBackdrop.js";
import { UnavailableScreen } from "./UnavailableScreen.js";
import { ResumePrompt } from "./ResumePrompt.js";
import { PlayerControls } from "./PlayerControls.js";
import { NoticeOverlayStrip } from "./NoticeOverlayStrip.js";
import { applyAudioTrackSelection } from "./TrackPickers.js";
import type { BufferedRange } from "./Scrubber.js";
import type { ChapterListEntry } from "./ChapterList.js";
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
// Task #6 (2026-08-08/10 HLS-stall recon; redesigned 2026-08-10 opus review
// findings 1/2; browser-player-F1 extracted it to lib/playback-recovery.ts
// so the hls.js attach effect shares the identical policy): the bounded
// recovery path — shared by a fatal `error` event AND the stall watchdog
// below on the direct-play/native-HLS side, and by fatal NETWORK/MEDIA
// hls.js errors on the hls.js side. The cooldown is a per-attempt COOLDOWN,
// DEFERRED via setTimeout when hit (never dropped), not a suppression
// window: a stretch of genuinely-failing retries gets at most
// MAX_RECOVERY_ATTEMPTS tries, no faster than one every
// RECOVERY_MIN_INTERVAL_MS, before falling through to the same
// fatal-unavailable path (`goFatal`) an unrecoverable decode/
// src-not-supported error already uses — which now inspects the session
// server-side first (status 'failed' -> the session's errorCode copy,
// lib/playback-recovery.ts; anything else -> clientPlaybackErrorReasons,
// lib/playback-reasons.ts).
// How long a stall (`waiting`/`stalled` while playing, no fatal `error`
// event at all) must sit with a KNOWN-stale attached token — a fresher one
// already exists, see `onStallSignal` — before it's treated as Safari's
// native-HLS 401 presentation rather than an ordinary rebuffer.
const STALL_WATCHDOG_MS = 10_000;
// W3C HTMLMediaElement MediaError codes — stable literal spec values across
// every browser, used instead of the global `MediaError.MEDIA_ERR_*`
// constants because jsdom does not define a `MediaError` constructor at all
// (this app's test environment — see VideoPlayer.test.tsx).
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export interface VideoPlayerProps {
  itemId: string;
  hintType?: string;
  /** The specific media_files row to play, when the user picked a VERSION
   *  rather than the item itself (components/detail/VersionRow.tsx's
   *  `?mediaFileId=` link -> app/watch/[itemId]/page.tsx). Omitted means
   *  "the item's primary media_files row", which is PlanRequest's own
   *  documented default (packages/contract/openapi.yaml). */
  mediaFileId?: string;
  /** Deep-link start offset in ms — a chapter timestamp
   *  (app/restricted/scenes/[id]/page.tsx's markers list, ?t=<seconds> ->
   *  app/watch/[itemId]/page.tsx converts to ms) or any future caller that
   *  wants playback to open at a specific position. WINS OVER the resume
   *  prompt when present (see the session-create effect below for why) —
   *  omitted means "behave exactly as before" (resume prompt if a
   *  worth-resuming saved position exists, else start at 0). */
  startMs?: number;
  onBack: () => void;
}

function readBuffered(video: HTMLVideoElement): BufferedRange[] {
  const ranges: BufferedRange[] = [];
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push({ startMs: video.buffered.start(i) * 1000, endMs: video.buffered.end(i) * 1000 });
  }
  return ranges;
}

/** Safari's native-HLS surface for §9.1.5 rule 7's PROGRAM-DATE-TIME: the
 *  wall-clock date of presentation zero — under the V8 source-clock
 *  convention, source ms at presentation 0. `null` anywhere the API is
 *  absent (every non-WebKit browser) or the playlist carries no PDT
 *  (`getStartDate()` returns an Invalid Date). */
function nativeSourceAnchorMs(video: HTMLVideoElement): number | null {
  try {
    const date = (video as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
    const t = date?.getTime();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function isInSeekable(video: HTMLVideoElement, sec: number): boolean {
  const s = video.seekable;
  for (let i = 0; i < s.length; i++) {
    if (sec >= s.start(i) && sec <= s.end(i)) return true;
  }
  return false;
}

function seekableEndSec(video: HTMLVideoElement | null): number | null {
  const s = video?.seekable;
  return s && s.length > 0 ? s.end(s.length - 1) : null;
}

export function VideoPlayer({ itemId, hintType, mediaFileId, startMs, onBack }: VideoPlayerProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [item, setItem] = useState<ItemSummary | null>(null);
  // S7/K9: loaded once per item via the SDK — see the fetch effect below.
  // Empty ([]) both before the fetch resolves and for a genuine zero-
  // chapters item; PlayerControls/Scrubber already treat an empty array as
  // "render nothing" (mission spec: zero chapters -> zero UI), so no
  // separate loading flag is needed here.
  const [chapters, setChapters] = useState<ChapterListEntry[]>([]);
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
  // gap-F7: ONE strictly-ordered lane for every apiPut /progress write
  // (interval heartbeat, pause flush, ended flush, seek flushes). At a
  // natural EOF `pause` fires before `ended` and each used to dispatch
  // its own concurrent PUT — the stale 'in-progress' write could persist
  // AFTER the 'played' write (the last-write race in the QA report). A
  // write now dispatches only after the previous one settles, so the
  // last-issued write is always the last the server processes. Component-
  // lifetime scope (outlives session swaps) so a fallback re-session's
  // first write still queues behind the old session's tail. The pagehide/
  // unmount path stays on reportProgressOnUnload's keepalive fetch — a
  // teardown-time send cannot await a lane.
  const progressWriteQueueRef = useRef(createProgressWriteQueue());
  const positionRef = useRef(0);
  // gap-F6: the WATCHED position — the last source-ms position backed by
  // real playback advancement (lib/watched-progress.ts's predicate over
  // consecutive timeupdate samples) or by an explicit user seek. It is the
  // ONLY position /progress writes ever report; `positionRef` (above)
  // stays the DISPLAYED position and legitimately tracks the mapped
  // element position at all times. `null` = nothing watched yet — every
  // progress write (heartbeat, pause/seek flush, unmount/pagehide flush)
  // is suppressed, so a session that never really played (e.g. the
  // run0→run7 self-relocation wedge, where presentation 0 mapped through
  // a relocated PDT origin to source ~7:31) writes NOTHING.
  const watchedPositionRef = useRef<number | null>(null);
  /** The previous `timeupdate` presentation-seconds sample — the baseline
   *  the advancement predicate compares against. */
  const advancementProbeSecRef = useRef<number | null>(null);
  /** gap-F6: where this mount INTENDS playback to start on the source axis
   *  (deep-link ?t= offset or 0; a chosen resume point re-anchors through
   *  watchedPositionRef in handleResume) — the bootstrap anchor for the
   *  source-continuity half of the watched-position gate, so the very
   *  first accepted advancement must be near where the viewer actually
   *  started, never near a relocated origin. */
  const intendedStartMsRef = useRef<number>(startMs ?? 0);
  /** browser-player-F6: the source-clock authority state (sticky clock
   *  flag + run floor + last authoritative axis anchor) that the
   *  displayed-position resolver threads through every `timeupdate` —
   *  see lib/source-clock.ts. Reset at the same two session-established
   *  sites `durationRef.current` resets at. */
  const sourceClockRef = useRef<SourceClockState>(initialSourceClockState());
  const durationRef = useRef<number | null>(null);
  // Opus review Finding F (2026-08-10): the event-wiring effect below
  // (`adoptElementDuration`) needs "is this session direct-play"
  // (`session.manifestUrl === null`, hls-attach.ts's own discriminator) at
  // the moment a `durationchange`/`loadedmetadata` event fires — but that
  // effect's dependency array is `[phase]` only (see its own comment), and
  // `phase` can stay `'ready'` across a session swap (a same-string
  // setPhase("ready") doesn't retrigger effects keyed on it), so reading
  // reactive `session` state directly inside its closure would go stale
  // exactly like `durationRef` would if IT were reactive state instead of a
  // ref. Mirrors `durationRef`: a plain ref, reset at the same two
  // session-established sites `durationRef.current` already resets at.
  const isDirectPlayRef = useRef(false);
  const progressStateRef = useRef<ProgressState>("in-progress");
  const pendingSeekMsRef = useRef<number | null>(null);
  // Mirrors `awaitingResumeChoice` for the hls.js attach effect below: that
  // effect must NOT re-run (tearing down and recreating the whole Hls
  // instance) merely because the resume-prompt choice flips — it only
  // needs the LATEST value at the moment its one-shot `loadedmetadata`
  // handler actually fires. The direct-play/native-hls effect doesn't need
  // this: it already lists `awaitingResumeChoice` in its own dependency
  // array (its attach guard is token-aware, not a src-swap-avoiding
  // no-op — see `isSameUrlIgnoringToken`, task #6 — so re-running on that
  // flip is cheap and correct), so only this ref exists for the hls.js path.
  const awaitingResumeChoiceRef = useRef(false);
  const hlsRef = useRef<HlsInstance | null>(null);
  // Wave C2 (§9.1.9) — the quality selector's state, MIRRORED from hls.js
  // rather than modelled independently: `hls.levels` after the master is
  // parsed, and `currentLevel`/`autoLevelEnabled` on every level switch.
  // Empty for direct-play and for the Safari-native path (no hls.js
  // instance at all), which is exactly when QualitySelector renders nothing.
  const [hlsLevels, setHlsLevels] = useState<QualityLevel[]>([]);
  const [currentHlsLevel, setCurrentHlsLevel] = useState(-1);
  const [hlsAutoMode, setHlsAutoMode] = useState(true);
  // Task #6 recovery redesign (2026-08-10 opus review finding 1): a
  // SEPARATE ref from any ordinary (non-recovery) attach — the initial
  // attach, a genuinely-new-URL reattach, and the paused-boundary
  // opportunistic refresh all call the same `attach()` below but must NOT
  // stamp this or consume `recoveryAttemptsRef`'s budget; only a
  // recovery-triggered attach (`runRecoveryAttach`, driven by the `error`
  // listener or the stall watchdog) does. `0` is the "never" sentinel —
  // `Date.now() - 0` is always far past `RECOVERY_MIN_INTERVAL_MS`, so the
  // very first recovery attempt after a fresh attach is never held back by
  // a cooldown it never itself started.
  const recoveryStampRef = useRef(0);
  // How many recovery attaches the current "stretch" has used, bounded at
  // MAX_RECOVERY_ATTEMPTS before the fatal-unavailable path. Reset to 0 on
  // the element's own `playing` event — a stretch that reaches real
  // playback again earns a fresh budget.
  const recoveryAttemptsRef = useRef(0);
  // ── V8 hard-seek state (docs/PLAYBACK.md §9.1.9) ─────────────────────────
  // `relocating` renders the pinned-scrubber + spinner state while the
  // worker restarts at the POSTed target; the watch/timer refs drive the
  // landing (LEVEL_UPDATED fragment match) and the bounded timeout. The
  // mirrored ref lets the [phase]-keyed event-wiring effect read the LIVE
  // value (same staleness rationale as isDirectPlayRef above).
  const [relocating, setRelocating] = useState<{ targetMs: number } | null>(null);
  const relocatingRef = useRef<{ targetMs: number } | null>(null);
  const landingWatchRef = useRef<LandingWatch | null>(null);
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // browser-player-F4: the landed-but-not-yet-watchable half of the hard-
  // seek lifecycle. Set by the LEVEL_UPDATED landing (and the native
  // coarse landing) INSTEAD of tearing the whole relocation state down —
  // the fragment match only proves the run EXISTS, not that the element
  // can display it (a seek at/near EOF can land on a run with nothing
  // displayable: the QA 2026-08-20/21 EOF wedge). While set, the 20 s
  // timer armed at the 202 keeps running and the display stays pinned;
  // resume evidence (see maybeCompleteLanding in the event-wiring effect)
  // or the timeout ends the lifecycle — never silence.
  const landedAwaitingResumeRef = useRef<{ startSec: number; targetMs: number } | null>(null);
  // Native-HLS coarse landing (V8 v1 scope, ruled — §9.1.10 item 5): no
  // hls.js instance means no LEVEL_UPDATED, so the landing is a seekable-
  // end poll instead of a fragment match.
  const coarsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // V8 discovery-latency fix (2026-08-20): while relocating, force a
  // playlist re-read once per second (lib/relocation-nudge.ts) instead of
  // waiting out hls.js's own live-refresh cadence. Holds the stop fn.
  const nudgeStopRef = useRef<(() => void) | null>(null);
  // gap-F4: hard-seek supersession epoch. Each hardSeek() takes a fresh
  // epoch BEFORE its POST, and only the response whose epoch is still
  // current may arm the landing watch — "newest wins" must hold on SEEK
  // order, not 202 ARRIVAL order (two rapid hard seeks whose responses
  // arrive out of order used to pin the scrubber at the OLDER dead
  // target). clearLandingWatch() also bumps it, so a soft seek / unmount /
  // timeout invalidates any still-in-flight arm.
  const seekEpochRef = useRef(0);
  // browser-player-F9: lets the hls.js attach effect (which sits ABOVE the
  // `hardSeek` callback in this file) route a queued deep-link start
  // through the V8 hard-seek path without listing the callback in its
  // dependency array — the effect only needs the LATEST identity at the
  // moment its LEVEL_UPDATED handler actually fires. Assigned during
  // render right after `hardSeek`'s declaration (the same render-time
  // idiom as `flushProgressRef` below).
  const hardSeekRef = useRef<(targetMs: number) => void>(() => undefined);

  /** The CURRENT LEVEL DETAILS as structural fragments (A2: the LISTED
   *  window — buffer state deliberately plays no part). `null` off the
   *  hls.js path or before the first playlist parse. Reads hlsRef live, so
   *  a stale closure identity is harmless. */
  const listedFragments = useCallback((): ListedFragment[] | null => {
    const hls = hlsRef.current;
    if (!hls) return null;
    const levelIndex = hls.currentLevel >= 0 ? hls.currentLevel : hls.levels.length > 0 ? 0 : -1;
    const details = levelIndex >= 0 ? hls.levels[levelIndex]?.details : undefined;
    const frags = details?.fragments;
    if (!frags || frags.length === 0) return null;
    return frags.map((f) => ({
      programDateTimeMs: typeof f.programDateTime === "number" ? f.programDateTime : null,
      startSec: f.start,
      durationSec: f.duration,
      relurl: f.relurl ?? null,
    }));
  }, []);

  const clearLandingWatch = useCallback((): void => {
    // Invalidate any in-flight hard-seek 202 (gap-F4): whatever cleared
    // the watch — a landing, the timeout, a soft seek, unmount — a stale
    // response arriving later must not resurrect the relocating state.
    seekEpochRef.current += 1;
    landingWatchRef.current = null;
    landedAwaitingResumeRef.current = null;
    relocatingRef.current = null;
    if (landingTimerRef.current) {
      clearTimeout(landingTimerRef.current);
      landingTimerRef.current = null;
    }
    if (coarsePollRef.current) {
      clearInterval(coarsePollRef.current);
      coarsePollRef.current = null;
    }
    if (nudgeStopRef.current) {
      nudgeStopRef.current();
      nudgeStopRef.current = null;
    }
    setRelocating(null);
  }, []);

  const serverUrl = getAuthStore().getSnapshot().serverUrl;

  // ── Fatal-unavailable destination (browser-player-F1) ───────────────────
  // The ONE place every exhausted/unrecoverable client-side playback
  // failure lands, whichever attach mode raised it (the direct-play/
  // native-HLS effect's bounded recovery AND the hls.js ERROR handler's).
  // Before rendering the generic client-synthesized reason, ask the server
  // what IT thinks of the session: a worker that died mid-session marks
  // the row status 'failed' with an errorCode (apps/worker/src/transcode/
  // exit-classify.ts), and that code carries strictly more information
  // than "your browser couldn't play this" — so a confirmed server-side
  // failure renders the session's own errorCode copy
  // (lib/playback-recovery.ts) instead. Any inspect failure (network gone,
  // 404 after an idle sweep, no session yet) falls back to the client
  // reason — this path must never hang on a GET to render SOMETHING.
  const goFatal = useCallback((): void => {
    const sessionId = session?.id;
    const clientFallback = (): void => {
      setUnavailableReasons(clientPlaybackErrorReasons());
      setUnavailableStatus(undefined);
      setPhase("unavailable");
    };
    if (!sessionId) {
      clientFallback();
      return;
    }
    apiGet("/playback/sessions/{id}", { params: { path: { id: sessionId } } })
      .then((current) => {
        if (current.status === "failed") {
          setUnavailableReasons(sessionFailureReasons(current.errorCode));
          setUnavailableStatus(undefined);
          setPhase("unavailable");
          return;
        }
        clientFallback();
      })
      .catch(clientFallback);
  }, [session?.id]);

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

  // ── Chapters (S7/K9) ─────────────────────────────────────────────────────
  // Loaded once per item, independent of session/playback state — chapters
  // are catalog metadata (GET /items/{id}/chapters is guarded the same way
  // the item itself is, house pattern), not something the playback session
  // produces. A 401/404/network failure leaves `chapters` at its initial []
  // (no chapter UI), matching "zero chapters -> zero UI": a player that
  // can't fetch chapters degrades to the SAME experience as an item that
  // genuinely has none, never a visible error state for what is a
  // secondary affordance.
  useEffect(() => {
    let cancelled = false;
    apiGet("/items/{id}/chapters", { params: { path: { id: itemId } } })
      .then((res) => {
        if (!cancelled) setChapters(res.items);
      })
      .catch(() => {
        if (!cancelled) setChapters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // ── Step 2: session create (or unavailable) ─────────────────────────────
  // Phase 3 Step 6c: no more plan-preview short-circuit (lib/playback-
  // session.ts's header) — go straight to session create and branch on the
  // REAL session. Only a genuine 409 (unplayable)/422/429 renders
  // UnavailableScreen now; direct-stream/remux/transcode all proceed to the
  // attach-strategy effects below.
  //
  // `mediaFileId` pins the session to the VERSION the user actually picked
  // (undefined = the item's primary file, PlanRequest's own default) — the
  // same third argument the fallback-accept path below already uses.
  //
  // `startMs` (S7 deep-link chapter offset) COMPOSES with the resume prompt
  // by winning outright, never by merging: when a caller navigates here
  // with an explicit offset (a chapter timestamp the user just clicked),
  // that click IS the user's answer to "where do you want to start" — a
  // SEPARATE resume prompt on arrival would ask the same question twice,
  // and picking whichever of the two positions is "more correct" would
  // second-guess a choice the user just made one navigation ago. So the
  // saved-progress lookup is skipped entirely (never fetched, never shown)
  // and playback seeks straight to `startMs` via `pendingSeekMsRef` — the
  // SAME ref the resume prompt's own Resume button uses to hand a chosen
  // position to the attach effects, so this is "as if the user had already
  // chosen Resume at that offset", not a second code path.
  useEffect(() => {
    let cancelled = false;
    // gap-F1: dev StrictMode double-invokes this effect (setup #1 →
    // cleanup #1 → setup #2, all synchronous — long before either POST
    // could settle), so a bare createPlaybackSession() here raced TWO
    // concurrent creates per mount: under the shipped
    // maxSimultaneousTranscodes = 1 the twins fought over the household's
    // only slot (201 + 429 — "Server is at capacity" with zero real load,
    // while the cancelled twin's cleanup DELETEd the winning session), and
    // with more slots the extra 201 leaked under churn. The lease pool
    // (lib/playback-session-lease.ts) joins the twins onto ONE in-flight
    // POST and owns the orphan cleanup that the per-invocation `cancelled`
    // flag used to do — see AUD-A4v4-003 notes at the lease module and at
    // the `cancelled` check below.
    const lease = acquirePlaybackSessionLease(playbackSessionLeaseKey(itemId, mediaFileId), () =>
      createPlaybackSession(itemId, "stream", mediaFileId),
    );

    async function run(): Promise<void> {
      let result: Awaited<ReturnType<typeof createPlaybackSession>>;
      try {
        result = await lease.promise;
      } catch {
        if (cancelled) return;
        // AUD-W6-001 (server repro: a real catalog_items row with zero
        // media_files returns a clean 404 from POST /playback/sessions in
        // under 2s — the server does not hang). createPlaybackSession
        // (lib/playback-session.ts) only intercepts a genuine 409/422/429
        // refusal and folds it into `result.ok === false`; anything else —
        // a 404, a 5xx, a network failure — is deliberately re-thrown
        // rather than treated as a plan refusal (see that function's own
        // header). Before this fix, that re-throw reached `void run()`
        // below with no attached catch: an unhandled promise rejection
        // that left `phase` stuck at "loading" forever — the reported
        // /watch/<item> hang was always client-side, never a server hang.
        // Route to the SAME fatal-unavailable path client-side DECODE/
        // SRC_NOT_SUPPORTED already reaches (`goFatal()` in the attach
        // effect below, clientPlaybackErrorReasons() from lib/playback-
        // reasons.ts) — no server plan reasons exist for a failure this
        // shape either, so this reuses that exact synthesized reason
        // rather than inventing new UI or trying to interpret an arbitrary
        // thrown error's shape.
        setUnavailableReasons(clientPlaybackErrorReasons());
        setUnavailableStatus(undefined);
        setPhase("unavailable");
        return;
      }
      if (cancelled) {
        // AUD-A4v4-003: this invocation was superseded (itemId/mediaFileId/
        // startMs changed) or the player unmounted while the POST was in
        // flight — but the server row may already exist and never reach
        // `session` state, so the sibling unmount cleanup below can never
        // end it. The LEASE owns that cleanup now (this invocation's
        // release() in the effect cleanup marks it; the pool ends the
        // session iff no other invocation — a StrictMode twin — adopted
        // it). Ending it here directly is exactly the gap-F1 bug: this
        // `cancelled` is true for twin #1 regardless of which twin's
        // session survived.
        return;
      }
      if (!result.ok) {
        setUnavailableReasons(resolveUnavailableReasons(result.status, result.wouldBeReasons));
        setUnavailableStatus(result.status);
        setPhase("unavailable");
        return;
      }
      lease.adopt();
      setSession(result.session);
      setDurationMs(result.session.media?.durationMs ?? null);
      durationRef.current = result.session.media?.durationMs ?? null;
      isDirectPlayRef.current = result.session.manifestUrl === null;
      sourceClockRef.current = initialSourceClockState();
      const defaultAudio = result.session.media?.audio.find((a) => a.isDefault) ?? result.session.media?.audio[0];
      if (defaultAudio) setSelectedAudioIndex(defaultAudio.index);

      if (startMs !== undefined) {
        pendingSeekMsRef.current = startMs;
        setAwaitingResumeChoice(false);
      } else {
        const existing = await findProgressForItem(itemId).catch(() => null);
        if (cancelled) return;
        if (existing && isWorthResuming(existing)) {
          setResumeCandidateMs(existing.positionMs);
          setAwaitingResumeChoice(true);
        } else {
          setAwaitingResumeChoice(false);
        }
      }
      setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [itemId, mediaFileId, startMs]);

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
    if (!video || !activeSrcUrl) return undefined;

    // Task #6 finding 3 (2026-08-10 opus review): hoisted to EFFECT scope,
    // not re-declared fresh inside every `attach()` call — a FAILED attach
    // never fires `loadedmetadata` on its own, so nothing else ever removed
    // it. Repeated failed attaches (the recovery retries below, especially)
    // used to stack one listener per attempt; when a load finally DID
    // succeed they all fired together — N stale-closure `currentTime` seeks
    // and `play()` calls in a row. `attach()` now removes any pending one
    // of its own before registering a new one, and effect cleanup removes
    // whatever is still pending on unmount/rerun.
    let onLoaded: (() => void) | null = null;

    // Swaps `video.src` to `activeSrcUrl`, preserving position/paused-state
    // the same way for every caller below (first attach, a genuinely new
    // URL, a paused-boundary token refresh, or a bounded recovery retry —
    // see `runRecoveryAttach` further down) — see the two direct call sites
    // right after this declaration. An ARROW function expression (not a
    // hoisted `function` declaration) so TS's control-flow analysis keeps
    // `video`/`activeSrcUrl` narrowed to non-null inside it, same as
    // `onLoaded`.
    const attach = (): void => {
      if (onLoaded) {
        video.removeEventListener("loadedmetadata", onLoaded);
        onLoaded = null;
      }
      const wasPlaying = !video.paused;
      const currentSrc = video.src;
      const resumeAt = currentSrc ? video.currentTime : (pendingSeekMsRef.current ?? 0) / 1000;
      video.src = activeSrcUrl;
      video.load();
      onLoaded = (): void => {
        video.currentTime = resumeAt;
        if (wasPlaying || (!currentSrc && !awaitingResumeChoice)) void video.play().catch(() => undefined);
        if (onLoaded) video.removeEventListener("loadedmetadata", onLoaded);
        onLoaded = null;
      };
      video.addEventListener("loadedmetadata", onLoaded);
    };

    // Task #6 (2026-08-08/10 HLS-stall recon): compare the currently-
    // attached src against `activeSrcUrl` IGNORING `?token=`
    // (`isSameUrlIgnoringToken`, lib/media-session-url.ts) instead of a
    // verbatim string comparison. A verbatim comparison trips on every
    // token rotation `useSessionFileUrl`/`useHlsManifestUrl` hand back
    // (~every 14.5 minutes — the 15-minute access-token TTL against the
    // AuthStore's 30s pre-expiry refresh skew, NOT every 60s poll — see
    // media-session-url.ts's header) and forced a full reload+reseek for a
    // stream that never actually changed.
    const attachedSrc = video.src;
    const alreadyAttached = attachedSrc.length > 0 && isSameUrlIgnoringToken(attachedSrc, activeSrcUrl);

    if (!alreadyAttached) {
      // No src yet, or a genuinely different resource (new session/file,
      // e.g. a fallback/version switch) — always (re)attach.
      attach();
    } else if (video.paused && attachedSrc !== activeSrcUrl) {
      // Same stream, a rotated token, nothing playing to interrupt: take
      // the free opportunity to swap in the fresh URL now rather than risk
      // it going stale while paused indefinitely (the server's token
      // verification has no grace window — apps/server/src/session/
      // token.service.ts's verifyAccessToken). Trade-offs kept deliberately
      // as-is (2026-08-10 opus review finding 4, decided not worth a
      // deferral system): `attach()`'s full `src`/`load()` reset discards
      // the browser's OWN buffer for this stream, so resuming after this
      // shows a spinner rather than picking straight back up — and a click
      // landing between this `paused` check and the `load()` inside
      // `attach()` loses its own `play()` race (the fresh `load()` pauses
      // the element again, per the WHATWG resource-selection algorithm —
      // see the test file's `load()` stub comment). Both are judged better
      // than the alternative of interrupting genuinely mid-play video to
      // swap a token that hasn't failed yet.
      attach();
    }
    // else: a token-only refresh while actively playing — deliberately a
    // no-op. Smooth playback is never interrupted for a token that hasn't
    // actually failed yet; the `error` listener and the stall watchdog
    // below are the safety net for when the currently-attached
    // (increasingly stale) token eventually does cause a real failure.

    // ── Bounded recovery (2026-08-10 opus review findings 1 & 2) ──────────
    // Shared by BOTH triggers below: a fatal `error` event, and the stall
    // watchdog (Safari's native-HLS 401 typically presents as a STALL — the
    // element just stops advancing, no fatal `error` event at all — see
    // `onStallSignal`). `recoveryStampRef`/`recoveryAttemptsRef` are REFS
    // (component-scoped, not effect-local) so the cooldown/budget survive
    // this effect tearing down and re-running on every benign token
    // rotation (which reruns this effect even when nothing was wrong — see
    // the no-op branch above).
    let recoveryTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // No reattach can fix an exhausted stretch — either the browser
    // already refused to decode/support the source, or every bounded retry
    // already failed identically. `goFatal` (component scope,
    // browser-player-F1) routes to the SAME fatal-unavailable screen a
    // refused createPlaybackSession already renders, inspecting the
    // session server-side first for a real errorCode.

    function runRecoveryAttach(): void {
      recoveryStampRef.current = Date.now();
      recoveryAttemptsRef.current += 1;
      attach();
    }

    function scheduleRecoveryAttach(): void {
      // decideRecovery (lib/playback-recovery.ts, browser-player-F1): the
      // SAME bounded policy the hls.js attach effect consults — budget
      // exhausted -> fatal; inside the cooldown -> DEFER the retry to when
      // it expires instead of dropping it. (The old bare in-cooldown
      // `return` silently killed an initial attach that failed fast — or
      // any retry landing inside another retry's own cooldown — with no
      // further trigger ever coming, leaving the player permanently and
      // silently dead. One pending timer at a time; a second signal
      // arriving before it fires changes nothing.)
      const decision = decideRecovery(recoveryAttemptsRef.current, recoveryStampRef.current, Date.now());
      if (decision.action === "fatal") {
        goFatal();
        return;
      }
      if (decision.delayMs === 0) {
        runRecoveryAttach();
        return;
      }
      if (recoveryTimeoutHandle) return;
      recoveryTimeoutHandle = setTimeout(() => {
        recoveryTimeoutHandle = null;
        runRecoveryAttach();
      }, decision.delayMs);
    }

    const onError = (): void => {
      // A fatal media error mid-playback. Two of `video.error.code`'s
      // values are genuinely UNRECOVERABLE (opus review finding 1c) — the
      // browser has already refused this exact source; reattaching the
      // exact same URL cannot change that verdict — everything else is
      // most likely, on these two branches, the currently-attached URL's
      // embedded token finally expiring server-side (no grace window) and
      // a playlist refetch/byte-range GET 401'ing, which a bounded retry
      // with the LATEST known-fresh URL genuinely can fix: `activeSrcUrl`
      // in this closure is always current — this effect reruns on every
      // token rotation even when it chose not to act on it above, tearing
      // down and re-registering this very listener with the updated
      // closure.
      const err = video.error;
      if (err && (err.code === MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MEDIA_ERR_DECODE)) {
        goFatal();
        return;
      }
      scheduleRecoveryAttach();
    };

    // ── Stall watchdog (2026-08-10 opus review finding 2) ─────────────────
    // Safari's native-HLS 401 typically presents as a STALL, not a fatal
    // `error` event — the element just stops advancing and fires
    // `waiting`/`stalled` with `readyState` dropping, per review. Mirrors
    // `onError` above (same bounded `scheduleRecoveryAttach` path) but
    // triggers on "stuck for STALL_WATCHDOG_MS" instead of "the browser
    // fired a fatal error", and ONLY when a FRESHER token is already known
    // to exist (`isSameUrlIgnoringToken` true, raw strings different) —
    // that guard is what keeps this from ever firing during an ORDINARY
    // rebuffer with a still-current token, where reattaching would help
    // nothing.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stallBaselineTime: number | null = null;

    const clearStallWatch = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      stallBaselineTime = null;
    };

    const onStallSignal = (): void => {
      if (video.paused || stallTimer) return; // nothing to watch, or already watching (continue, don't restart)
      stallBaselineTime = video.currentTime;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (video.paused || video.currentTime !== stallBaselineTime) return; // resumed advancing on its own
        const attachedNow = video.src;
        if (!attachedNow || attachedNow === activeSrcUrl) return; // still the current token — an ordinary rebuffer, not this
        if (!isSameUrlIgnoringToken(attachedNow, activeSrcUrl)) return; // a genuinely different resource — not this watchdog's concern
        scheduleRecoveryAttach();
      }, STALL_WATCHDOG_MS);
    };

    const onTimeUpdateWatch = (): void => {
      // Real progress since the watchdog's baseline — the "stall" already
      // resolved on its own; nothing to recover.
      if (stallTimer !== null && stallBaselineTime !== null && video.currentTime !== stallBaselineTime) clearStallWatch();
    };

    const onPlayingSignal = (): void => {
      recoveryAttemptsRef.current = 0; // a stretch that reaches real playback again earns a fresh budget
      clearStallWatch();
    };

    video.addEventListener("error", onError);
    video.addEventListener("waiting", onStallSignal);
    video.addEventListener("stalled", onStallSignal);
    video.addEventListener("timeupdate", onTimeUpdateWatch);
    video.addEventListener("playing", onPlayingSignal);
    video.addEventListener("pause", clearStallWatch);
    return () => {
      video.removeEventListener("error", onError);
      video.removeEventListener("waiting", onStallSignal);
      video.removeEventListener("stalled", onStallSignal);
      video.removeEventListener("timeupdate", onTimeUpdateWatch);
      video.removeEventListener("playing", onPlayingSignal);
      video.removeEventListener("pause", clearStallWatch);
      if (onLoaded) video.removeEventListener("loadedmetadata", onLoaded);
      if (recoveryTimeoutHandle) clearTimeout(recoveryTimeoutHandle);
      clearStallWatch();
    };
    // Depends on `videoEl` (STATE, not the ref) so this re-runs the moment the
    // element mounts — activeSrcUrl frequently resolves a tick before the
    // <video> attaches, and a ref-only dependency would miss that mount.
    // `goFatal` only changes identity with `session?.id`, which always
    // changes `activeSrcUrl` too — no extra re-runs.
  }, [activeSrcUrl, videoEl, awaitingResumeChoice, goFatal]);

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
    // browser-player-F1: the hls.js side of the shared bounded-recovery
    // policy's deferred-retry timer — effect-scoped (cleared on cleanup)
    // exactly like the native attach effect's `recoveryTimeoutHandle`.
    let recoveryTimerHandle: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      const initialToken = await getAuthStore().getAccessToken();
      if (cancelled || !initialToken) return;
      // Wave C2 / owner-decision V5: the MASTER playlist, for every HLS
      // session. hls.js discovers the variants from it and runs its own
      // ABR; each level switch surfaces to the server as a `v{K}` request
      // (docs/PLAYBACK.md §9.1.1) and hands the session's existing
      // admission slot to that rung. No new client auth surface: the
      // master, the variant playlists and the `v{K}/`-prefixed segments all
      // ride the same per-request `xhrSetup` token rewrite below.
      const manifestUrl = buildHlsMasterUrl(serverUrl, session.id, initialToken);

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
          // §9.1.5 rule 6: the served playlist no longer declares
          // PLAYLIST-TYPE:EVENT, so it reads as LIVE and hls.js's default
          // startPosition (-1, the live edge) would land the viewer up to
          // 10 segments past the resume point. Pin it.
          startPositionSec: (pendingSeekMsRef.current ?? 0) / 1000,
          // §9.1.9: start on the rung the server's pipeline is ALREADY
          // encoding, so a clean start performs ZERO handoffs.
          startLevel: resolveStartLevel(session.plan.ladder ?? []),
        }),
      );
      hlsRef.current = hls;

      // Quality-selector state (§9.1.9). Read from hls.js's own level list
      // and level events — this component holds no parallel model of what
      // is playing, it mirrors what hls.js reports.
      const syncLevels = (): void => {
        if (!hls) return;
        setHlsLevels(hls.levels.map((level) => ({ height: level.height ?? 0, bitrate: level.bitrate ?? 0 })));
        setCurrentHlsLevel(hls.currentLevel);
        setHlsAutoMode(hls.autoLevelEnabled);
      };
      hls.on(HlsCtor.Events.MANIFEST_PARSED, syncLevels);
      hls.on(HlsCtor.Events.LEVEL_SWITCHED, syncLevels);

      // V8 hard-seek landing watch (§9.1.9): every playlist refresh tries
      // to land a pending hard seek. The match requires BOTH the runN
      // prefix (strictly newer than the watch's floor) AND the PDT window
      // — see source-time.ts's findLandingFragment.
      hls.on(HlsCtor.Events.LEVEL_UPDATED, () => {
        const watch = landingWatchRef.current;
        if (!watch) return;
        const frags = listedFragments();
        if (!frags) return;
        const landing = findLandingFragment(frags, watch);
        if (!landing) return;
        const targetMs = watch.clampedTargetMs;
        // browser-player-F4: the fragment match ends run DISCOVERY only,
        // never the seek. Stop the watch and the nudge (a nudge past this
        // point aborts the very fragment loads the landing needs), but the
        // 20 s lifecycle timer and the relocating pin both SURVIVE the
        // landing: the seek is over when the landed position is actually
        // displayable (resume evidence in the event-wiring effect) or when
        // the timeout toasts — an at-EOF run with nothing displayable in
        // it used to consume the timer here and wedge the player forever.
        landingWatchRef.current = null;
        if (nudgeStopRef.current) {
          nudgeStopRef.current();
          nudgeStopRef.current = null;
        }
        landedAwaitingResumeRef.current = { startSec: landing.startSec, targetMs };
        // browser-player-F6: the landing names the seek-spawned run and
        // its origin — from here the source mapping is AUTHORITATIVE: the
        // landed fragment's own PDT anchors the displayed clock and its
        // run index invalidates every pre-seek window (lib/source-clock.ts).
        sourceClockRef.current = anchorAtLanding(sourceClockRef.current, landing);
        video.currentTime = landing.startSec;
        positionRef.current = targetMs;
        setPositionMs(targetMs);
        heartbeatRef.current?.flushNow();
      });

      // ── Queued-start routing (browser-player-F9) ──────────────────────
      // `pendingSeekMsRef` rides the PRESENTATION axis into this attach —
      // the config's `startPositionSec` above and the loadedmetadata
      // assignment below — which is only correct while the target sits
      // inside the served window (where a fresh session's presentation and
      // source axes coincide). A transcode session's playlist covers only
      // what the worker has produced so far, so a ?t= deep-link/chapter
      // target beyond it was silently clamped by hls.js/MSE and playback
      // started at 0 with no POST /seek — the offset must instead be a V8
      // HARD seek at the SOURCE-axis target, exactly as if the user had
      // dragged the scrubber there (QA 2026-08-20/21). Decided ONCE, on
      // the first LEVEL_UPDATED that exposes a readable window — the
      // earliest moment the soft/hard classification is answerable at all;
      // every later seek goes through seek()/hardSeek() as always.
      let pendingStartRouted = false;
      // Read by the loadedmetadata handler below: a routed-hard start must
      // suppress the presentation-axis `currentTime` assignment — the
      // target exists only in SOURCE time, and the landing (or its 20 s
      // timeout) owns the element's position from the 202 on.
      let pendingStartRoutedHard = false;
      const routePendingStart = (): void => {
        if (pendingStartRouted) return;
        const frags = listedFragments();
        if (!frags) return; // window not readable yet — try the next refresh
        pendingStartRouted = true;
        const pending = pendingSeekMsRef.current;
        if (pending === null) return;
        // No source clock (a pre-V8 server): presentation == source, the
        // startPosition path is exactly right — keep it.
        if (!hasSourceClock(frags)) return;
        // Listed (A2 — the soft boundary is the LISTED window): the
        // presentation-axis startPosition/loadedmetadata path lands it
        // without burning a transcoder restart.
        if (sourceToPresentationSec(frags, pending) !== null) return;
        pendingStartRoutedHard = true;
        hardSeekRef.current(pending);
      };
      hls.on(HlsCtor.Events.LEVEL_UPDATED, routePendingStart);

      // Fatal-error recovery (browser-player-F1). hls.js's documented
      // in-place levers — `startLoad()` for a network error,
      // `recoverMediaError()` for a media error — used to run here
      // UNBOUNDED and blind: a worker whose transcode died mid-session
      // (session status 'failed', playlists 404) spun an endless ~1/s
      // retry loop behind an indefinite spinner, with no failure surface
      // and the session's server-side status never consulted. Both levers
      // now consume the SAME bounded budget the direct-play/native-HLS
      // attach effect uses (decideRecovery, lib/playback-recovery.ts —
      // shared refs, shared constants; the event-wiring effect's `playing`
      // listener resets the budget for both modes), and exhaustion — or an
      // OTHER-typed fatal, which has no in-place lever at all — routes to
      // the shared `goFatal` destination: inspect the session, then
      // UnavailableScreen with the session's errorCode when the server
      // marked it failed. `stopLoad()` before `goFatal()` quiets the
      // request loop while the inspect resolves; the instance itself is
      // destroyed by this effect's cleanup when the phase flip unmounts
      // the <video>.
      const runHlsRecovery = (retry: () => void): void => {
        recoveryStampRef.current = Date.now();
        recoveryAttemptsRef.current += 1;
        retry();
      };
      const scheduleHlsRecovery = (retry: () => void): void => {
        const decision = decideRecovery(recoveryAttemptsRef.current, recoveryStampRef.current, Date.now());
        if (decision.action === "fatal") {
          hls?.stopLoad();
          goFatal();
          return;
        }
        if (decision.delayMs === 0) {
          runHlsRecovery(retry);
          return;
        }
        // Inside the cooldown: defer, never drop — one pending timer at a
        // time, same as the native path.
        if (recoveryTimerHandle) return;
        recoveryTimerHandle = setTimeout(() => {
          recoveryTimerHandle = null;
          runHlsRecovery(retry);
        }, decision.delayMs);
      };
      hls.on(HlsCtor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case HlsCtor.ErrorTypes.NETWORK_ERROR:
            scheduleHlsRecovery(() => hls?.startLoad());
            break;
          case HlsCtor.ErrorTypes.MEDIA_ERROR:
            scheduleHlsRecovery(() => hls?.recoverMediaError());
            break;
          default:
            hls?.stopLoad();
            goFatal();
            break;
        }
      });

      // Fresh attach every time this effect runs (a new session, since
      // `session.id` is a dependency below) — never a src-swap-in-place
      // like the direct-play/native-hls effect, so `wasPlaying` is always
      // false and autoplay is governed purely by the resume-choice gate.
      const resumeAt = (pendingSeekMsRef.current ?? 0) / 1000;
      onLoaded = (): void => {
        // browser-player-F9: a queued start that was routed through the V8
        // hard-seek path must NOT also run the presentation-axis
        // assignment — see routePendingStart above.
        if (!pendingStartRoutedHard) video.currentTime = resumeAt;
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
      if (recoveryTimerHandle) clearTimeout(recoveryTimerHandle);
      // V8: a pending hard seek dies with its session/instance — the watch
      // must never land against a different attach's fragments.
      clearLandingWatch();
      hls?.destroy(); // deliverable 5: no leaked MediaSource on unmount/session change.
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [attachStrategy, videoEl, session?.id, serverUrl, listedFragments, clearLandingWatch, goFatal]);

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
      // gap-F6: the snapshot reports the WATCHED position, never the
      // displayed one — a relocated origin must not become progress.
      getSnapshot: (): HeartbeatSnapshot => ({
        positionMs: watchedPositionRef.current ?? 0,
        durationMs: durationRef.current,
        state: progressStateRef.current,
      }),
      send: (snapshot) => {
        // gap-F6: nothing was ever really watched (no advancement, no
        // user seek) — write NOTHING, not a phantom row.
        if (watchedPositionRef.current === null) return;
        // gap-F7: the body is captured NOW (flush-time snapshot,
        // unchanged), but the PUT dispatches through the FIFO lane — a
        // flush issued while an earlier write is still in flight (the
        // EOF pause→ended pair; an interval tick racing any flush) waits
        // for it to settle, so the server always persists writes in the
        // order the player issued them and the 'played' state can never
        // lose to a stale 'in-progress' write.
        const body = {
          positionMs: Math.round(snapshot.positionMs),
          durationMs: snapshot.durationMs,
          state: snapshot.state,
          sessionId: session.id,
        };
        void progressWriteQueueRef.current.enqueue(() =>
          apiPut("/progress/{itemId}", { params: { path: { itemId } }, body }),
        );
      },
    });
    return () => heartbeatRef.current?.stop();
  }, [session, itemId]);

  // ── Teardown flush ───────────────────────────────────────────────────────
  // `pagehide` alone is not enough: the /watch route's Back control is an
  // in-app router.back() (app/watch/[itemId]/page.tsx), which unmounts this
  // tree WITHOUT any document teardown, so nothing fired and everything
  // since the last ~10s heartbeat tick was lost — including, for a watch
  // shorter than one interval, the whole position even though it clears
  // isWorthResuming's 5s bar. One flush body, two triggers. Assigned during
  // render (same idiom as awaitingResumeChoiceRef above) so the unmount
  // effect below can keep empty deps and fire exactly once, at real
  // teardown, rather than on every `session` change.
  const flushProgressRef = useRef<() => void>(() => undefined);
  flushProgressRef.current = (): void => {
    // Nothing ever played (abandoned load, or a fallback re-session that
    // never started) — a zero-position row would be a lie, not a save.
    // gap-F6: "played" means the WATCHED position — real advancement or an
    // explicit user seek — never the displayed one, which can be a
    // relocated origin the viewer never saw a frame of.
    const watched = watchedPositionRef.current;
    if (!session || watched === null || watched <= 0) return;
    reportProgressOnUnload(
      { serverUrl, itemId, sessionId: session.id },
      { positionMs: watched, durationMs: durationRef.current, state: progressStateRef.current },
    );
  };

  useEffect(() => {
    function onPageHide(): void {
      flushProgressRef.current();
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  useEffect(() => {
    return () => flushProgressRef.current();
  }, []);

  // ── Video element event wiring ──────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // browser-player-F4: resume evidence — the LANDED hard seek's position
    // became displayable, showing content from the TARGET's own source
    // region. This is the deliberate second half of the landing the
    // LEVEL_UPDATED handler leaves open: until evidence fires, the 20 s
    // timer armed at the 202 is still running and will surface the
    // timeout toast, so an at-EOF landing whose run has nothing
    // displayable can never wedge the player silently again. The
    // source-axis check (isLandingResumeEvidence, lib/source-time.ts)
    // keeps a seek the UA CLAMPED onto the OLD content's tail — `seeked`
    // fired, old data under the playhead, presentation position within
    // ms of the run's start — from counting as success.
    const maybeCompleteLanding = (): void => {
      const landed = landedAwaitingResumeRef.current;
      if (!landed) return;
      if (isLandingResumeEvidence(landed, video.currentTime, video.readyState, listedFragments())) {
        clearLandingWatch();
      }
    };
    const onTimeUpdate = (): void => {
      maybeCompleteLanding();
      // gap-F6: consecutive-sample advancement probe. The baseline updates
      // on EVERY timeupdate (a jump both resets the baseline and is itself
      // rejected as advancement), including while relocating, so stale
      // pre-relocation baselines can never pair with post-landing samples.
      const previousProbeSec = advancementProbeSecRef.current;
      advancementProbeSecRef.current = video.currentTime;
      // V8 (§9.1.9): while relocating, the display stays frozen at the
      // hard-seek target — the element's own position is meaningless until
      // the landing completes (run discovered AND displayable).
      if (relocatingRef.current) return;
      // browser-player-F6: the displayed position comes from ONE resolver
      // (lib/source-clock.ts), in authority order — a TRUSTED listed
      // window (PDT mapping; refreshes the anchor), the presentation axis
      // only while this session has never shown a source clock
      // (direct-play; pre-V8 server — the axes coincide there), then the
      // landed-run/soft-seek anchor extrapolated 1:1. A null resolution
      // HOLDS the last displayed value: an unreadable or stale
      // (pre-landing) window must never put a wrong-axis number on the
      // clock — or, through the advancement gate below, into a progress
      // write. positionRef feeds the scrubber; the heartbeat reads
      // watchedPositionRef, which only real advancement (here) or an
      // explicit user seek may set.
      const frags = listedFragments();
      const resolved = resolveDisplayedSourceMs(sourceClockRef.current, frags, video.currentTime);
      sourceClockRef.current = resolved.state;
      if (resolved.ms === null) return;
      const ms = resolved.ms;
      positionRef.current = ms;
      setPositionMs(ms);
      if (
        isRealPlaybackAdvancement(previousProbeSec, video.currentTime, video.readyState, video.paused) &&
        isSourceContinuous(watchedPositionRef.current, ms, intendedStartMsRef.current)
      ) {
        watchedPositionRef.current = ms;
      }
      // Buffered bars only from an authoritative mapping: the trusted
      // window maps them exactly; raw ranges are exact wherever the
      // presentation axis applies at all; an anchored/held tick keeps the
      // previous bars rather than mapping ranges through an untrusted
      // window (a wrong bar is worse than a briefly-stale one).
      if (resolved.axis === "source-window" && frags) {
        setBuffered(bufferedRangesToSource(frags, readBuffered(video)));
      } else if (resolved.axis === "presentation") {
        setBuffered(readBuffered(video));
      }
    };
    // The element's own duration is authoritative only when it EXTENDS
    // what the session already told us. For an in-progress HLS transcode
    // the element reports the EVENT playlist's current extent (segments
    // produced so far) — unconditionally adopting it here clobbered the
    // real ffprobe duration from session.media.durationMs and pinned the
    // timeline of a 2-hour movie to ~24s (2026-08-08 owner QA). Growth is
    // always adopted — durationchange fires as the playlist extends, and a
    // direct-play file's real metadata may beat a stale probe — shrinkage
    // never is.
    //
    // Opus review Finding F (2026-08-10) exception: on a DIRECT-PLAY session
    // (`isDirectPlayRef.current`, docs/PLAYBACK.md §9's `manifestUrl===null`
    // discriminator — no HLS event playlist exists at all, so the "current
    // extent so far" concern above doesn't apply) the element's own duration
    // IS the file's real metadata, straight from the browser's own demuxer —
    // strictly more authoritative than the server's ffprobe-derived
    // `session.media.durationMs`, which can itself be an over-long probe
    // artifact (e.g. a container duration field that doesn't match the
    // actual decodable stream). Adopted unconditionally in that case, growth
    // or shrinkage alike; every other session (HLS transcode/direct-stream)
    // keeps the growth-only rule above unchanged.
    const adoptElementDuration = (): void => {
      if (!Number.isFinite(video.duration)) return;
      const candidateMs = video.duration * 1000;
      if (isDirectPlayRef.current) {
        durationRef.current = candidateMs;
        setDurationMs(candidateMs);
        return;
      }
      if (durationRef.current === null || candidateMs > durationRef.current) {
        durationRef.current = candidateMs;
        setDurationMs(candidateMs);
      }
    };
    const onLoadedMetadata = adoptElementDuration;
    const onDurationChange = adoptElementDuration;
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
      // A landed at/near-EOF seek that plays out its final segment ends
      // here — the mapped end position sits within the resume window, so
      // the same evidence predicate completes the lifecycle. (An `ended`
      // reached on OLD content while a landing is still pending is NOT
      // completion — the predicate rejects it and the timeout stays.)
      maybeCompleteLanding();
      progressStateRef.current = "played";
      heartbeatRef.current?.flushNow();
      heartbeatRef.current?.stop();
    };
    const onWaiting = (): void => setBuffering(true);
    const onPlaying = (): void => {
      maybeCompleteLanding();
      setBuffering(false);
      // browser-player-F1: a stretch that reaches real playback again
      // earns a fresh recovery budget. The direct-play/native-HLS attach
      // effect has its own `playing` listener doing this, but that effect
      // never runs on the hls.js path (activeSrcUrl is null there) — this
      // is the reset BOTH attach modes actually share.
      recoveryAttemptsRef.current = 0;
    };
    // V8 (§9.1.9, QA 2026-08-12): a PAUSED element never fires `playing`,
    // so `playing` as the only clearer latched the spinner forever on any
    // seek-while-paused — even when the data had long since arrived.
    // `seeked` and `canplay` both mean "the position is displayable now".
    const onSeeked = (): void => {
      maybeCompleteLanding();
      setBuffering(false);
    };
    const onCanPlay = (): void => {
      maybeCompleteLanding();
      setBuffering(false);
    };
    const onVolumeChange = (): void => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [phase, listedFragments, clearLandingWatch]);

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

  // ── V8 seek algorithm (docs/PLAYBACK.md §9.1.9) ──────────────────────────
  // `ms` is SOURCE time (the scrubber's axis). SOFT when a LISTED fragment
  // covers it (A2 — buffered or not: hls.js fetches listed fragments
  // locally); HARD (endpoint + landing watch) when it is outside the
  // window; the pre-V8 bare assignment survives only as the no-source-clock
  // fallback (direct-play; a pre-V8 server), where presentation == source.
  const hardSeek = useCallback(
    (targetMs: number): void => {
      const sessionId = session?.id;
      if (!sessionId) {
        // gap-F4: NEVER a silent drop. No session means nothing can POST
        // yet (only reachable before the create resolves) — the intent is
        // already queued in pendingSeekMsRef (seek() pins it before every
        // dispatch; the attach path replays it), so reflect it in the UI
        // instead of leaving the scrubber wherever the drag started.
        const queued = Math.max(0, Math.round(targetMs));
        pendingSeekMsRef.current = queued;
        positionRef.current = queued;
        setPositionMs(queued);
        return;
      }
      // Take the supersession epoch BEFORE the POST: if another hard seek
      // (or anything that clears the watch) happens while this request is
      // in flight, this response is stale and must not arm.
      seekEpochRef.current += 1;
      const epoch = seekEpochRef.current;
      const hls = hlsRef.current;
      // §9.1.7: carry the quality selector's pinned rung, if any — one
      // write, one restart. `nextLevel` only differs from -1 under a
      // manual pin.
      const pinnedRung = hls && !hls.autoLevelEnabled && hls.nextLevel >= 0 ? hls.nextLevel : undefined;
      void apiPost("/playback/sessions/{id}/seek", {
        params: { path: { id: sessionId } },
        body: { targetMs: Math.max(0, Math.round(targetMs)), ...(pinnedRung !== undefined ? { rungIndex: pinnedRung } : {}) },
      })
        .then((accepted) => {
          // gap-F4: superseded while in flight (a newer hard seek took the
          // epoch, or a soft seek / teardown cleared the watch) — the
          // newer owner of the relocating state wins; arming here would
          // pin the scrubber at a DEAD target.
          if (seekEpochRef.current !== epoch) return;
          const clamped = accepted.targetMs;
          // Arm/re-arm the landing watch against the CURRENT window — a
          // re-seek before landing replaces the watch, and the newest
          // clamped target wins (earlier seek runs are dead runs). A
          // predecessor stuck landed-but-unresumed (browser-player-F4) is
          // superseded the same way.
          landedAwaitingResumeRef.current = null;
          landingWatchRef.current = armLandingWatch(listedFragments(), clamped, Date.now());
          relocatingRef.current = { targetMs: clamped };
          setRelocating({ targetMs: clamped });
          positionRef.current = clamped;
          // gap-F6: a HARD seek is explicit user intent too — the clamped
          // 202 target is the viewer's chosen resume point even if they
          // pause/leave before the landing completes.
          watchedPositionRef.current = clamped;
          setPositionMs(clamped);
          if (landingTimerRef.current) clearTimeout(landingTimerRef.current);
          landingTimerRef.current = setTimeout(() => {
            // Bounded, never an indefinite spinner (§9.1.9): leave
            // relocating and surface a retryable error.
            clearLandingWatch();
            showToast("Seek timed out — the transcoder did not restart in time. Try seeking again.");
          }, HARD_SEEK_LANDING_TIMEOUT_MS);
          // A1 (design-pinned): after ENDLIST hls.js stops polling the
          // playlist, so the landing watch below could never fire — the
          // POST lands, the playlist un-ends, and nobody re-reads it.
          // Entering relocating on an ENDLIST-seen session MUST restart
          // playlist loading. gap-F4: `startLoad()` ALONE was inert here —
          // hls.js's shouldLoadPlaylist refuses to reload a VOD
          // (`details.live === false`) level — so the frozen level(s) must
          // be re-opened first (reopenEndedLevels, lib/relocation-nudge.ts;
          // the nudge below repeats it per tick, covering the re-read that
          // races the worker restart and comes back still-ENDLIST).
          if (hls && reopenEndedLevels(hls)) {
            hls.startLoad();
          }
          // Discovery-latency fix (2026-08-20): the worker folds the
          // restarted run's first segment into the served playlist well
          // under a second after this 202, but hls.js re-reads a live
          // playlist only on its own targetduration cadence (up to ~6 s).
          // Nudge a re-read once per second while relocating; the landing
          // listener's clearLandingWatch stops it.
          if (hls) {
            nudgeStopRef.current?.();
            nudgeStopRef.current = startRelocationNudge(
              () => hlsRef.current,
              () => relocatingRef.current !== null,
            );
          }
          // Native-HLS coarse landing (no hls.js instance to watch): land
          // at the seekable end once it moves past its armed extent —
          // the restarted run's segments are the only thing that can grow
          // it. Precise landing: loombre-apple follow-up (§9.1.10 item 5).
          if (!hls) {
            // gap-F4: a re-seek must SUPERSEDE the previous coarse poll,
            // not stack a second interval beside it (the overwritten id
            // leaked and the dead seek could still land).
            if (coarsePollRef.current) clearInterval(coarsePollRef.current);
            const armedEnd = seekableEndSec(videoRef.current);
            coarsePollRef.current = setInterval(() => {
              const v = videoRef.current;
              if (!v) return;
              const end = seekableEndSec(v);
              if (end !== null && (armedEnd === null || end > armedEnd + 1)) {
                // browser-player-F4: same partial transition as the hls.js
                // landing — stop the poll but keep the 20 s timer and the
                // pin until the landed position is actually displayable.
                if (coarsePollRef.current) {
                  clearInterval(coarsePollRef.current);
                  coarsePollRef.current = null;
                }
                const startSec = Math.max(0, end - 0.25);
                landedAwaitingResumeRef.current = { startSec, targetMs: clamped };
                v.currentTime = startSec;
                heartbeatRef.current?.flushNow();
              }
            }, 500);
          }
        })
        .catch(() => {
          // gap-F4: a superseded request's failure is not THIS seek's
          // failure — clearing here would tear down the NEWER seek's
          // watch and toast over a seek the user no longer cares about.
          if (seekEpochRef.current !== epoch) return;
          clearLandingWatch();
          showToast("Seek failed — check the connection and try again.");
        });
    },
    [session?.id, listedFragments, clearLandingWatch, showToast],
  );
  hardSeekRef.current = hardSeek;

  const seek = useCallback(
    (ms: number) => {
      const video = videoRef.current;
      if (!video) return;
      // Pin the user's intent for any re-attach (V8): recovery restores
      // the last seek target, not the session's original resume point.
      pendingSeekMsRef.current = ms;
      const frags = listedFragments();
      if (frags && hasSourceClock(frags)) {
        const presentationSec = sourceToPresentationSec(frags, ms);
        if (presentationSec !== null) {
          // SOFT — listed (A2), served from disk; no server round-trip.
          clearLandingWatch();
          video.currentTime = presentationSec;
          positionRef.current = ms;
          watchedPositionRef.current = ms; // gap-F6: explicit user intent
          // browser-player-F6: a soft-seek commit is an exact axis pair —
          // re-anchor so a mapping outage right after the jump holds/
          // extrapolates from HERE, not from the pre-seek position.
          sourceClockRef.current = anchorAtExplicitPosition(sourceClockRef.current, presentationSec, ms);
          setPositionMs(ms);
          heartbeatRef.current?.flushNow();
          return;
        }
        hardSeek(ms);
        return;
      }
      // Native-HLS transcode sessions (iOS Safari — MSE-less, so no hls.js
      // instance): the V8 v1 COARSE path (ruled). Safari surfaces §9.1.5
      // rule 7's PDT as `getStartDate()`, anchoring the same source clock.
      if (attachStrategy === "native-hls" && session && !isDirectPlayRef.current) {
        const anchorMs = nativeSourceAnchorMs(video);
        if (anchorMs !== null) {
          const presentationSec = (ms - anchorMs) / 1000;
          if (isInSeekable(video, presentationSec)) {
            clearLandingWatch();
            video.currentTime = presentationSec;
            positionRef.current = ms;
            watchedPositionRef.current = ms; // gap-F6: explicit user intent
            setPositionMs(ms);
            heartbeatRef.current?.flushNow();
            return;
          }
          hardSeek(ms);
          return;
        }
      }
      // No source clock (direct-play; native path without PDT; a pre-V8
      // server): presentation == source for these sessions — the pre-V8
      // bare assignment is exactly right.
      video.currentTime = Math.max(0, ms / 1000);
      positionRef.current = ms;
      watchedPositionRef.current = ms; // gap-F6: explicit user intent
      setPositionMs(ms);
      heartbeatRef.current?.flushNow();
    },
    [listedFragments, hardSeek, clearLandingWatch, attachStrategy, session],
  );

  const seekRelative = useCallback(
    (deltaMs: number) => {
      const video = videoRef.current;
      if (!video) return;
      // positionRef holds SOURCE ms (PDT-derived on the hls.js path) —
      // the pre-V8 `video.currentTime * 1000` here was presentation time,
      // wrong on the source axis after any restart.
      seek(Math.max(0, positionRef.current + deltaMs));
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
          // Wave 2 L7 (U7) / LD-12(b): matches PlayerControls' skip-forward
          // button exactly — see that file's header for why the amount
          // moved (a symmetric ±10s -> back-15/forward-30 -> back to a
          // symmetric ±10s, now with the baked-in-numeral glyphs) —
          // keyboard and click must always agree on the actual amount.
          seekRelative(10_000);
          break;
        case "ArrowLeft":
          seekRelative(-10_000);
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
    // gap-F6: choosing Resume IS choosing that position — record it as the
    // watched anchor so post-resume advancement passes source continuity
    // (and a resume-then-leave keeps reporting the same resume point, as
    // it always did).
    if (resumeCandidateMs !== null) watchedPositionRef.current = resumeCandidateMs;
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
    isDirectPlayRef.current = result.session.manifestUrl === null;
    sourceClockRef.current = initialSourceClockState();
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
      {/* N3's player checkpoint: mounted directly inside stageRef (the
          fullscreen target) so a notice survives the real Fullscreen API,
          regardless of `phase` — see NoticeOverlayStrip.tsx's header.
          belowControls mirrors PlayerControls' own `visible` expression so
          the strip yields the top band whenever the back-button bar is
          shown (review R-F4). */}
      <NoticeOverlayStrip belowControls={controlsVisible || !isPlaying} />
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
            buffering={buffering || relocating !== null}
            audioStreams={session?.media?.audio ?? []}
            subtitleStreams={session?.media?.subtitle ?? []}
            selectedAudioIndex={selectedAudioIndex}
            selectedSubtitleIndex={selectedSubtitleIndex}
            chapters={chapters}
            // H6 (W3 fidelity audit, FX4): PlayerControls' capability chips
            // read the session's REAL decision — this is the one-line seam
            // threading it through; VideoPlayer.tsx itself is outside FX4's
            // exclusive file list, so this is deliberately the only touch.
            plan={session?.plan ?? null}
            videoElement={videoRef.current}
            directPlay={attachStrategy === "direct-play"}
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
          {/* §9.1.9's ONE new piece of player UI. Rendered beside the
              controls and only while they are visible; it returns null by
              itself whenever there is nothing to choose between (direct-play,
              or a single-variant master), so no extra guard is needed here.
              Pinning a level only sets `hls.nextLevel` — the server learns
              about it purely from the `v{K}` requests that follow. */}
          {(controlsVisible || !isPlaying) && (
            <div className={styles.qualityDock}>
              <QualitySelector
                levels={hlsLevels}
                currentLevel={currentHlsLevel}
                autoMode={hlsAutoMode}
                onSelect={(level) => {
                  const hls = hlsRef.current;
                  if (!hls) return;
                  hls.nextLevel = level;
                  setHlsAutoMode(level === -1);
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
