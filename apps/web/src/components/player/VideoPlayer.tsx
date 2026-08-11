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
  isSameUrlIgnoringToken,
  useHlsManifestUrl,
  useSessionFileUrl,
} from "../../lib/media-session-url.js";
import { decideAttachStrategy, isMseAvailable, isNativeHlsSupported } from "../../lib/hls-attach.js";
import { buildHlsJsConfig } from "../../lib/hls-js-config.js";
import { deriveSubtitleTrackInfo, type SubtitleTrackInfo } from "../../lib/subtitle-track.js";
import { clientPlaybackErrorReasons, resolveUnavailableReasons } from "../../lib/playback-reasons.js";
import { findPlayableFallback, decisionLabel, type FallbackCandidate } from "../../lib/playback-fallback.js";
import { findProgressForItem, isWorthResuming } from "../../lib/progress-lookup.js";
import { HeartbeatScheduler, type HeartbeatSnapshot, type ProgressState } from "../../lib/heartbeat.js";
import { reportProgressOnUnload } from "../../lib/progress-report.js";
import { apiGet, apiPut } from "../../lib/api-client.js";
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
// findings 1/2): the direct-play/native-HLS attach effect's bounded
// recovery path — shared by a fatal `error` event AND the stall watchdog
// below. RECOVERY_MIN_INTERVAL_MS is a per-attempt COOLDOWN, DEFERRED via
// setTimeout when hit (never dropped — see `scheduleRecoveryAttach`), not a
// suppression window: a stretch of genuinely-failing attaches gets at most
// MAX_RECOVERY_ATTEMPTS tries, no faster than one every
// RECOVERY_MIN_INTERVAL_MS, before falling through to the same
// fatal-unavailable path an unrecoverable decode/src-not-supported error
// already uses (`clientPlaybackErrorReasons`, lib/playback-reasons.ts).
const RECOVERY_MIN_INTERVAL_MS = 4000;
const MAX_RECOVERY_ATTEMPTS = 3;
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
  const positionRef = useRef(0);
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

    async function run(): Promise<void> {
      const result = await createPlaybackSession(itemId, "stream", mediaFileId);
      if (cancelled) {
        // AUD-A4v4-003: this invocation was superseded (itemId/mediaFileId/
        // startMs changed) or the player unmounted while the POST was in
        // flight — but the server row already exists. It never reaches
        // `session` state, so the sibling unmount cleanup below can never
        // end it; end it HERE, or with the shipped default
        // maxSimultaneousTranscodes = 1 a single orphan holds the
        // household's only transcode slot until the 15-minute idle sweeper
        // (docs/PLAYBACK.md §9).
        if (result.ok) void endPlaybackSession(result.session.id);
        return;
      }
      if (!result.ok) {
        setUnavailableReasons(resolveUnavailableReasons(result.status, result.wouldBeReasons));
        setUnavailableStatus(result.status);
        setPhase("unavailable");
        return;
      }
      setSession(result.session);
      setDurationMs(result.session.media?.durationMs ?? null);
      durationRef.current = result.session.media?.durationMs ?? null;
      isDirectPlayRef.current = result.session.manifestUrl === null;
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

    function goFatal(): void {
      // No reattach can fix this — either the browser already refused to
      // decode/support the source, or every bounded retry in this stretch
      // already failed identically. Route to the SAME fatal-unavailable
      // screen a refused createPlaybackSession already renders (`phase`,
      // UnavailableScreen below) instead of inventing new UI;
      // `clientPlaybackErrorReasons` (lib/playback-reasons.ts) follows the
      // exact precedent `TRANSCODE_SLOTS_EXHAUSTED_CODE` already set there
      // for a client-synthesized reason with no server HTTP status behind
      // it.
      setUnavailableReasons(clientPlaybackErrorReasons());
      setUnavailableStatus(undefined);
      setPhase("unavailable");
    }

    function runRecoveryAttach(): void {
      recoveryStampRef.current = Date.now();
      recoveryAttemptsRef.current += 1;
      attach();
    }

    function scheduleRecoveryAttach(): void {
      if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
        goFatal();
        return;
      }
      const elapsed = Date.now() - recoveryStampRef.current;
      if (elapsed >= RECOVERY_MIN_INTERVAL_MS) {
        runRecoveryAttach();
        return;
      }
      // Inside the cooldown: DEFER the retry to when it expires instead of
      // dropping it. The old bare `return` here silently killed an initial
      // attach that failed fast (nothing had ever stamped the cooldown
      // ref, so `Date.now() - 0` should have cleared it — but the OLD code
      // stamped on every attach, including that very initial one) — or any
      // retry that landed inside another retry's own cooldown — with no
      // further trigger ever coming, leaving the player permanently and
      // silently dead. One pending timer at a time; a second signal
      // arriving before it fires changes nothing.
      if (recoveryTimeoutHandle) return;
      recoveryTimeoutHandle = setTimeout(() => {
        recoveryTimeoutHandle = null;
        runRecoveryAttach();
      }, RECOVERY_MIN_INTERVAL_MS - elapsed);
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
    if (!session || positionRef.current <= 0) return;
    reportProgressOnUnload(
      { serverUrl, itemId, sessionId: session.id },
      { positionMs: positionRef.current, durationMs: durationRef.current, state: progressStateRef.current },
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

    const onTimeUpdate = (): void => {
      const ms = video.currentTime * 1000;
      positionRef.current = ms;
      setPositionMs(ms);
      setBuffered(readBuffered(video));
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
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
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
    isDirectPlayRef.current = result.session.manifestUrl === null;
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
            buffering={buffering}
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
        </>
      )}
    </div>
  );
}
