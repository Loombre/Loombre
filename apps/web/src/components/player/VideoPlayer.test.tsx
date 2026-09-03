// SPDX-License-Identifier: AGPL-3.0-only

// Component-level coverage of the player state machine itself — the DOM/
// event wiring the lib/ unit tests (heartbeat, hls-attach, playback-session,
// …) cannot see by construction: which media FILE the session is created
// for, play/pause dispatch, seek + its immediate progress flush,
// audio-track selection reaching the real element, and the teardown flush
// on an in-app Back (a router.back() unmount, which fires no `pagehide` at
// all).
//
// jsdom implements almost none of HTMLMediaElement's behavior — play/pause
// are "not implemented" no-ops, `paused` is a constant, `currentTime` is
// unwritable, and `loadedmetadata` is never dispatched. `installMediaStubs`
// below replaces exactly the surface this component touches with a
// per-element fake, so the events the state machine listens for are the
// ones the test drives. Every test file gets its own jsdom, so the
// prototype patch is installed once at module scope and never restored.

import { act, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { LoombreApiError } from "@loombre/sdk";
import { HARD_SEEK_LANDING_TIMEOUT_MS } from "../../lib/source-time.js";
import { HARD_SEEK_COALESCE_MS } from "../../lib/seek-coalesce.js";
import { formatSeekFailedToast, formatSeekTimedOutToast } from "../../lib/seek-toast.js";
import { describeSessionFailureCode, SESSION_ENDED_CODE } from "../../lib/playback-recovery.js";
import { resetPlaybackSessionLeases } from "../../lib/playback-session-lease.js";
import { VideoPlayer } from "./VideoPlayer.js";
import { ToastProvider } from "../ui/Toast.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];
type AudioStream = components["schemas"]["AudioStream"];

const SERVER_URL = "http://localhost:9000";
const ITEM_ID = "01890000-0000-7000-8000-000000000001";
const SESSION_ID = "01890000-0000-7000-8000-0000000000aa";
/** A second session id — the SUPERSEDING create in the orphaned-session
 *  tests below (AUD-A4v4-003). */
const SECOND_SESSION_ID = "01890000-0000-7000-8000-0000000000ab";
/** A NON-default media_files row for the same item — the "4K" / alternate-cut
 *  version a user picks from a detail page's Versions list. */
const ALT_FILE_ID = "01890000-0000-7000-8000-0000000000d9";

const createPlaybackSession = vi.fn();
const endPlaybackSession = vi.fn();
// browser-player-F5: the keepalive DELETE twin of reportProgressOnUnload —
// the ONLY session-end path that survives a genuine full-document teardown
// (real navigation / tab close), where React unmount cleanups never run.
const endPlaybackSessionOnUnload = vi.fn();
const findProgressForItem = vi.fn();
const reportProgressOnUnload = vi.fn();
const apiPut = vi.fn();
// S7/K9: GET /items/{id}/chapters, fetched once per item — see
// VideoPlayer.tsx's "Chapters" effect. Defaults to zero chapters
// (beforeEach below) so every pre-existing test in this file, none of
// which cares about chapters, is unaffected.
const apiGet = vi.fn();

vi.mock("../../lib/playback-session.js", () => ({
  createPlaybackSession: (...args: unknown[]) => createPlaybackSession(...args),
  endPlaybackSession: (...args: unknown[]) => endPlaybackSession(...args),
  endPlaybackSessionOnUnload: (...args: unknown[]) => endPlaybackSessionOnUnload(...args),
}));

vi.mock("../../lib/item-lookup.js", () => ({
  fetchItemSummary: async () => ({
    id: ITEM_ID,
    itemType: "movie",
    title: "Arrival",
    subtitle: null,
    images: [],
    durationMs: 600_000,
    mediaFiles: [],
  }),
  backdropImage: () => null,
}));

vi.mock("../../lib/progress-lookup.js", () => ({
  findProgressForItem: (...args: unknown[]) => findProgressForItem(...args),
  isWorthResuming: (p: { positionMs: number }) => p.positionMs >= 5000,
}));

vi.mock("../../lib/progress-report.js", () => ({
  reportProgressOnUnload: (...args: unknown[]) => reportProgressOnUnload(...args),
}));

// gap-F4: POST …/seek (the V8 hard-seek endpoint) goes through apiPost —
// hoisted like the others so the hard-seek tests below can control the 202
// responses (and their ORDER — the newest-wins re-arm race needs two
// deferred responses resolved out of order).
const apiPost = vi.fn();

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPut: (...args: unknown[]) => apiPut(...args),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

// ── hls.js mock (gap-F4 hard-seek tests) ─────────────────────────────────
// VideoPlayer imports hls.js DYNAMICALLY inside the 'hlsjs' attach effect;
// vitest intercepts that import with this factory. The mock records the
// calls the V8 hard-seek path drives (startLoad/stopLoad) and exposes
// `levels`/`currentLevel` so lib/source-time's listedFragments mapping and
// the §9.1.5 rule 5 (post-ENDLIST) lever have a real surface to act on.
// Instances register on `hlsInstances` so tests can reach the one the
// attach effect created.
interface MockHlsInstance {
  /** `uri` mirrors hls.js Level.uri — set by the d4-a1.113 tests so the
   *  relocation nudge's playlist-only reload lever is addressable; tests
   *  that omit it exercise the stopLoad/startLoad fallback exactly as
   *  before. */
  levels: { details?: { live: boolean; fragments: unknown[] }; uri?: string }[];
  currentLevel: number;
  /** hls.js's "level whose playlist is being loaded" — what the player
   *  falls back to before any frame has PLAYED (currentLevel still -1,
   *  d3-a1: resolveStartLevel starts loading the TOP rung, so level 0's
   *  details never exist at that point). */
  loadLevel: number;
  nextLevel: number;
  autoLevelEnabled: boolean;
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
  calls: string[];
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb?: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  trigger(event: string, data?: unknown): void;
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  detachMedia(): void;
  startLoad(pos?: number, skipSeekToStartPosition?: boolean): void;
  stopLoad(): void;
  recoverMediaError(): void;
  destroy(): void;
}
const hlsInstances: MockHlsInstance[] = [];
vi.mock("hls.js", () => {
  class MockHls implements MockHlsInstance {
    static isSupported = (): boolean => true;
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed",
      LEVEL_SWITCHING: "hlsLevelSwitching",
      LEVEL_SWITCHED: "hlsLevelSwitched",
      LEVEL_UPDATED: "hlsLevelUpdated",
      LEVEL_LOADING: "hlsLevelLoading",
      BUFFER_EOS: "hlsBufferEos",
      ERROR: "hlsError",
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    levels: { details?: { live: boolean; fragments: unknown[] }; uri?: string }[] = [];
    currentLevel = -1;
    loadLevel = -1;
    nextLevel = -1;
    autoLevelEnabled = true;
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    calls: string[] = [];
    constructor() {
      hlsInstances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    off(): void {}
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
    /** Real hls.js's app-facing event injection (the d3-a2 second-ENDLIST
     *  watch drives BUFFER_EOS through it) — recorded like the other
     *  levers, and delivered to listeners like the real emitter. */
    trigger(event: string, data?: unknown): void {
      this.calls.push(`trigger(${event})`);
      this.emit(event, event, data);
    }
    loadSource(): void {
      this.calls.push("loadSource");
    }
    attachMedia(): void {
      this.calls.push("attachMedia");
    }
    detachMedia(): void {
      this.calls.push("detachMedia");
    }
    startLoad(pos?: number, skipSeekToStartPosition?: boolean): void {
      // Two-arg calls (the d3-a2 rebuild + the relocation nudge) record the
      // skip flag too — seekToStartPosition suppression is load-bearing
      // there; legacy single-arg call sites keep their historical strings.
      this.calls.push(skipSeekToStartPosition === undefined ? `startLoad(${pos})` : `startLoad(${pos},${skipSeekToStartPosition})`);
    }
    stopLoad(): void {
      this.calls.push("stopLoad");
    }
    recoverMediaError(): void {
      this.calls.push("recoverMediaError");
    }
    destroy(): void {
      this.calls.push("destroy");
    }
  }
  return { default: MockHls };
});

// This file is about playback mechanics, not system notices — the strip's
// own rendering rules (severity, dismiss, countdown) get their own
// coverage in NoticeOverlayStrip.test.tsx. Mocked away here exactly like
// the other unrelated collaborators above, so VideoPlayer can render
// without a real <SystemNoticeProvider> in the tree. Dynamic (a `let`, not
// a fixed literal) so the ONE structural test below — "the strip mounts
// inside the real stage element" — can arm an active notice; every other
// test in this file never touches it and gets the inert default.
let noticeMockValue = {
  notice: null as { id: string; message: string; severity: string; effectiveAtMs: number | null; expiresAtMs: number | null; createdAtMs: number } | null,
  severity: null as string | null,
  serverOffsetMs: 0,
  dismissed: false,
  dismiss: vi.fn(),
  bannerVisible: false,
};
vi.mock("../notices/SystemNoticeProvider.js", () => ({
  useSystemNotice: () => noticeMockValue,
}));

// A `let`, not a fixed literal, so the token-refresh tests below (task #6)
// can rotate it mid-test and have `useSessionFileUrl`/`useHlsManifestUrl`'s
// polling (media-session-url.ts's `useTokenUrl`) pick up the new value —
// every other test in this file never reassigns it and gets the same
// static token throughout, unaffected.
let mockAccessToken = "test-access-token";
vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: SERVER_URL, accessToken: mockAccessToken }),
    getAccessToken: async () => mockAccessToken,
  }),
}));

// ── media-element fake ────────────────────────────────────────────────────
interface FakeMediaState {
  paused: boolean;
  currentTime: number;
  volume: number;
  muted: boolean;
  audioTracks: { id: string; enabled: boolean }[];
  /** W3C HTMLMediaElement.readyState — 0 (HAVE_NOTHING) by default, the
   *  same as a real element that never got data for its position. The
   *  browser-player-F4 landing-lifecycle tests raise it to simulate the
   *  landed position actually becoming displayable. */
  readyState: number;
  ended: boolean;
  /** Element buffered ranges as [startSec, endSec] pairs — empty by
   *  default (jsdom has no real TimeRanges). The d3-a2 second-ENDLIST
   *  watch tests set them to simulate appended media. */
  bufferedRanges: [number, number][];
}

const mediaStates = new WeakMap<HTMLMediaElement, FakeMediaState>();

function mediaState(el: HTMLMediaElement): FakeMediaState {
  let state = mediaStates.get(el);
  if (!state) {
    state = {
      paused: true,
      currentTime: 0,
      volume: 1,
      muted: false,
      audioTracks: [
        { id: "0", enabled: true },
        { id: "1", enabled: false },
      ],
      readyState: 0,
      ended: false,
      bufferedRanges: [],
    };
    mediaStates.set(el, state);
  }
  return state;
}

/** jsdom has no window.matchMedia, which ResumePrompt's SheetOrModal needs
 *  (see ResumePrompt.test.tsx's identical note). */
function installMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  );
}

function installMediaStubs(): void {
  const proto = HTMLMediaElement.prototype;
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };

  define("play", {
    value(this: HTMLMediaElement) {
      mediaState(this).paused = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    },
  });
  define("pause", {
    value(this: HTMLMediaElement) {
      mediaState(this).paused = true;
      this.dispatchEvent(new Event("pause"));
    },
  });
  define("load", {
    // Real HTMLMediaElement.load() resets playback position AND pauses the
    // element (WHATWG "resource selection algorithm" §4.8.12.5 step 3: sets
    // `paused` to true) — the task #6 token-refresh recovery tests below
    // assert VideoPlayer's src-swap position/paused-state RESTORE round
    // trip, which only means something if the stub actually clears both
    // first, the same as a real browser would.
    value(this: HTMLMediaElement) {
      const state = mediaState(this);
      state.currentTime = 0;
      state.paused = true;
    },
  });
  define("canPlayType", { value: () => "" });
  define("paused", { get(this: HTMLMediaElement) { return mediaState(this).paused; } });
  define("currentTime", {
    get(this: HTMLMediaElement) { return mediaState(this).currentTime; },
    set(this: HTMLMediaElement, value: number) { mediaState(this).currentTime = value; },
  });
  define("duration", { get: () => 600 });
  define("readyState", { get(this: HTMLMediaElement) { return mediaState(this).readyState; } });
  define("ended", { get(this: HTMLMediaElement) { return mediaState(this).ended; } });
  define("buffered", {
    get(this: HTMLMediaElement) {
      const pairs = mediaState(this).bufferedRanges;
      return { length: pairs.length, start: (i: number) => pairs[i]?.[0] ?? 0, end: (i: number) => pairs[i]?.[1] ?? 0 };
    },
  });
  define("audioTracks", { get(this: HTMLMediaElement) { return mediaState(this).audioTracks; } });
  define("volume", {
    get(this: HTMLMediaElement) { return mediaState(this).volume; },
    set(this: HTMLMediaElement, value: number) {
      mediaState(this).volume = value;
      this.dispatchEvent(new Event("volumechange"));
    },
  });
  define("muted", {
    get(this: HTMLMediaElement) { return mediaState(this).muted; },
    set(this: HTMLMediaElement, value: boolean) {
      mediaState(this).muted = value;
      this.dispatchEvent(new Event("volumechange"));
    },
  });
}

installMediaStubs();

// ── fixtures ──────────────────────────────────────────────────────────────
function audio(index: number, overrides: Partial<AudioStream> = {}): AudioStream {
  return {
    index,
    codec: "eac3",
    channels: 6,
    sampleRate: 48_000,
    bitrateBps: 640_000,
    language: "eng",
    isDefault: index === 1,
    hasAtmos: false,
    ...overrides,
  };
}

/** A direct-play session (manifestUrl null — docs/PLAYBACK.md §9), so
 *  `attachStrategy` resolves to 'direct-play' and the audio picker is live. */
function directPlaySession(): PlaybackSession {
  return {
    id: SESSION_ID,
    itemId: ITEM_ID,
    userId: "01890000-0000-7000-8000-0000000000b1",
    deviceId: "01890000-0000-7000-8000-0000000000c1",
    plan: {
      decision: "direct-play",
      reasons: [],
      container: "source",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      ladder: [],
      ffmpegArgs: [],
      engineVersion: "1.0.0",
    },
    media: {
      fileId: "01890000-0000-7000-8000-0000000000d1",
      container: "mkv",
      durationMs: 600_000,
      sizeBytes: 8_000_000_000,
      overallBitrateBps: 10_000_000,
      video: [],
      audio: [audio(1), audio(2, { codec: "aac", channels: 2, isDefault: false })],
      subtitle: [],
    },
    status: "created",
    errorCode: null,
    manifestUrl: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

/** An HLS session (manifestUrl SET — docs/PLAYBACK.md §9), so
 *  `isDirectPlayRef` resolves false and duration-adoption stays growth-only
 *  (opus review Finding F, 2026-08-10: growth-only is now direct-play-vs-not
 *  branched, so the "never lets a smaller duration clobber" regression guard
 *  below needs a genuinely non-direct-play session to keep meaning what its
 *  own comment says — a direct-play session now adopts shrinkage on
 *  purpose, see the "direct-play... corrects an over-long probe duration"
 *  case further down). jsdom has neither `MediaSource` nor a working
 *  `canPlayType`, so `decideAttachStrategy` falls to the 'hlsjs' last-ditch
 *  branch and the component's own attach effect attempts (and harmlessly
 *  fails/no-ops) a real hls.js import — verified not to hang or throw
 *  synchronously in this suite; the duration-adoption effect under test
 *  here is wired independently of that attach effect. */
function hlsTranscodeSession(): PlaybackSession {
  return {
    ...directPlaySession(),
    plan: {
      decision: "direct-stream",
      reasons: [{ code: "container-not-direct-playable" }],
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      ladder: [],
      ffmpegArgs: [],
      engineVersion: "1.0.0",
    },
    manifestUrl: `/v1/playback/sessions/${SESSION_ID}/hls/media.m3u8`,
  };
}

function videoEl(view: TestRender): HTMLVideoElement {
  const el = view.container.querySelector("video");
  if (!el) throw new Error("no <video> rendered");
  return el;
}

function button(view: TestRender, label: string): HTMLButtonElement {
  const el = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled "${label}"`);
  return el;
}

/** gap-F6: progress writes need REAL playback advancement, so a test that
 *  means "the viewer watched up to `seconds`" must simulate a faithfully
 *  playing element — displayable data (readyState 4) and a continuous walk
 *  of close `timeupdate` samples from 0 — rather than one teleport jump,
 *  which the watched-position gate rightly ignores as a discontinuity
 *  (both on the presentation axis and on the source axis). */
async function simulateWatchedTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  await act(async () => {
    if (video.paused) await video.play();
    mediaState(video).readyState = 4;
    for (let t = 0; t < seconds; t += 2.5) {
      video.currentTime = t;
      video.dispatchEvent(new Event("timeupdate"));
    }
    video.currentTime = seconds;
    video.dispatchEvent(new Event("timeupdate"));
  });
}

/** Renders and settles the two awaited lookups (session create, then the
 *  progress lookup) so the component reaches phase 'ready'. */
async function renderReady(onBack = vi.fn(), mediaFileId?: string, startMs?: number): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderIntoBody(
      <ToastProvider>
        <VideoPlayer
          itemId={ITEM_ID}
          onBack={onBack}
          {...(mediaFileId ? { mediaFileId } : {})}
          {...(startMs !== undefined ? { startMs } : {})}
        />
      </ToastProvider>,
    );
  });
  if (!view) throw new Error("render produced nothing");
  return view;
}

describe("VideoPlayer", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    installMatchMedia();
    // gap-F1: the lease pool is module-scope by design (it has to outlive
    // any one component instance) — disown anything a previous test left
    // in flight so a stale settle can never join, or end into, this test.
    resetPlaybackSessionLeases();
    createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
    endPlaybackSession.mockReset().mockResolvedValue(undefined);
    endPlaybackSessionOnUnload.mockReset().mockReturnValue(true);
    findProgressForItem.mockReset().mockResolvedValue(null);
    reportProgressOnUnload.mockReset();
    apiPut.mockReset().mockResolvedValue(undefined);
    apiGet.mockReset().mockResolvedValue({ items: [] });
    apiPost.mockReset().mockResolvedValue({ targetMs: 0 });
    hlsInstances.length = 0;
    noticeMockValue = { notice: null, severity: null, serverOffsetMs: 0, dismissed: false, dismiss: vi.fn(), bannerVisible: false };
    mockAccessToken = "test-access-token";
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // The native-HLS token-refresh tests below temporarily claim native HLS
    // support (`canPlayType` -> "maybe") to route `attachStrategy` to
    // 'native-hls' — reset unconditionally so a test that forgets its own
    // cleanup (or fails before reaching it) can never leak into a later
    // test's attach-strategy decision.
    Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", { configurable: true, value: () => "" });
  });

  // REGRESSION GUARD (77-agent review, "every per-version Play button starts
  // the same DEFAULT media file"): the version the user actually picked has
  // to reach the PlanRequest, not just the <a href> that carried it here
  // (components/detail/VersionRow.tsx + its own test cover that first hop).
  it("pins the initial session to the picked version's file", async () => {
    view = await renderReady(vi.fn(), ALT_FILE_ID);
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", ALT_FILE_ID);
  });

  it("leaves the file unpinned when no version was picked, so the server's primary file wins", async () => {
    view = await renderReady();
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", undefined);
  });

  it("toggles play/pause through the element and reflects the element's own events", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    expect(video.paused).toBe(true);

    const play = button(v, "Play");
    await act(async () => play.click());
    expect(video.paused).toBe(false);
    expect(button(v, "Pause")).toBeTruthy();

    await act(async () => button(v, "Pause").click());
    expect(video.paused).toBe(true);
    expect(button(v, "Play")).toBeTruthy();
  });

  it("seeks the element and flushes progress immediately, with the amounts the glyphs promise", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await act(async () => button(v, "Forward 10 seconds").click());
    expect(video.currentTime).toBe(10);
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut.mock.calls[0]?.[1]).toMatchObject({
      body: { positionMs: 10_000, durationMs: 600_000, state: "in-progress", sessionId: SESSION_ID },
    });

    await act(async () => button(v, "Back 10 seconds").click());
    expect(video.currentTime).toBe(0);
    expect(apiPut).toHaveBeenCalledTimes(2);
    expect(apiPut.mock.calls[1]?.[1]).toMatchObject({ body: { positionMs: 0 } });
  });

  it("flushes progress when the element pauses", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await act(async () => button(v, "Play").click());
    apiPut.mockClear();
    await simulateWatchedTo(video, 42);
    await act(async () => {
      video.pause();
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut.mock.calls[0]?.[1]).toMatchObject({ body: { positionMs: 42_000 } });
  });

  // ── V8 design pins (docs/PLAYBACK.md §9.1.9; QA 2026-08-12) ─────────────
  // Pre-V8, `playing` was the ONLY clearer of the buffering flag — an event
  // a PAUSED element never fires. Any seek-while-paused latched the spinner
  // forever even after the data arrived ("buffers forever", symptom 2's
  // client half).
  function bufferingSpinner(v: TestRender): Element | null {
    return v.container.querySelector('[class*="buffering"]');
  }

  it("V8: `seeked` clears the buffering spinner while PAUSED (the seek-while-paused latch)", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    expect(video.paused).toBe(true);

    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
    expect(bufferingSpinner(v), "waiting must raise the spinner").not.toBeNull();

    // The element completes the seek while still paused — `playing` will
    // never fire here.
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(bufferingSpinner(v), "seeked must clear it — a paused element never fires playing").toBeNull();
  });

  it("V8: `canplay` clears the buffering spinner while PAUSED", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
    expect(bufferingSpinner(v)).not.toBeNull();

    await act(async () => {
      video.dispatchEvent(new Event("canplay"));
    });
    expect(bufferingSpinner(v)).toBeNull();
  });

  it("never lets the element's SMALLER duration clobber the session's ffprobe duration (non-direct-play only)", async () => {
    // Field bug (2026-08-08 owner QA): for an in-progress HLS transcode the
    // element's own `duration` is only the EVENT playlist's current extent
    // (segments produced so far ≈ 24s of a 2-hour movie), and the old
    // unconditional loadedmetadata adoption overwrote the authoritative
    // session.media.durationMs with it — pinning the timeline to ~24s.
    // Opus review Finding F (2026-08-10) narrowed growth-only to sessions
    // that are genuinely NOT direct-play (see hlsTranscodeSession's own
    // comment, and the direct-play shrink case right below) — this case
    // now pins that half explicitly rather than relying on the default
    // fixture happening to be direct-play too.
    createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
    const v = (view = await renderReady());
    const video = videoEl(v);
    Object.defineProperty(video, "duration", { get: () => 24, configurable: true });
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    const slider = v.container.querySelector('[role="slider"]');
    expect(slider?.getAttribute("aria-valuemax")).toBe("600000");
  });

  it("adopts duration GROWTH via durationchange (extending playlist / metadata beating a stale probe)", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    Object.defineProperty(video, "duration", { get: () => 700, configurable: true });
    await act(async () => {
      video.dispatchEvent(new Event("durationchange"));
    });
    const slider = v.container.querySelector('[role="slider"]');
    expect(slider?.getAttribute("aria-valuemax")).toBe("700000");
  });

  it("on a DIRECT-PLAY session, adopts the element's duration UNCONDITIONALLY — including SHRINKAGE, correcting an over-long ffprobe duration", async () => {
    // Opus review Finding F (2026-08-10): growth-only exists to protect an
    // IN-PROGRESS HLS EVENT PLAYLIST's partial extent from clobbering the
    // real probe duration (the case above) — that concern doesn't exist on
    // direct-play at all (no HLS playlist; the element demuxes the actual
    // file). On direct-play the element's own duration is strictly MORE
    // authoritative than session.media.durationMs, which can itself be an
    // over-long ffprobe artifact (e.g. a container duration field that
    // overstates the actual decodable stream) — growth-only left THAT case
    // permanently uncorrectable. The default fixture (directPlaySession(),
    // this describe block's own beforeEach) already has manifestUrl: null.
    const v = (view = await renderReady());
    const video = videoEl(v);
    Object.defineProperty(video, "duration", { get: () => 500, configurable: true });
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    const slider = v.container.querySelector('[role="slider"]');
    expect(slider?.getAttribute("aria-valuemax")).toBe("500000");
  });

  it("marks the item played and flushes when the element ends", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await simulateWatchedTo(video, 599);
    await act(async () => {
      video.dispatchEvent(new Event("ended"));
    });
    expect(apiPut.mock.calls.at(-1)?.[1]).toMatchObject({ body: { state: "played", positionMs: 599_000 } });
  });

  it("flushes the latest position on an in-app unmount (Back), which fires no pagehide", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await simulateWatchedTo(video, 73);
    expect(reportProgressOnUnload).not.toHaveBeenCalled();

    v.unmount();
    view = null;
    expect(reportProgressOnUnload).toHaveBeenCalledTimes(1);
    expect(reportProgressOnUnload.mock.calls[0]?.[0]).toEqual({
      serverUrl: SERVER_URL,
      itemId: ITEM_ID,
      sessionId: SESSION_ID,
    });
    expect(reportProgressOnUnload.mock.calls[0]?.[1]).toMatchObject({ positionMs: 73_000, state: "in-progress" });
    expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("still flushes on a real page unload", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await simulateWatchedTo(video, 12);
    window.dispatchEvent(new Event("pagehide"));
    expect(reportProgressOnUnload).toHaveBeenCalledTimes(1);
    expect(reportProgressOnUnload.mock.calls[0]?.[1]).toMatchObject({ positionMs: 12_000 });
  });

  it("writes no bogus zero-position row when nothing ever played", async () => {
    const v = (view = await renderReady());
    v.unmount();
    view = null;
    expect(reportProgressOnUnload).not.toHaveBeenCalled();
  });

  it("seeds the audio selection from the file's default stream and applies a pick to the element", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    // Chip names the isDefault stream (index 1), not array position 1.
    expect(v.container.textContent).toContain("EAC3 6CH");

    await act(async () => button(v, "Audio and subtitle tracks").click());
    const options = Array.from(v.container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      b.textContent?.includes("ch"),
    );
    expect(options).toHaveLength(2);
    expect(options.every((b) => !b.disabled)).toBe(true);

    await act(async () => options[1]?.click());
    expect(mediaState(video).audioTracks.map((t) => t.enabled)).toEqual([false, true]);
    expect(v.container.textContent).toContain("AAC 2CH");
  });

  // ── Token refresh (task #6, 2026-08-08/10 HLS-stall recon) ──────────────
  // The direct-play/native-HLS attach effect (VideoPlayer.tsx) used to
  // compare `currentSrc === activeSrcUrl` verbatim, which trips on every
  // token rotation `useSessionFileUrl`/`useHlsManifestUrl` hand back and
  // forced a full `video.src` reset + `load()` + reseek even though the
  // underlying stream never changed. These four tests exercise the fix:
  // token-only refreshes while playing are a no-op, a genuinely different
  // URL still reattaches, a paused boundary takes the free opportunity to
  // refresh silently, and a fatal `error` mid-playback recovers using the
  // freshest known token.
  it("a token-only refresh (?token= rotates, same underlying resource) never interrupts playback with a reload", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    // The initial attach's own one-shot `loadedmetadata` listener autoplays
    // (no resume prompt in this fixture) — dispatch it now, the way a real
    // browser would shortly after `load()`, so it fires and self-removes.
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.paused).toBe(false);

    const srcBeforeRefresh = video.src;
    const loadSpy = vi.spyOn(video, "load");

    mockAccessToken = "rotated-access-token";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(video.src).toBe(srcBeforeRefresh); // unchanged — still the ORIGINAL token, never reloaded
    expect(video.paused).toBe(false); // playback was never interrupted
  });

  it("a genuinely different URL (e.g. a version/fallback switch to a new session id) still forces a reattach", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    await act(async () => button(v, "Play").click());
    video.currentTime = 55;
    const srcBefore = video.src;
    const loadSpy = vi.spyOn(video, "load");

    createPlaybackSession.mockResolvedValueOnce({ ok: true, session: { ...directPlaySession(), id: SECOND_SESSION_ID } });
    await act(async () => {
      v.rerender(
        <ToastProvider>
          <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} mediaFileId={ALT_FILE_ID} />
        </ToastProvider>,
      );
    });

    expect(loadSpy).toHaveBeenCalled();
    expect(video.src).not.toBe(srcBefore);
    expect(video.src).toContain(SECOND_SESSION_ID);
  });

  it("silently swaps in a rotated token while PAUSED — a free refresh at a natural boundary, no play() triggered", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    // Retire the initial attach's own one-shot `loadedmetadata` listener
    // first (it autoplays — no resume prompt in this fixture — same as a
    // real browser shortly after `load()`), then the user explicitly
    // pauses and walks away: THAT'S the paused natural boundary under test,
    // not "never played at all".
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.paused).toBe(false);
    await act(async () => button(v, "Pause").click());
    expect(video.paused).toBe(true);

    video.currentTime = 77;
    const srcBefore = video.src;
    const loadSpy = vi.spyOn(video, "load");

    mockAccessToken = "paused-refresh-token";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(video.src).not.toBe(srcBefore);
    expect(video.src).toContain("paused-refresh-token");

    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.currentTime).toBe(77); // position restored
    expect(video.paused).toBe(true); // was paused before the refresh -> stays paused, no auto-play
  });

  it("recovers from a fatal media error mid-play on the native-HLS branch by re-attaching with the freshest token, restoring position and resuming playback", async () => {
    // Claim native HLS support so `attachStrategy` resolves to 'native-hls'
    // (hls-attach.ts's truth table: usesHls && !mseAvailable && canPlayNativeHls
    // — jsdom has no MediaSource, so mseAvailable is already false) rather
    // than the 'hlsjs' fallback, exercising `useHlsManifestUrl` specifically
    // (not just direct-play's `useSessionFileUrl`) — both feed the SAME
    // attach effect under test, but this confirms the fix covers both.
    Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", { configurable: true, value: () => "maybe" });
    createPlaybackSession.mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
    vi.useFakeTimers();

    const v = (view = await renderReady());
    const video = videoEl(v);
    // Retire the initial attach's own one-shot `loadedmetadata` listener
    // first (it autoplays — no resume prompt in this fixture), the same as
    // a real browser would shortly after `load()`, so the LATER
    // `loadedmetadata` dispatch below (simulating the error-recovery
    // reattach's own onLoaded) has exactly one listener to fire, not two.
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.paused).toBe(false);
    video.currentTime = 123;

    // The AuthStore rotates the access token in the background (P2.1's
    // 15-minute access-token TTL) — the attach effect notices (it re-runs
    // and re-registers its `error` listener with the fresh URL closure) but
    // does not reload while playback is smooth.
    mockAccessToken = "post-rotation-token";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(video.src).not.toContain("post-rotation-token"); // still the OLD token — no eager reload

    const loadSpy = vi.spyOn(video, "load");
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(video.src).toContain("post-rotation-token"); // recovered using the FRESH token
    expect(video.src).toContain(SESSION_ID);

    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata")); // the browser signals the reattached media is ready
    });
    expect(video.currentTime).toBe(123); // position restored
    expect(video.paused).toBe(false); // was playing before the error -> resumes
  });

  // ── Recovery redesign (2026-08-10 opus review findings 1-3) ─────────────
  // The four tests above cover the token-freshness comparison itself; these
  // cover the recovery-budget/stall-detection machinery layered on top of
  // it: a separate cooldown ref so an ordinary attach never eats the
  // recovery budget, a DEFERRED (never dropped) cooldown, a hard 3-attempt
  // bound before falling through to the same fatal-unavailable screen a
  // refused createPlaybackSession already renders, a skip of that budget
  // entirely for two genuinely unrecoverable MediaError codes, a stall
  // (not just fatal-`error`) trigger for Safari's actual 401 presentation,
  // and no more stacked stale-closure `loadedmetadata` listeners.
  it("an initial attach that fails fast still retries immediately — the old bug stamped the cooldown on every attach, including this one, and silently never retried", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    // No `loadedmetadata` was ever dispatched — the very first attach
    // (fired synchronously by the effect on mount) is what's failing here.
    const loadSpy = vi.spyOn(video, "load");
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).toHaveBeenCalledTimes(1); // retried right away, no setTimeout needed
  });

  it("bounds recovery attempts at 3 (deferring inside the cooldown rather than dropping), then falls through to the fatal unavailable path", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");

    await act(async () => {
      video.dispatchEvent(new Event("error")); // attempt 1 — immediate, no prior recovery stamp
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      video.dispatchEvent(new Event("error")); // still inside the 4s cooldown from attempt 1
    });
    expect(loadSpy).toHaveBeenCalledTimes(1); // deferred, not dropped and not immediate
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(loadSpy).toHaveBeenCalledTimes(2); // attempt 2 — the deferred retry actually ran

    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(loadSpy).toHaveBeenCalledTimes(3); // attempt 3 — budget now exhausted

    await act(async () => {
      video.dispatchEvent(new Event("error")); // a 4th failure in this stretch
    });
    expect(loadSpy).toHaveBeenCalledTimes(3); // NOT retried again — a persistently-failing URL doesn't retry forever
    // d3-a5: exhaustion is a RUNTIME failure — the screen wears the FAILED
    // framing now ("stopped playing"), no longer the planner-refusal one
    // ("can't play on this device right now").
    expect(v.container.textContent).toContain("stopped playing");
    expect(v.container.textContent).toContain("Playback failed in this browser");
  });

  it("a MEDIA_ERR_DECODE error is unrecoverable — no reattach at all, straight to the fatal unavailable path", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3 /* MEDIA_ERR_DECODE */, message: "" }) });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).not.toHaveBeenCalled();
    // SPF-7 Phase B: goFatal renders the SPECIFIC client code — the
    // MediaError code and message reach the screen, not the old generic
    // "Playback failed in this browser" fallback — and no retry suffix
    // (this branch bypasses bounded recovery entirely).
    expect(v.container.textContent).toContain("Your browser couldn't decode this stream");
    expect(v.container.textContent).toContain("client-media-decode-error");
    expect(v.container.textContent).toContain("MediaError 3:");
    expect(v.container.textContent).not.toContain("after");
  });

  it("a MEDIA_ERR_SRC_NOT_SUPPORTED error is unrecoverable too — same fatal path, no reattach attempted", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */, message: "" }) });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(v.container.textContent).toContain("Your browser refused this stream format");
    expect(v.container.textContent).toContain("client-media-src-not-supported");
    expect(v.container.textContent).toContain("MediaError 4:");
  });

  it("SPF-7 Phase B: UnavailableScreen's 'Try again' re-creates the session and ends the old one", async () => {
    createPlaybackSession
      .mockReset()
      .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
      .mockResolvedValueOnce({ ok: true, session: { ...directPlaySession(), id: SECOND_SESSION_ID } });
    const v = (view = await renderReady());
    const video = videoEl(v);
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3 /* MEDIA_ERR_DECODE */, message: "" }) });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(v.container.textContent).toContain("Your browser couldn't decode this stream");

    const retryButton = Array.from(v.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Try again");
    if (!retryButton) throw new Error('no "Try again" button rendered');
    await act(async () => retryButton.click());

    // A fresh create, and the OLD (failed) session released — the SAME
    // lease/unmount-cleanup lever selectSubtitle's re-create already
    // exercises (browser-player-F5, AUD-A4v4-003), not a new teardown path.
    expect(createPlaybackSession).toHaveBeenCalledTimes(2);
    expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    // The unavailable screen is gone — the new session is live.
    expect(v.container.textContent).not.toContain("Your browser couldn't decode this stream");
  });

  it("the element's own 'playing' event resets the recovery budget — a stretch that reaches real playback again earns a fresh 3 attempts", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");

    // Use up the entire 3-attempt budget.
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(loadSpy).toHaveBeenCalledTimes(3);

    // Recovery actually worked this time.
    await act(async () => {
      video.dispatchEvent(new Event("playing"));
    });

    // A budget left at 0 (no reset) would send the NEXT failure straight to
    // the fatal path with no further reattach — confirm it retries instead.
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(loadSpy).toHaveBeenCalledTimes(4);
    expect(v.container.textContent).not.toContain("Playback failed in this browser");
  });

  it("repeated attaches before any load ever succeeds don't stack pending loadedmetadata listeners — the eventual successful load restores exactly once", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    // Intercept `currentTime` ASSIGNMENTS specifically (not the stub's own
    // internal resets inside `load()`, which mutate the shared state object
    // directly, bypassing this setter) — `onLoaded`'s restore is the ONLY
    // code that assigns `video.currentTime` in this scenario, so its call
    // count is an exact proxy for "how many onLoaded listeners fired".
    const state = mediaState(video);
    let setCount = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => state.currentTime,
      set: (value: number) => {
        setCount++;
        state.currentTime = value;
      },
    });

    // Two consecutive recovery-triggered attaches (clearing the cooldown
    // between them so each one genuinely fires, on top of the very first
    // mount-time attach's own still-pending listener), neither of which
    // ever gets a chance to fire ITS OWN loadedmetadata (a real
    // repeatedly-failing source). The old code stacked one listener per
    // attempt and never removed a pending one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000); // clear the mount attach's own cooldown stamp
    });
    await act(async () => {
      video.dispatchEvent(new Event("error")); // attach #2
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000); // clear attach #2's cooldown stamp
    });
    await act(async () => {
      video.dispatchEvent(new Event("error")); // attach #3
    });

    // The load finally succeeds.
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(setCount).toBe(1); // only #3's listener fired — #1 and #2's were removed, not stacked
  });

  // ── Stall watchdog (2026-08-10 opus review finding 2) ───────────────────
  // Safari's native-HLS 401 typically presents as a STALL — the element
  // just stops advancing, firing `waiting`/`stalled` with no fatal `error`
  // event at all — not as something the `error` listener above would ever
  // see.
  it("a stall (waiting) that persists 10s with a rotated token triggers exactly one bounded recovery attach, restoring position", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata")); // initial attach completes, autoplays
    });
    expect(video.paused).toBe(false);
    video.currentTime = 200;

    // The AuthStore rotates the token in the background — the attach
    // effect notices (re-runs, re-registers every listener with the fresh
    // URL closure) but does not reload while nothing looks wrong yet.
    mockAccessToken = "stall-recovery-token";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(video.src).not.toContain("stall-recovery-token"); // still the OLD token — no eager reload

    const loadSpy = vi.spyOn(video, "load");
    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
    expect(loadSpy).not.toHaveBeenCalled(); // the watchdog just started, hasn't fired yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // STALL_WATCHDOG_MS with currentTime never advancing
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(video.src).toContain("stall-recovery-token"); // recovered using the FRESH token
    expect(video.src).toContain(SESSION_ID);

    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.currentTime).toBe(200); // position restored
    expect(video.paused).toBe(false); // was playing before the stall -> resumes
  });

  it("a stall with the SAME token attached (an ordinary rebuffer, no rotation) never triggers a recovery attach", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.paused).toBe(false);
    video.currentTime = 300;

    const loadSpy = vi.spyOn(video, "load");
    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(loadSpy).not.toHaveBeenCalled(); // the URL never differed by token — a genuine rebuffer, not a stale-token stall
  });

  it("the stall watchdog clears when the element resumes advancing (a real timeupdate-with-progress) before the 10s window elapses", async () => {
    vi.useFakeTimers();
    const v = (view = await renderReady());
    const video = videoEl(v);
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    video.currentTime = 400;

    mockAccessToken = "unused-recovery-token";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // primes a fresher URL the watchdog COULD have used
    });

    const loadSpy = vi.spyOn(video, "load");
    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000); // halfway through the 10s window
    });

    // Playback actually resumes on its own — position genuinely advances.
    await act(async () => {
      video.currentTime = 405;
      video.dispatchEvent(new Event("timeupdate"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // well past the ORIGINAL window, had it not been cleared
    });
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("offers a resume prompt without auto-seeking when a worth-resuming position exists", async () => {
    findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
    const v = (view = await renderReady());
    expect(v.container.textContent).toContain("You stopped at 2:00");
    expect(videoEl(v).currentTime).toBe(0);
  });

  // S7 chapters (STATE.md deep-link start offset): a `startMs` prop — the
  // /watch/{itemId}?t=<seconds> route param, threaded through by
  // app/watch/[itemId]/page.tsx — must win over the resume prompt outright,
  // never merge with it: the saved-progress lookup is skipped entirely
  // (never even fetched), so there is no "compare the two positions"
  // decision to get wrong, and no resume prompt can ever render for this
  // session regardless of what a saved position would have said.
  it("startMs (deep-link chapter offset) wins over the resume prompt: no saved-progress lookup, no prompt rendered", async () => {
    findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
    const v = (view = await renderReady(vi.fn(), undefined, 90_000));
    expect(findProgressForItem).not.toHaveBeenCalled();
    expect(v.container.textContent).not.toContain("You stopped at");
  });

  // browser-player-F7: the window-level shortcut handler was gated only on
  // phase === 'ready', so with the resume prompt open (focus held on the
  // modal's Close button) a Space bubbled up to the window listener and
  // togglePlay() started playback BEHIND the still-open dialog — whose
  // "Resume from X" offer then re-seeks over already-advanced playback.
  // Arrows leaked the same way (seek + an immediate progress flush). The
  // keydown handler must be inert while a resume choice is pending; the
  // modal keeps focus and owns the keyboard until a choice is made.
  describe("resume-prompt keyboard gate (browser-player-F7)", () => {
    /** The prompt's own controls are plain-text Buttons (no aria-label) —
     *  find one inside the open dialog by its visible label. */
    function dialogButton(v: TestRender, label: string): HTMLButtonElement {
      const dialog = v.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error("no open dialog");
      const el = [...dialog.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!el) throw new Error(`no dialog button labelled "${label}"`);
      return el;
    }

    /** Real-world shape: the modal holds focus, so the key lands on one of
     *  its buttons and BUBBLES to VideoPlayer's window-level listener. */
    async function pressKeyOnDialog(v: TestRender, key: string): Promise<void> {
      const target = dialogButton(v, "Close");
      target.focus();
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }

    async function renderWithPromptOpen(): Promise<TestRender> {
      findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
      const v = await renderReady();
      expect(v.container.querySelector('[role="dialog"]')).toBeTruthy();
      return v;
    }

    it("Space while the resume prompt is open never reaches the player — nothing plays behind the modal", async () => {
      const v = (view = await renderWithPromptOpen());
      const video = videoEl(v);
      expect(video.paused).toBe(true);

      await pressKeyOnDialog(v, " ");

      expect(video.paused, "Space leaked through the open resume prompt and started playback behind the modal").toBe(true);
      expect(v.container.querySelector('[role="dialog"]'), "the prompt must stay open until a choice is made").toBeTruthy();
    });

    it("arrow keys while the resume prompt is open never seek or flush progress", async () => {
      const v = (view = await renderWithPromptOpen());
      const video = videoEl(v);

      await pressKeyOnDialog(v, "ArrowRight");

      expect(video.currentTime, "ArrowRight leaked through the open resume prompt and seeked the element").toBe(0);
      expect(apiPut, "the leaked seek even flushed a progress write while the prompt was still open").not.toHaveBeenCalled();
    });

    it("after a choice is made the same keys work again — the gate is the pending choice, not the player", async () => {
      const v = (view = await renderWithPromptOpen());
      const video = videoEl(v);

      await act(async () => dialogButton(v, "Start over").click());
      expect(v.container.querySelector('[role="dialog"]')).toBeNull();
      expect(video.paused).toBe(false);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      });
      expect(video.paused, "Space must reach the player again once the resume choice is resolved").toBe(true);
    });
  });

  // AUD-A4v4-003 regression guards: a createPlaybackSession call that
  // resolves AFTER its effect invocation was cancelled (unmount, or an
  // itemId/mediaFileId/startMs change re-running the effect) creates a real
  // server row that never reaches `session` state — so the sibling
  // unmount-cleanup effect can never end it. With the shipped default
  // maxSimultaneousTranscodes = 1, one such orphan blocks ALL playback
  // until the 15-minute idle sweeper. The cancelled invocation itself must
  // end the session it created.
  it("ends the session created by a create that resolved after unmount — nothing else can ever reach it", async () => {
    let resolveCreate: (r: unknown) => void = () => undefined;
    createPlaybackSession.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreate = res;
        }),
    );
    const v = (view = await renderReady());
    v.unmount();
    view = null;
    expect(endPlaybackSession).not.toHaveBeenCalled();
    await act(async () => {
      resolveCreate({ ok: true, session: directPlaySession() });
    });
    expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("ends the first session when a mediaFileId change supersedes an in-flight create, and keeps only the new one", async () => {
    const onBack = vi.fn();
    let resolveFirst: (r: unknown) => void = () => undefined;
    createPlaybackSession
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValueOnce({ ok: true, session: { ...directPlaySession(), id: SECOND_SESSION_ID } });
    const v = (view = await renderReady(onBack));

    // The user re-targets the player (picks a VERSION) while the first
    // POST is still in flight.
    await act(async () => {
      v.rerender(
        <ToastProvider>
          <VideoPlayer itemId={ITEM_ID} onBack={onBack} mediaFileId={ALT_FILE_ID} />
        </ToastProvider>,
      );
    });
    expect(createPlaybackSession).toHaveBeenCalledTimes(2);

    // The superseded create resolves late: its session must be ended…
    await act(async () => {
      resolveFirst({ ok: true, session: directPlaySession() });
    });
    expect(endPlaybackSession).toHaveBeenCalledTimes(1);
    expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);

    // …while the superseding session stays live until the real unmount.
    v.unmount();
    view = null;
    expect(endPlaybackSession).toHaveBeenCalledWith(SECOND_SESSION_ID);
  });

  // gap-F1: React dev StrictMode double-invokes the session-create effect
  // (setup #1 → cleanup #1 → setup #2, all before either POST can settle).
  // Pre-fix, that raced TWO concurrent POST /playback/sessions per mount:
  // with maxSimultaneousTranscodes=1 the twins fought over the household's
  // only slot (one 201, one 429 — the surviving invocation rendered "at
  // capacity" while the cancelled twin DELETEd the winning 201 session),
  // and with slots>=2 the extra 201 leaked whenever churn re-ordered the
  // settle. The twins must SHARE one create (a lease on the same in-flight
  // POST) and the cancelled twin's cleanup must never end the session the
  // survivor keeps.
  describe("dev StrictMode twin session create (gap-F1)", () => {
    // React 19's `act` warns ("environment is not configured to support
    // act") on the StrictMode double-invoke flush unless this global is
    // set. Scoped to this describe (set before, deleted after) so the
    // rest of the file keeps its exact pre-existing warning behavior —
    // both tests below unmount INSIDE the test body while the flag is
    // still up, so the outer afterEach's unmount has nothing to flush.
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    function renderStrict(): TestRender {
      return renderIntoBody(
        <StrictMode>
          <ToastProvider>
            <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} />
          </ToastProvider>
        </StrictMode>,
      );
    }

    it("fires exactly ONE POST per StrictMode mount and the twin's cleanup never deletes the survivor's session", async () => {
      let resolveCreate: (r: unknown) => void = () => undefined;
      createPlaybackSession.mockImplementation(
        () =>
          new Promise((res) => {
            resolveCreate = res;
          }),
      );
      await act(async () => {
        view = renderStrict();
      });
      // Both effect invocations are live-then-cancelled before the POST
      // settles — they must have JOINED one create, not raced two.
      expect(createPlaybackSession).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveCreate({ ok: true, session: directPlaySession() });
      });
      // The surviving invocation adopted the 201; the cancelled twin's
      // cleanup must not have ended it out from under the player.
      expect(endPlaybackSession).not.toHaveBeenCalled();
      expect(view?.container.querySelector("video")).not.toBeNull();
      // Unmount while IS_REACT_ACT_ENVIRONMENT is still scoped up; the
      // real unmount ends the adopted session exactly once.
      view?.unmount();
      view = null;
      expect(endPlaybackSession).toHaveBeenCalledTimes(1);
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it("still ends the session exactly once when the whole player unmounts before the create settles", async () => {
      let resolveCreate: (r: unknown) => void = () => undefined;
      createPlaybackSession.mockImplementation(
        () =>
          new Promise((res) => {
            resolveCreate = res;
          }),
      );
      await act(async () => {
        view = renderStrict();
      });
      view?.unmount();
      view = null;
      expect(endPlaybackSession).not.toHaveBeenCalled();
      await act(async () => {
        resolveCreate({ ok: true, session: directPlaySession() });
      });
      // AUD-A4v4-003 still holds under StrictMode: the orphaned create's
      // session is ended — once, not once per twin.
      expect(endPlaybackSession).toHaveBeenCalledTimes(1);
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  // N3's player review checkpoint (STATE.md NG9): NoticeOverlayStrip must
  // be a DESCENDANT of the real stage element (the `ref={stageRef}` div —
  // the fullscreen target, the only DOM position proven to survive the
  // real Fullscreen API), not a sibling or a separately-portaled node.
  // `[data-idle]` is the stage's own always-present attribute, a stable
  // locator that needs no CSS-module class-name matching.
  it("mounts NoticeOverlayStrip as a descendant of the stage element when a notice is active", async () => {
    noticeMockValue = {
      notice: { id: "w1", message: "Heads up", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 60_000, createdAtMs: 0 },
      severity: "warning",
      serverOffsetMs: 0,
      dismissed: false,
      dismiss: vi.fn(),
      bannerVisible: true,
    };
    const v = (view = await renderReady());
    const stage = v.container.querySelector("[data-idle]");
    expect(stage).toBeTruthy();
    const strip = v.container.querySelector('[data-severity="warning"]');
    expect(strip).toBeTruthy();
    expect(stage!.contains(strip)).toBe(true);
  });

  // AUD-W6-001 (server repro confirmed clean: a real catalog_items row with
  // zero media_files gets a genuine RFC 9457 404 from POST /playback/sessions
  // in under 2 seconds — the server does not hang). createPlaybackSession
  // (lib/playback-session.ts) only intercepts a genuine 409/422/429 refusal
  // and re-throws anything else, including a 404 — before this fix, that
  // re-throw reached the session-create effect's `void run()` with no
  // attached catch: an unhandled promise rejection that left `phase` stuck
  // at "loading" forever (the observed /watch/<item> hang is client-side,
  // not a server hang). This is the RED-FIRST pin: today's behavior is the
  // spinner never resolving — no UnavailableScreen, no thrown/visible error
  // either (only an unhandled-rejection console warning jsdom doesn't
  // surface as a test failure by itself, which is exactly how this bug hid).
  it("a 404 from createPlaybackSession (no access / nothing playable) surfaces the item-unavailable copy under the Unavailable framing — never a planner-refusal page or client blame", async () => {
    createPlaybackSession.mockReset().mockRejectedValueOnce(
      new LoombreApiError(404, { type: "about:blank", title: "Not Found", status: 404, detail: "No playable media file for this item." }),
    );
    let v: TestRender | null = null;
    await act(async () => {
      v = renderIntoBody(
        <ToastProvider>
          <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} />
        </ToastProvider>,
      );
    });
    view = v;
    // d3-a5 (verify/browser-player-F4 P3): a 404 here is an access/not-found
    // condition — the viewer can't reach the item's library, or the item has
    // nothing playable. Rendering it as a client playback error ("Playback
    // failed in this browser") or a planner refusal ("Session refused ·
    // planner reasons, verbatim") is a lie both ways: no plan was ever made
    // and the browser never touched a stream. Lane C's client-synthesized
    // `item-unavailable` reason (lib/playback-reasons.ts) says the honest
    // thing, under AQ's `unavailable` framing, with the REAL status code.
    const text = v!.container.textContent ?? "";
    expect(text).toContain("This link didn't lead to anything playable");
    expect(text).toContain("HTTP 404");
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("Playback failed in this browser");
    expect(text).not.toContain("Session refused");
    expect(v!.container.querySelector("video")).toBeNull();
  });

  // d4-a2.117 (a5/d3-a5): a session-create failure that is NEITHER a plan
  // refusal (409/422/429 -> result.ok false) NOR a 404 (item-unavailable)
  // used to render the CLIENT-blame copy ("Your browser reported it can't
  // play this stream") under the REFUSED framing ("Session refused ·
  // Planner reasons, verbatim") — misframed both ways: no plan was ever
  // answered and the browser never touched a stream (live-reproduced
  // 2026-08-25 with a blocked POST /playback/sessions). It now carries its
  // own synthesized reason (lib/playback-recovery.ts's
  // playback-session-create-failed) under the UNAVAILABLE framing, with
  // the real HTTP status when one exists.
  describe("session-create 5xx/network failure framing (d4-a2.117)", () => {
    async function renderWithCreateRejection(err: unknown): Promise<TestRender> {
      createPlaybackSession.mockReset().mockRejectedValueOnce(err);
      let v: TestRender | null = null;
      await act(async () => {
        v = renderIntoBody(
          <ToastProvider>
            <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} />
          </ToastProvider>,
        );
      });
      if (!v) throw new Error("render produced nothing");
      return v;
    }

    it("a network-layer rejection surfaces the create-failed copy under the Unavailable framing — never client blame, never 'Session refused', never a silent hang", async () => {
      view = await renderWithCreateRejection(new TypeError("Failed to fetch"));
      const text = view.container.textContent ?? "";
      expect(text).toContain("Couldn’t start a playback session");
      expect(text).toContain("playback-session-create-failed");
      expect(text).toContain("Unavailable");
      expect(text, "the create failure was blamed on the browser — no stream was ever touched").not.toContain(
        "Playback failed in this browser",
      );
      expect(text, "the create failure wore the refusal framing — the planner never answered").not.toContain(
        "Session refused",
      );
      // No status exists for a network failure — the pill must not
      // fabricate one.
      expect(text).not.toContain("HTTP");
    });

    it("an HTTP 5xx problem rejection renders the same honest copy WITH the real status", async () => {
      view = await renderWithCreateRejection(
        new LoombreApiError(503, { type: "about:blank", title: "Service Unavailable", status: 503 }),
      );
      const text = view.container.textContent ?? "";
      expect(text).toContain("Couldn’t start a playback session");
      expect(text).toContain("HTTP 503");
      expect(text).not.toContain("Playback failed in this browser");
      expect(text).not.toContain("Session refused");
    });
  });

  // ── gap-F4: V8 hard seeks must never be silently swallowed ─────────────
  // Live QA (2026-08-20/21) caught two swallow shapes on the hls.js path:
  // (1) a post-ENDLIST out-of-window seek POSTs but the client never
  // re-reads the un-ended playlist (hls.js refuses to reload a VOD level —
  // BasePlaylistController.shouldLoadPlaylist requires `!details ||
  // details.live`), so the landing watch can never fire and the seek dies
  // into the 20 s timeout; (2) a re-seek before landing re-arms on 202
  // RESPONSE order, not seek order, so out-of-order responses pin the
  // scrubber at the OLDER dead target. These tests drive the real seek()/
  // hardSeek() wiring against the mocked hls.js instance above.
  describe("V8 hard seek (gap-F4)", () => {
    /** One listed fragment far from source 0, so a small seek target is
     *  outside the listed window -> classified HARD (POST /seek). PDT is
     *  the V8 source clock (source ms == programDateTime ms). */
    function farListedFragment(): unknown {
      return { programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000000.m4s" };
    }

    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      // The hlsjs attach effect is async (token await + dynamic import) —
      // one more macro/microtask flush lets it construct the mock instance.
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    it("a post-ENDLIST out-of-window seek POSTs /seek AND re-opens the ENDLIST-frozen level so the reload lever works", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      const details = { live: false, fragments: [farListedFragment()] };
      hls.levels = [{ details }];
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

      await act(async () => button(v, "Forward 10 seconds").click());

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(apiPost).toHaveBeenCalledWith(
        "/playback/sessions/{id}/seek",
        expect.objectContaining({ body: { targetMs: 10_000 } }),
      );
      // §9.1.5 rule 5 / A1: entering relocating on an ENDLIST-seen session
      // MUST make the playlist reload lever functional again. startLoad()
      // alone is inert — hls.js's shouldLoadPlaylist refuses VOD levels —
      // so the level must be re-opened (details.live -> true) first.
      expect(
        details.live,
        "the ENDLIST-frozen level was never re-opened — startLoad()/the nudge reload nothing and the landing watch can never fire",
      ).toBe(true);
      expect(hls.calls).toContain("startLoad(undefined)");
    });

    it("a second hard seek before landing POSTs again and wins even when the 202s arrive out of order (newest-wins re-arm)", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      hls.levels = [{ details: { live: true, fragments: [farListedFragment()] } }];
      // SPF-5: a hard seek issued within HARD_SEEK_COALESCE_MS of the
      // previous DISPATCH is deferred and coalesced — this test is about
      // TWO INDEPENDENT dispatches racing, so the clicks must be spaced
      // past the coalescing window (fake timers make that deterministic).
      vi.useFakeTimers();

      let resolveFirst: ((r: { targetMs: number }) => void) | null = null;
      let resolveSecond: ((r: { targetMs: number }) => void) | null = null;
      apiPost
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

      await act(async () => button(v, "Forward 10 seconds").click());
      await act(async () => {
        vi.advanceTimersByTime(HARD_SEEK_COALESCE_MS);
      });
      await act(async () => button(v, "Forward 10 seconds").click());
      // The owner-pinned contract: a re-seek while relocating issues its
      // OWN POST — the first swallow shape was "one POST, not two".
      expect(apiPost).toHaveBeenCalledTimes(2);

      // Out-of-order arrival: the SECOND seek's 202 lands first.
      await act(async () => { resolveSecond?.({ targetMs: 222_222 }); });
      await act(async () => { resolveFirst?.({ targetMs: 111_111 }); });

      const slider = v.container.querySelector('[role="slider"]');
      if (!slider) throw new Error("no scrubber rendered");
      expect(
        slider.getAttribute("aria-valuenow"),
        "the stale FIRST 202 re-armed the landing watch — the newest hard seek must supersede regardless of response order",
      ).toBe("222222");
    });

    // ── SPF-5: hard-seek coalescing ────────────────────────────────────────
    // Each hard-seek POST is a real worker restart (docs/PLAYBACK.md
    // §9.1.9) — a rapid mash of the seek control used to spawn one restart
    // per click, most thrown away before their first segment ever encoded.
    // lib/seek-coalesce.ts's decideHardSeekDispatch is the pure policy; these
    // two tests pin its observable effect through hardSeek/dispatchHardSeek.
    describe("hard-seek coalescing (SPF-5)", () => {
      it("a single, isolated hard seek dispatches immediately — no coalescing timer needed", async () => {
        const { v } = await renderHlsReady();
        view = v;
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());

        expect(
          apiPost,
          "the leading edge dispatches synchronously — an isolated hard seek pays no coalescing delay, exactly as before SPF-5",
        ).toHaveBeenCalledTimes(1);
        expect(apiPost).toHaveBeenCalledWith(
          "/playback/sessions/{id}/seek",
          expect.objectContaining({ body: expect.objectContaining({ targetMs: 10_000 }) }),
        );
      });

      it("two hard seeks 50 ms apart coalesce into exactly ONE POST carrying the newest (second) target", async () => {
        const { v } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();

        // Prime the coalescing baseline with an ordinary, isolated hard
        // seek — the leading edge, dispatched immediately (unaffected by
        // SPF-5) — so the pair below both land inside ITS coalescing
        // window instead of one of them being its own leading edge.
        apiPost.mockResolvedValueOnce({ targetMs: 5_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(apiPost).toHaveBeenCalledTimes(1);
        apiPost.mockClear();

        // The pair: 0 ms and 50 ms after the priming dispatch. Both fall
        // inside HARD_SEEK_COALESCE_MS (150) of it, so both defer onto the
        // SAME trailing timer — the second call just replaces the pending
        // target (newest wins), it does not start a second timer.
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(apiPost, "the first of the pair is still inside the coalescing window — it must defer, not dispatch").not.toHaveBeenCalled();

        await act(async () => {
          vi.advanceTimersByTime(50);
        });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(
          apiPost,
          "the second of the pair must coalesce onto the SAME pending dispatch, not fire its own POST",
        ).not.toHaveBeenCalled();

        // The trailing timer fires once the full window has elapsed since
        // the PRIMING dispatch (100 ms remaining after the 50 ms above).
        apiPost.mockResolvedValueOnce({ targetMs: 25_000 });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(apiPost).toHaveBeenCalledTimes(1);
        expect(
          apiPost,
          "the coalesced dispatch must carry the NEWEST (second) target, not the first of the pair",
        ).toHaveBeenCalledWith(
          "/playback/sessions/{id}/seek",
          expect.objectContaining({ body: expect.objectContaining({ targetMs: 25_000 }) }),
        );
      });
    });

    // ── SPF-10: the seek must read as a jump — freeze at the 202, land,
    // resume — never the PRE-seek run playing on (audible) under the
    // relocating spinner while hls.js keeps fetching its doomed next
    // fragments (the stale-run 503 storms). The element is paused the
    // moment the POST is issued (leading edge and coalesced trailing
    // dispatch alike) and, if play intent was captured, resumed once the
    // landing actually lands (never on the 20 s timeout — the toast stands,
    // the viewer presses play).
    describe("hard-seek pause/resume (SPF-10)", () => {
      /** Lands the currently-armed hard seek (target 10 000) by listing the
       *  seek-spawned run's fragment, exactly like `armAndLand` above but
       *  local to this describe (no shared timer/toast assertions). */
      function land(hls: MockHlsInstance, details: { fragments: unknown[] }): void {
        details.fragments = [
          farListedFragment(),
          { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" },
        ];
        hls.emit("hlsLevelUpdated");
      }

      it("a hard seek issued while PLAYING pauses the element at dispatch and resumes it once the landing lands", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        const details = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        const video = videoEl(v);
        mediaState(video).paused = false;
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());
        expect(
          mediaState(video).paused,
          "the PRE-seek run kept playing under the relocating spinner instead of freezing at the 202 — audible stutter, and hls.js keeps fetching the doomed run's next fragments",
        ).toBe(true);

        await act(async () => land(hls, details));
        expect(video.currentTime, "the landing never seeked the element to the run's start").toBe(6);
        expect(mediaState(video).paused, "the captured play intent never resumed the landed seek").toBe(false);
      });

      it("a hard seek issued while PAUSED never calls play() — stays paused throughout the lifecycle", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        const details = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        const video = videoEl(v);
        mediaState(video).paused = true; // precondition: the default state
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());
        expect(mediaState(video).paused).toBe(true);

        await act(async () => land(hls, details));
        expect(video.currentTime).toBe(6);
        expect(
          mediaState(video).paused,
          "a hard seek issued while paused must stay paused — the viewer never chose to play",
        ).toBe(true);
      });

      it("the TIMEOUT path leaves the element paused — the toast stands, the viewer presses play", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        hls.levels = [{ details: { live: true, fragments: [farListedFragment()] } }];
        const video = videoEl(v);
        mediaState(video).paused = false; // was playing — captured intent is TRUE
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());
        expect(mediaState(video).paused).toBe(true);

        // No landing ever arrives — the 20 s lifecycle timer fires.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
        });
        expect(document.body.textContent).toContain("Seek timed out");
        expect(
          mediaState(video).paused,
          "a captured play intent must never resolve into a play() on the timeout path — no landing ever happened",
        ).toBe(true);
      });

      it("a coalesced (superseding) hard seek keeps the ORIGINAL play intent, not whatever the element looks like mid-lifecycle", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const details = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        const video = videoEl(v);
        mediaState(video).paused = false; // playing — the ORIGINAL intent this whole lifecycle must keep

        // Priming dispatch: the leading edge, dispatches immediately and
        // captures the play intent (true) — the element is paused for it,
        // same as the isolated case above.
        apiPost.mockResolvedValueOnce({ targetMs: 5_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(apiPost).toHaveBeenCalledTimes(1);
        expect(mediaState(video).paused).toBe(true);
        apiPost.mockClear();

        // A superseding seek arrives inside the coalescing window: it must
        // defer to the trailing timer, not dispatch (or recapture) on its
        // own — the SAME open lifecycle, so hardSeekPlayIntentRef must
        // still read `true` from the priming dispatch, not `false` from
        // reading an element THIS lifecycle already paused.
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(apiPost, "the superseding seek must coalesce, not dispatch its own POST").not.toHaveBeenCalled();

        apiPost.mockResolvedValueOnce({ targetMs: 25_000 });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_COALESCE_MS);
        });
        expect(apiPost).toHaveBeenCalledTimes(1);
        expect(
          mediaState(video).paused,
          "the coalesced dispatch's own pause() call must stay a no-op, never a re-capture that drops the original intent",
        ).toBe(true);

        // Land the SUPERSEDING (newest) target.
        details.fragments = [
          farListedFragment(),
          { programDateTime: 25_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" },
        ];
        await act(async () => {
          hls.emit("hlsLevelUpdated");
        });
        expect(video.currentTime).toBe(6);
        expect(
          mediaState(video).paused,
          "the superseding dispatch dropped the ORIGINAL (priming) play intent — a coalesced seek must never silently downgrade playing to paused",
        ).toBe(false);
      });

      it("the ABSORBED-202 landing (no new run) resumes too, not only the fragment-match landing", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).paused = false; // playing before the seek
        // The window covers source 100.0-106.0s; the viewer sits at 100.5s.
        const details = {
          live: true,
          fragments: [{ programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" }],
        };
        hls.levels = [{ details }];
        // First refresh consumes the one-shot queued-start router
        // (browser-player-F9), as on a real session.
        await act(async () => {
          hls.emit("hlsLevelUpdated");
        });
        await act(async () => {
          video.currentTime = 0.5;
          video.dispatchEvent(new Event("timeupdate"));
        });
        // Forward 10s -> target 110_500: NOT listed (just ahead of the
        // produced edge) -> HARD. The server absorbs it into run0 (202, no
        // restart) and simply produces on toward it.
        apiPost.mockResolvedValueOnce({ targetMs: 110_500 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(mediaState(video).paused, "the dispatch must pause even an absorbed-shaped seek — it cannot know yet that no restart will happen").toBe(true);

        // Next refresh: run0 itself now lists the target — no run1 ever
        // will. `landAbsorbedTarget` lands via the element directly.
        details.fragments = [
          { programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" },
          { programDateTime: 106_000, start: 6, duration: 6.006, relurl: "run0/s000017.m4s" },
        ];
        await act(async () => {
          hls.emit("hlsLevelUpdated");
        });
        expect(video.currentTime).toBeCloseTo(10.5, 3);
        expect(
          mediaState(video).paused,
          "the absorbed-202 landing never resumed the captured play intent — only the fragment-match landing did",
        ).toBe(false);
      });
    });

    // ── browser-player-F4: the EOF-seek wedge ─────────────────────────────
    // QA 2026-08-20/21 (P1): a hard seek to/at durationMs landed (the
    // seek-spawned run showed up and matched the watch), the LEVEL_UPDATED
    // handler cleared the 20 s timer, and the element then stalled FOREVER
    // at a position no data ever arrived for — indefinite pin, no toast,
    // player unrecoverable. The timeout must bound the FULL seek lifecycle:
    // it runs until the landed position actually becomes displayable
    // (resume evidence), not merely until the playlist lists the run.
    describe("EOF-seek wedge (browser-player-F4): the landing must not consume the lifecycle timeout", () => {
      /** Arms a hard seek (202 target 10 000) and lands it: the seek-spawned
       *  run1 fragment (PDT == clamped target) appears in the listed window
       *  and LEVEL_UPDATED fires, so the landing handler seeks the element
       *  to the run's presentation start (6 s). Fake timers must already be
       *  installed so the 20 s lifecycle timer is controllable. */
      async function armAndLand(v: TestRender, hls: MockHlsInstance): Promise<HTMLVideoElement> {
        const details = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(apiPost).toHaveBeenCalledTimes(1);
        details.fragments = [farListedFragment(), { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" }];
        await act(async () => {
          hls.emit("hlsLevelUpdated");
        });
        const video = videoEl(v);
        expect(video.currentTime, "the landing never seeked the element to the run's start").toBe(6);
        return video;
      }

      it("a landed seek whose position never becomes displayable still toasts at 20s (the EOF wedge is bounded)", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        await armAndLand(v, hls);
        // No data ever arrives at the landed position (readyState stays
        // HAVE_NOTHING, no seeked/canplay/playing/timeupdate) — exactly the
        // live wedge: an at-EOF run produced nothing displayable.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
        });
        expect(
          document.body.textContent,
          "the landing consumed the 20 s timer — nothing bounds the post-landing stall (browser-player-F4)",
        ).toContain(formatSeekTimedOutToast());
      });

      it("a seeked BELOW the landed start (UA clamped the landing on an ended stream) is NOT resume evidence — still toasts", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await armAndLand(v, hls);
        // The element had already consumed endOfStream at a shorter
        // duration: the landing's currentTime assignment gets clamped BELOW
        // the run's start, and the seek "completes" on old data.
        mediaState(video).readyState = 4;
        video.currentTime = 3;
        await act(async () => {
          video.dispatchEvent(new Event("seeked"));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
        });
        expect(
          document.body.textContent,
          "a clamped seek that never reached the landed run counted as resume evidence — the wedge would be silent again",
        ).toContain("Seek timed out");
      });

      it("real resume evidence (seeked at the landed start with displayable data) ends the lifecycle: no toast, display unfrozen", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await armAndLand(v, hls);
        mediaState(video).readyState = 4; // the landed position is displayable now
        await act(async () => {
          video.dispatchEvent(new Event("seeked"));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 5_000);
        });
        expect(document.body.textContent).not.toContain("Seek timed out");
        // Display unfrozen: timeupdate maps through the landed run's PDT.
        await act(async () => {
          video.currentTime = 6.5;
          video.dispatchEvent(new Event("timeupdate"));
        });
        const slider = v.container.querySelector('[role="slider"]');
        expect(slider?.getAttribute("aria-valuenow")).toBe("10500");
      });
    });

    // ── d4-a1.113: relocation must not re-kick the fragment pipeline ──────
    // Live evidence (2026-08-25, Thor video-copy sessions): every nudge
    // tick's stopLoad/startLoad pair aborted and re-requested the fragment
    // under the playhead — the SAME tail segment fetched once per tick at
    // exactly the 1000 ms cadence (the at-EOF ~8x re-fetch loop the d3-a2
    // handoff logged; 200s when the run survives, the verify-A 503 hammer
    // when it doesn't). Against a real hls.js instance the nudge now
    // performs a playlist-only reload (LEVEL_LOADING trigger — d4-a1.112's
    // lever); the stop/start pair remains only as the fallback for
    // reloaders without that surface.
    it("relocation nudge ticks are playlist-only reloads on a real-hls-shaped instance — no per-tick fragment re-kick (d4-a1.113)", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      vi.useFakeTimers();
      hls.levels = [{ details: { live: true, fragments: [farListedFragment()] }, uri: "http://localhost:3001/hls/v0/media.m3u8" }];
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
      await act(async () => button(v, "Forward 10 seconds").click());
      const callsAtArm = hls.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      const nudgeCalls = hls.calls.slice(callsAtArm);
      expect(
        nudgeCalls.filter((c) => c === "trigger(hlsLevelLoading)"),
        // R6: the extra 150 ms tick (relocation-nudge.ts) plus the 1 s and
        // 2 s cadence ticks — the arm-time immediate tick already landed
        // before `callsAtArm` was captured.
        "the nudge stopped re-reading the playlist — discovery latency regresses to hls.js's own cadence",
      ).toHaveLength(3);
      expect(
        nudgeCalls.filter((c) => c === "stopLoad" || c.startsWith("startLoad")),
        "a nudge tick re-kicked the fragment pipeline — the at-EOF same-segment re-fetch loop returns (d4-a1.113)",
      ).toEqual([]);
    });

    // ── d3-a2: post-ENDLIST hard seeks rebuild the MSE pipeline ──────────
    // Once a served playlist has carried ENDLIST, hls.js state the app
    // cannot reach is poisoned for every later hard seek: endOfStream()
    // truncated the MediaSource duration (the landing's currentTime
    // assignment clamps short of the new run and the ENDED stream
    // controller never fetches it — browser-player-F4-residual), and the
    // FragmentTracker keeps the completed run's tail as its endList entity
    // forever (a later seek run that also completes satisfies
    // isEndListAppended via the STALE entity — one segment consumed,
    // 'ended' ~20 s early, verify/browser-player-F4). The one public lever
    // clearing both is a media re-attach (lib/post-endlist-rebuild.ts);
    // these tests pin WHEN VideoPlayer pulls it.
    describe("post-ENDLIST MSE rebuild (d3-a2)", () => {
      /** What real hls.js does when a refresh parses ENDLIST: LEVEL_UPDATED
       *  fires with `details.live === false`. The event payload is the
       *  poison signal VideoPlayer tracks. */
      function emitEndlistParse(hls: MockHlsInstance, fragments: unknown[]): void {
        hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: { live: false, fragments } });
      }
      function detachCount(hls: MockHlsInstance): number {
        return hls.calls.filter((c) => c === "detachMedia").length;
      }

      it("a hard seek from the fully-ENDED stream rebuilds MSE (detach→attach→reload at the window tail) and resumes playback", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        const details = { live: false, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        await act(async () => emitEndlistParse(hls, details.fragments));
        // Chrome's natural EOF: 'pause' fires before 'ended', and the
        // element sits AT the truncated duration (== the listed edge here
        // — an honest end, so the d3-a2 round-1 watch has nothing to
        // repair; the early-'ended' shapes get their own describe below).
        const video = videoEl(v);
        mediaState(video).paused = true;
        mediaState(video).ended = true;
        mediaState(video).currentTime = 6;
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());

        const detachAt = hls.calls.indexOf("detachMedia");
        const attachAt = hls.calls.lastIndexOf("attachMedia");
        expect(
          detachAt,
          "the ENDLIST-poisoned pipeline was never rebuilt — the truncated MediaSource duration clamps the landing and the seek can never play (browser-player-F4-residual)",
        ).toBeGreaterThanOrEqual(0);
        expect(attachAt).toBeGreaterThan(detachAt);
        // Loading restarts at the listed window's tail (where the
        // seek-spawned run appends) with seekToStartPosition suppressed —
        // the landing owns the element's position from the 202 on.
        expect(hls.calls).toContain("startLoad(6,true)");
        // The ENDLIST-frozen level was re-opened inside the rebuild.
        expect(details.live).toBe(true);
        // Still paused at 202 time — a play() fired inside the rebuild is
        // aborted by the fresh attach's own load request (observed live).
        expect(mediaState(video).paused).toBe(true);

        // The seek-spawned run lands… (the fresh attach reset the
        // element's ended flag, as a real detach's load() does — an
        // element still 'ended' at landing time is the d4-a1.126 wedge,
        // pinned in its own describe)
        mediaState(video).ended = false;
        const landedDetails = {
          live: true,
          fragments: [farListedFragment(), { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" }],
        };
        hls.levels = [{ details: landedDetails }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails });
        });
        expect(video.currentTime, "the landing never seeked the element to the run's start").toBe(6);
        // …and a seek from 'ended' must PLAY once it lands, not sit on a
        // frozen frame — the family's acceptance. The rebuild's captured
        // intent fires at landing-assignment time, when the attach has
        // settled.
        expect(mediaState(video).paused).toBe(false);
      });

      it("the poison is sticky across un-ended refreshes — a hard seek long after the playlist went live again still rebuilds", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        // Seek run #1 completed once upon a time (ENDLIST parsed)…
        await act(async () => emitEndlistParse(hls, [farListedFragment()]));
        // …then a later seek un-ended the playlist and refreshes are live
        // again: the tracker's stale endList entity is STILL armed, so the
        // next hard seek must still rebuild (the one-segment early-'ended'
        // truncation of verify/browser-player-F4).
        const liveDetails = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details: liveDetails }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: liveDetails });
        });
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());

        expect(
          detachCount(hls),
          "an intermediate live refresh cleared the ENDLIST poison flag — the stale endList entity survives un-ending merges, so the rebuild must too",
        ).toBe(1);
      });

      it("one rebuild per poisoning: the next hard seek on the rebuilt pipeline does not tear the buffer down again", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        hls.levels = [{ details: { live: true, fragments: [farListedFragment()] } }];
        await act(async () => emitEndlistParse(hls, [farListedFragment()]));
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls)).toBe(1);

        // SPF-5: past the coalescing window, so this second hard seek
        // dispatches (and rebuild-checks) immediately, same as before.
        await act(async () => {
          vi.advanceTimersByTime(HARD_SEEK_COALESCE_MS);
        });
        // No ENDLIST parse since the rebuild — a fresh MediaSource and a
        // clean tracker have nothing to rebuild away from.
        apiPost.mockResolvedValueOnce({ targetMs: 20_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls)).toBe(1);
      });

      it("a viewer who deliberately paused mid-stream is rebuilt but NOT force-played, even once the landing assigns", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        hls.levels = [{ details: { live: true, fragments: [farListedFragment()] } }];
        await act(async () => emitEndlistParse(hls, [farListedFragment()]));
        const video = videoEl(v);
        mediaState(video).paused = true;
        mediaState(video).ended = false;
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls)).toBe(1);

        const landedDetails = {
          live: true,
          fragments: [farListedFragment(), { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" }],
        };
        hls.levels = [{ details: landedDetails }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails });
        });
        expect(video.currentTime).toBe(6);
        expect(mediaState(video).paused, "a rebuild must not override an explicit pause — same contract as a non-rebuilt hard seek").toBe(true);
      });

      it("a hard seek on a never-ENDLIST session does NOT rebuild — no buffer teardown on the ordinary hot path", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        hls.levels = [{ details: { live: true, fragments: [farListedFragment()] } }];
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

        await act(async () => button(v, "Forward 10 seconds").click());

        expect(detachCount(hls), "an un-poisoned hard seek paid a full MSE teardown — the rebuild must be gated on an actual ENDLIST parse").toBe(0);
      });
    });

    // ── d3-a2 REOPEN round 1: the second-ENDLIST honest end ────────────────
    // Even with the rebuild lever, a live→VOD transition can end
    // dishonestly, because hls.js records "closing fragment appended" ONLY
    // when the appended fragment carried `endList` at parse time
    // (fragment-tracker.ts bufferedEnd): if the ENDLIST refresh parses
    // AFTER the closing fragment buffered (a short post-rebuild seek run
    // chasing the live edge), endOfStream is never issued and the element
    // wedges "playing" at the EOF label with 'ended' never fired (verifier
    // 2/2); if a post-rebuild relocation re-appended the OLD run's closing
    // fragment from the still-ENDLIST playlist, the stale entity ends the
    // NEW run early (live: ended 9.5s short, DB requested 58 < produced
    // 62). VideoPlayer arms an observer watch at every ENDLIST parse:
    // inject the missing BUFFER_EOS once the closing fragment is buffered,
    // and rebuild-at-the-ended-position when 'ended' lands short of the
    // listed edge.
    describe("second-ENDLIST honest end (d3-a2 round 1)", () => {
      function emitEndlistParse(hls: MockHlsInstance, fragments: unknown[]): void {
        hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: { live: false, fragments } });
      }
      function detachCount(hls: MockHlsInstance): number {
        return hls.calls.filter((c) => c === "detachMedia").length;
      }
      function eosTriggerCount(hls: MockHlsInstance): number {
        return hls.calls.filter((c) => c === "trigger(hlsBufferEos)").length;
      }
      /** A two-fragment ENDLIST window: edge 20s, closing fragment 6s
       *  (midpoint 17, shortfall threshold 3). PDT = V8 source clock. */
      function endedWindow(): unknown[] {
        return [
          { programDateTime: 3_600_000, start: 0, duration: 14, relurl: "run1/s000000.m4s" },
          { programDateTime: 3_614_000, start: 14, duration: 6, relurl: "run1/s000001.m4s" },
        ];
      }

      it("never-ended wedge: ENDLIST parsed with the closing fragment already buffered — the watch injects BUFFER_EOS", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 19.93]]; // whole window appended, a hair short of the edge (the live 66ms shape)
        hls.levels = [{ details: { live: false, fragments: endedWindow() } }];
        await act(async () => emitEndlistParse(hls, endedWindow()));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });
        expect(
          eosTriggerCount(hls),
          "the never-ended wedge is unrepaired — hls.js cannot learn the closing fragment appended pre-ENDLIST, so nothing ever issues endOfStream and the element wedges 'playing' at the EOF label",
        ).toBe(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(eosTriggerCount(hls), "the injection must fire once per ENDLIST parse, not every tick").toBe(1);
      });

      it("does NOT inject while the closing fragment is still un-buffered (loading tail must not be truncated)", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 12]]; // closing fragment absent
        hls.levels = [{ details: { live: false, fragments: endedWindow() } }];
        await act(async () => emitEndlistParse(hls, endedWindow()));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(eosTriggerCount(hls)).toBe(0);
      });

      it("early-'ended' truncation: 'ended' short of the listed edge rebuilds at the ended position and resumes the real tail", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 12]];
        hls.levels = [{ details: { live: false, fragments: endedWindow() } }];
        await act(async () => emitEndlistParse(hls, endedWindow()));
        // hls.js EOS'd on the stale endList entity with only 12s of the
        // 20s window buffered; the element played out and ended early.
        mediaState(video).ended = true;
        mediaState(video).paused = true;
        mediaState(video).currentTime = 12;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });
        const detachAt = hls.calls.indexOf("detachMedia");
        expect(
          detachAt,
          "the early-'ended' stream was never repaired — the viewer silently lost the tail (live: DB requested 58 < produced 62) and progress wrote 'played' at a lie",
        ).toBeGreaterThanOrEqual(0);
        expect(hls.calls.lastIndexOf("attachMedia")).toBeGreaterThan(detachAt);
        // Loading resumes AT the ended position — the viewer keeps their
        // place and the tail plays from where the lie cut in.
        expect(hls.calls).toContain("startLoad(12,true)");
        expect(video.currentTime).toBe(12);
        // The captured intent (ended counts as playing) resumes once the
        // fresh attach has data — not inside the rebuild, where the
        // attach's own load request would abort it.
        expect(mediaState(video).paused).toBe(true);
        mediaState(video).ended = false; // the fresh attach reset the element
        await act(async () => {
          video.dispatchEvent(new Event("loadeddata"));
        });
        expect(mediaState(video).paused, "the recovered tail must PLAY — an ended viewer never chose to pause").toBe(false);
      });

      it("the tail-recovery rebuild is bounded: repeated dishonest ends stop repairing after the per-attach cap", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 12]];
        hls.levels = [{ details: { live: false, fragments: endedWindow() } }];
        mediaState(video).ended = true;
        mediaState(video).currentTime = 12;
        for (let round = 0; round < 4; round++) {
          await act(async () => emitEndlistParse(hls, endedWindow()));
          await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
          });
        }
        expect(
          detachCount(hls),
          "a pathological stream that keeps ending short must not rebuild-loop forever",
        ).toBe(2);
      });

      it("the full live chain: honest end → hard seek rebuild → still-ENDLIST re-read re-arms (suppressed) → the landing still assigns and resumes play", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        // ENDLIST #1, honestly ended at the edge (ct == edge 6) — the
        // watch retires without acting.
        const details = { live: false, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        await act(async () => emitEndlistParse(hls, [farListedFragment()]));
        mediaState(video).bufferedRanges = [[0, 6]];
        mediaState(video).paused = true;
        mediaState(video).ended = true;
        mediaState(video).currentTime = 6;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });
        expect(detachCount(hls), "an honest end must not be 'repaired'").toBe(0);
        // Hard seek from the ENDED state: rebuild.
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls)).toBe(1);
        // A nudge re-read raced the worker restart: still-ENDLIST. The
        // re-armed watch sees an 'ended' element whose old edge midpoint
        // is even buffered — and must do NOTHING while relocating.
        await act(async () => emitEndlistParse(hls, [farListedFragment()]));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900);
        });
        expect(hls.calls.filter((c) => c === "trigger(hlsBufferEos)"), "the suppressed watch acted mid-relocation").toEqual([]);
        expect(detachCount(hls), "the suppressed watch repaired mid-relocation").toBe(1);
        // The seek-spawned run lands — the landing must still assign the
        // element and consume the rebuild's play intent, exactly as
        // before round 1 (the watch must never eat a landing). The fresh
        // attach reset the element's ended flag (a still-'ended' landing
        // is the d4-a1.126 wedge, pinned in its own describe).
        mediaState(video).ended = false;
        const landedDetails = {
          live: true,
          fragments: [farListedFragment(), { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" }],
        };
        hls.levels = [{ details: landedDetails }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails });
        });
        expect(video.currentTime, "the landing never seeked the element to the run's start").toBe(6);
        expect(mediaState(video).paused, "the landing never resumed the seek-from-ended play intent").toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900);
        });
        expect(hls.calls.filter((c) => c === "trigger(hlsBufferEos)"), "a stale watch outlived the landing's live refresh").toEqual([]);
      });

      it("a live (un-ended) refresh cancels the watch — no injection against a playlist that grew a new run", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 19.93]];
        hls.levels = [{ details: { live: false, fragments: endedWindow() } }];
        await act(async () => emitEndlistParse(hls, endedWindow()));
        // A later refresh un-ends the playlist (seek-spawned run appended)
        // BEFORE any tick saw the buffered edge.
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: { live: true, fragments: endedWindow() } });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(eosTriggerCount(hls), "the watch outlived the ENDLIST state it was armed for — an injection now would truncate the growing stream").toBe(0);
      });

      it("a hard seek's rebuild cancels the watch and relocation suppresses a re-armed one (no EOS against the fresh pipeline)", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = videoEl(v);
        mediaState(video).bufferedRanges = [[0, 19.93]];
        const details = { live: false, fragments: endedWindow() };
        hls.levels = [{ details }];
        await act(async () => emitEndlistParse(hls, endedWindow()));
        // Hard seek before any tick: the rebuild consumes the poisoning and
        // must take the watch with it.
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls)).toBe(1);
        // Mid-relocation, a nudge re-read raced the worker restart and came
        // back still-ENDLIST — the watch re-arms but must stay suppressed:
        // firing now would endOfStream the just-rebuilt pipeline at the OLD
        // edge (the exact poisoning the rebuild cleared).
        await act(async () => emitEndlistParse(hls, endedWindow()));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_500);
        });
        expect(eosTriggerCount(hls), "the second-ENDLIST watch fired during a hard-seek relocation — that re-truncates the fresh MediaSource at the abandoned edge").toBe(0);
      });
    });

    // ── d4-a1.126: the EOS-wedged landing must repair itself ─────────────
    // Live-reproduced 2026-08-25 (2 of 4 identical 50%-from-fully-ENDED
    // re-seeks, instrumented event log rem-d4-a1-126-qalog-before-full
    // .json): after the hard-seek rebuild, the nudge's still-ENDLIST
    // re-read re-appends the OLD closing fragment (endList bit fresh from
    // the parse), re-arming the stale tracker entity the rebuild had just
    // cleared. The un-ending merge then CANCELS the d3-a2-r1 eos-watch
    // (correctly — its edge data is gone), the landing assigns and plays…
    // and ~150 ms later hls.js finishes appending everything listed,
    // `isEndListAppended` passes via the STALE entity, BUFFER_EOS →
    // endOfStream truncates the MediaSource at the appended edge, and
    // Chrome jumps the playhead there firing a spurious pause+'ended'
    // pair: element wedged paused+ended far past the target, scrubber
    // pinned, timeout toast auto-dismissed unseen. The same EOS can also
    // land BEFORE the landing (the element re-asserts 'ended' at the
    // parked tail; the landing's assignment then clamps to the truncated
    // duration — position unchanged, NO 'seeking' event, and hls.js's
    // stream controller never leaves State.ENDED: onMediaSeeking is its
    // only app-reachable exit). Either way the ONE lever that revives the
    // pipeline is the same detach→attach rebuild, re-run AT the landed
    // run's start, with play deferred to the fresh attach's loadeddata.
    describe("EOS-wedged landing repair (d4-a1.126)", () => {
      function emitEndlistParse(hls: MockHlsInstance, fragments: unknown[]): void {
        hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: { live: false, fragments } });
      }
      function detachCount(hls: MockHlsInstance): number {
        return hls.calls.filter((c) => c === "detachMedia").length;
      }
      /** The landed window: the pre-seek run0 fragment plus the
       *  seek-spawned run1 whose 50 s extent puts the spurious EOS jump
       *  (ct -> appended edge 56, source 60 000) far outside the landing
       *  evidence tolerance — the live failing shape (~48 s past the
       *  target). */
      function landedDetails(): { live: boolean; fragments: unknown[] } {
        return {
          live: true,
          fragments: [farListedFragment(), { programDateTime: 10_000, start: 6, duration: 50, relurl: "run1/s000001.m4s" }],
        };
      }
      /** Fully-ENDED pre-seek state + a hard seek that rebuilds: the
       *  d3-a2 flow every wedge shape starts from. */
      async function seekFromEnded(v: TestRender, hls: MockHlsInstance): Promise<HTMLVideoElement> {
        const details = { live: false, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        await act(async () => emitEndlistParse(hls, details.fragments));
        const video = videoEl(v);
        mediaState(video).paused = true;
        mediaState(video).ended = true;
        mediaState(video).currentTime = 6;
        apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
        await act(async () => button(v, "Forward 10 seconds").click());
        expect(detachCount(hls), "precondition: the hard seek from ENDED rebuilt once").toBe(1);
        return video;
      }

      it("post-landing spurious 'ended' (the live 2-of-4 chain) rebuilds at the landed run and resumes on loadeddata — no 'played' lie", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await seekFromEnded(v, hls);
        mediaState(video).ended = false; // the fresh attach reset the element
        hls.levels = [{ details: landedDetails() }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails() });
        });
        expect(video.currentTime, "precondition: the landing assigned").toBe(6);
        expect(mediaState(video).paused, "precondition: the landing resumed the seek-from-ended play intent").toBe(false);
        // The stale-entity EOS: duration truncates at the appended edge
        // and Chrome jumps the playhead there — pause + 'ended', 56 s on
        // an element whose target maps to 10 000 (source 60 000 > target
        // + 30 000, so this can never read as resume evidence).
        mediaState(video).ended = true;
        mediaState(video).paused = true;
        mediaState(video).currentTime = 56;
        mediaState(video).readyState = 4;
        await act(async () => {
          video.dispatchEvent(new Event("pause"));
          video.dispatchEvent(new Event("ended"));
        });
        expect(
          detachCount(hls),
          "the spurious mid-lifecycle 'ended' was never repaired — element left paused+ended past the target, scrubber pinned, toast auto-dismissed unseen (live sessions 01a0393d/2026-08-25)",
        ).toBe(2);
        expect(
          hls.calls.filter((c) => c === "startLoad(6,true)"),
          "the repair must reload at the LANDED run's start (the viewer's chosen position), like every rebuild: skipSeekToStartPosition, park at the landed start (2 explicit rebuilds + SPF-4/5's immediate arm-time nudge tick, which falls back to stopLoad/startLoad since this mock level carries no uri)",
        ).toHaveLength(3);
        expect(video.currentTime, "the repair parks the element at the landed start").toBe(6);
        // Play resumes only once the fresh attach has data — a play()
        // inside the rebuild is aborted by the attach's own load request
        // (the d3-a2 lesson).
        expect(mediaState(video).paused).toBe(true);
        mediaState(video).ended = false;
        await act(async () => {
          video.dispatchEvent(new Event("loadeddata"));
        });
        expect(mediaState(video).paused, "the repaired landing must PLAY — the viewer sought from 'ended', never chose to pause").toBe(false);
      });

      it("pre-landing EOS re-assert: a landing that finds the element 'ended' rebuilds INSTEAD of assigning into the dead pipeline", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await seekFromEnded(v, hls);
        // Before the run folds in, the still-ENDLIST re-read re-appended
        // the old closing fragment and hls.js EOS'd: the element
        // re-asserts ended at the parked tail, duration truncated there.
        // A plain currentTime assignment now clamps to the SAME position
        // — no 'seeking' event, stream controller parked in State.ENDED
        // forever (the original backlog #126 shape: 'the landing never
        // assigned/played within 20s').
        mediaState(video).ended = true;
        mediaState(video).paused = true;
        hls.levels = [{ details: landedDetails() }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails() });
        });
        expect(
          detachCount(hls),
          "the landing assigned into an EOS-truncated pipeline — the clamped no-op fires no 'seeking' and nothing ever leaves State.ENDED",
        ).toBe(2);
        // 2 explicit rebuilds + SPF-4/5's immediate arm-time nudge tick
        // (falls back to stopLoad/startLoad — this mock level carries no uri).
        expect(hls.calls.filter((c) => c === "startLoad(6,true)")).toHaveLength(3);
        expect(mediaState(video).paused, "play waits for the fresh attach's data").toBe(true);
        mediaState(video).ended = false;
        await act(async () => {
          video.dispatchEvent(new Event("loadeddata"));
        });
        expect(mediaState(video).paused).toBe(false);
      });

      it("repairs are bounded per lifecycle: a pipeline that keeps EOS-wedging stops rebuilding after the cap", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await seekFromEnded(v, hls);
        mediaState(video).ended = false;
        hls.levels = [{ details: landedDetails() }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails() });
        });
        for (let round = 0; round < 3; round++) {
          mediaState(video).ended = true;
          mediaState(video).paused = true;
          mediaState(video).currentTime = 56;
          await act(async () => {
            video.dispatchEvent(new Event("pause"));
            video.dispatchEvent(new Event("ended"));
          });
          mediaState(video).ended = false;
        }
        expect(
          detachCount(hls),
          "the wedge repair must be bounded (1 seek rebuild + at most 2 repairs), never a rebuild loop",
        ).toBe(3);
      });

      it("post-evidence EOS jump (the live AFTER variant): a mid-film 'ended' far short of the item duration repairs at the viewer's honest clock position", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        const video = await seekFromEnded(v, hls);
        mediaState(video).ended = false;
        hls.levels = [{ details: landedDetails() }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landedDetails() });
        });
        // The element advances a few frames past the run boundary before
        // the EOS strikes — resume evidence COMPLETES the lifecycle
        // (live 2026-08-25 AFTER-run: playing 162.496 → jump 144 ms
        // later), so the landed-lifecycle detector alone cannot see the
        // wedge that follows.
        mediaState(video).readyState = 4;
        mediaState(video).currentTime = 6.6;
        await act(async () => {
          video.dispatchEvent(new Event("timeupdate"));
        });
        // The stale-entity EOS truncates at the appended edge and Chrome
        // jumps the playhead there: pause + 'ended' at source 60 000 of a
        // 600 000 ms item — a lie by 540 s.
        mediaState(video).ended = true;
        mediaState(video).paused = true;
        mediaState(video).currentTime = 56;
        await act(async () => {
          video.dispatchEvent(new Event("pause"));
          video.dispatchEvent(new Event("ended"));
        });
        expect(
          detachCount(hls),
          "an hls.js 'ended' mapping 540 s short of the known duration was believed — the viewer is wedged paused+ended mid-film with progress marked played",
        ).toBe(2);
        expect(video.currentTime, "the repair must park at the viewer's honest (gate-protected) position, never the jumped edge").toBeLessThan(7);
        expect(mediaState(video).paused).toBe(true);
        mediaState(video).ended = false;
        await act(async () => {
          video.dispatchEvent(new Event("loadeddata"));
        });
        expect(mediaState(video).paused).toBe(false);
      });

      it("an HONEST at-EOF landing playout ('ended' within probe slop of the duration) completes the lifecycle with NO repair rebuild", async () => {
        const { v, hls } = await renderHlsReady();
        view = v;
        vi.useFakeTimers();
        // Live window, no ENDLIST anywhere: an ordinary near-EOF hard
        // seek — the target sits by the 600 000 ms item duration, and the
        // playout ends within slop of it.
        const details = { live: true, fragments: [farListedFragment()] };
        hls.levels = [{ details }];
        apiPost.mockResolvedValueOnce({ targetMs: 595_000 });
        await act(async () => {
          // Drive hardSeek via the scrubber path: Forward 10 seconds POSTs
          // whatever the server clamps — the mock's 202 names the target.
          button(v, "Forward 10 seconds").click();
        });
        const landed = {
          live: true,
          fragments: [farListedFragment(), { programDateTime: 595_000, start: 6, duration: 5, relurl: "run1/s000001.m4s" }],
        };
        hls.levels = [{ details: landed }];
        await act(async () => {
          hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: landed });
        });
        const video = videoEl(v);
        // The tail plays out and ends 4.9 s past the target, 100 ms short
        // of the duration — inside the resume-evidence window, an honest
        // end on both axes.
        mediaState(video).readyState = 4;
        mediaState(video).ended = true;
        mediaState(video).paused = true;
        mediaState(video).currentTime = 10.9;
        await act(async () => {
          video.dispatchEvent(new Event("pause"));
          video.dispatchEvent(new Event("ended"));
        });
        expect(detachCount(hls), "an honest at-EOF playout must never be 'repaired'").toBe(0);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 5_000);
        });
        expect(document.body.textContent, "the honest end completed the lifecycle — no false timeout").not.toContain("Seek timed out");
      });
    });
  });

  // ── gap-F5: POST /seek network-failure surface ───────────────────────────
  // QA 2026-08-20/21 (P2): a network-layer /seek failure reportedly rendered
  // NO toast and left the scrubber pinned at the failed target. NOT
  // reproducible at HEAD (2026-08-23 live repro, Playwright route
  // abort/500/429 against the real stack: exactly one POST per drag, toast
  // rendered, scrubber back on the live clock) — the QA-era seek lifecycle
  // was rewritten wholesale by gap-F4's supersession-epoch model. These pin
  // the owner's contract so it cannot regress silently: EVERY network-shaped
  // failure of the current seek (fetch rejection / 5xx / 429) surfaces the
  // "Seek failed" toast, and the scrubber always returns to the live
  // position — never a stale pin at a dead target.
  // ── d4-a2.114: the native-HLS hard-seek lifecycle dies with the player ──
  // clearLandingWatch is wired into the hls.js attach effect's CLEANUP, but
  // on the native-HLS path (no MSE, so no hls.js instance) that effect
  // returns before ever producing a cleanup — a mid-relocation Back leaked
  // the 20 s landing timer AND the 500 ms coarse seekable-end poll: the
  // "Seek timed out" toast then fired against a player that no longer
  // exists, surfacing on whatever page the viewer had moved on to.
  describe("native-HLS hard-seek lifecycle dies with the player (d4-a2.114)", () => {
    it("unmounting mid-relocation clears the landing timer and coarse poll — no zombie 'Seek timed out' toast after Back", async () => {
      // Route attachStrategy to 'native-hls': native HLS claimed, no MSE
      // (jsdom has none) — the same lever the token-refresh native tests
      // use; the shared afterEach restores canPlayType unconditionally.
      Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", { configurable: true, value: () => "maybe" });
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      // The ToastProvider deliberately OUTLIVES the player (as the app
      // shell's providers do on an in-app Back) so a zombie toast has a
      // live surface to appear on.
      let v: TestRender | null = null;
      await act(async () => {
        v = renderIntoBody(
          <ToastProvider>
            <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} />
          </ToastProvider>,
        );
      });
      view = v;
      await act(async () => {});
      const video = videoEl(v!);
      // Safari's native source clock: PDT at presentation 0 == source 0,
      // and an EMPTY seekable window, so a +10 s seek classifies HARD
      // (out of seekable -> POST /seek -> landing timer + coarse poll).
      Object.defineProperty(video, "getStartDate", { configurable: true, value: () => new Date(0) });
      Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => ({ length: 0, start: () => 0, end: () => 0 }),
      });
      vi.useFakeTimers();
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
      await act(async () => button(v!, "Forward 10 seconds").click());
      expect(apiPost, "the +10s seek was expected to classify HARD on the native path").toHaveBeenCalledTimes(1);
      // The 202 armed the lifecycle under fake timers: the 20 s landing
      // timer and the 500 ms coarse poll are both pending now.
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

      // In-app Back: the player unmounts, the app shell (ToastProvider)
      // stays.
      await act(async () => {
        v!.rerender(
          <ToastProvider>
            <div />
          </ToastProvider>,
        );
      });
      expect(
        vi.getTimerCount(),
        "the native hard-seek lifecycle survived unmount — the 20s landing timer/500ms coarse poll leaked (d4-a2.114)",
      ).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 1_000);
      });
      expect(
        document.body.textContent,
        "the leaked landing timer toasted against an unmounted player",
      ).not.toContain("Seek timed out");
    });
  });

  describe("hard-seek failure surface (gap-F5)", () => {

    /** One listed fragment far from source 0 (PDT ms == source ms), so a
     *  small target is outside the listed window -> classified HARD. */
    function farWindow(): { live: boolean; fragments: unknown[] } {
      return {
        live: true,
        fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000000.m4s" }],
      };
    }

    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      hls.levels = [{ details: farWindow() }];
      return { v, hls };
    }

    function sliderNow(v: TestRender): string | null {
      const slider = v.container.querySelector('[role="slider"]');
      if (!slider) throw new Error("no scrubber rendered");
      return slider.getAttribute("aria-valuenow");
    }

    /** One live-mapped timeupdate at presentation 1 s: unless something left
     *  the display pinned, the scrubber follows the window's PDT mapping to
     *  source 3 601 000. */
    async function liveTick(v: TestRender): Promise<void> {
      const video = videoEl(v);
      await act(async () => {
        video.currentTime = 1;
        video.dispatchEvent(new Event("timeupdate"));
      });
    }

    it("a network-layer fetch rejection on POST /seek toasts and the scrubber returns to the live clock", async () => {
      const { v } = await renderHlsReady();
      view = v;
      apiPost.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await act(async () => button(v, "Forward 10 seconds").click());

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(
        document.body.textContent,
        "the hard-seek .catch never surfaced the failure — a silent seek loss",
      ).toContain(formatSeekFailedToast(null));
      // No stale pin: the failed target must not freeze the display — the
      // next timeupdate maps through the live window again.
      await liveTick(v);
      expect(sliderNow(v)).toBe("3601000");
    });

    it("an HTTP 5xx problem response toasts the same failure", async () => {
      const { v } = await renderHlsReady();
      view = v;
      apiPost.mockRejectedValueOnce(
        new LoombreApiError(500, {
          type: "urn:loombre:problem:internal",
          title: "Internal Server Error",
          status: 500,
          detail: "transcoder configuration write failed",
        }),
      );

      await act(async () => button(v, "Forward 10 seconds").click());

      expect(document.body.textContent).toContain(formatSeekFailedToast(500));
      await liveTick(v);
      expect(sliderNow(v)).toBe("3601000");
    });

    it("a 429 toasts too — only 401s are retried; every other status is THIS seek's failure", async () => {
      const { v } = await renderHlsReady();
      view = v;
      apiPost.mockRejectedValueOnce(
        new LoombreApiError(429, {
          type: "urn:loombre:problem:too-many-requests",
          title: "Too Many Requests",
          status: 429,
          detail: "Seek rate limit exceeded.",
        }),
      );

      await act(async () => button(v, "Forward 10 seconds").click());

      expect(document.body.textContent).toContain(formatSeekFailedToast(429));
      await liveTick(v);
      expect(sliderNow(v)).toBe("3601000");
    });

    it("a failed re-seek UNPINS a predecessor's relocating scrubber — no stale pin at either target", async () => {
      const { v } = await renderHlsReady();
      view = v;
      vi.useFakeTimers();
      // Seek #1 succeeds: the 202 pins the scrubber at the clamped target
      // and freezes the display while relocating.
      apiPost.mockResolvedValueOnce({ targetMs: 111_111 });
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(sliderNow(v)).toBe("111111");
      await liveTick(v);
      expect(sliderNow(v)).toBe("111111");

      // SPF-5: past the coalescing window, so seek #2 below dispatches
      // immediately instead of coalescing into seek #1.
      await act(async () => {
        vi.advanceTimersByTime(HARD_SEEK_COALESCE_MS);
      });
      // Seek #2 (the newest epoch owner) fails at the network layer.
      apiPost.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await act(async () => button(v, "Forward 10 seconds").click());

      expect(document.body.textContent).toContain(formatSeekFailedToast(null));
      // The failure releases the pin: the live clock repossesses the
      // scrubber instead of a dead target (111 111 or 121 111) holding it.
      await liveTick(v);
      expect(sliderNow(v)).toBe("3601000");
    });
  });

  // ── browser-player-F9: deep-link ?t= on transcode sessions ──────────────
  // QA 2026-08-20/21 (P1): /watch/{item}?t=600 on a transcode session
  // started playback at 0:00. The prompt-skip half worked (no progress
  // lookup, no resume prompt), but the offset itself only ever rode
  // `pendingSeekMsRef` into the hls.js attach as a PRESENTATION-axis
  // position (the config's `startPositionSec` + the loadedmetadata
  // `currentTime` assignment) — which can only land inside the served
  // playlist window. A fresh transcode session serves ~the first run's few
  // segments, so an out-of-window target was silently clamped by hls.js/
  // MSE and no V8 hard seek (POST /seek) was ever issued: nothing
  // restarted the transcoder at the target. Restricted-scene chapter links
  // share this exact path.
  describe("deep-link startMs on transcode sessions (browser-player-F9)", () => {
    /** run0's listed window: source 0–12 s (PDT ms == source ms, §9.1.5
     *  rule 7) — the extent a fresh transcode session's served playlist
     *  actually covers right after create. */
    function run0Window(): { live: boolean; fragments: unknown[] } {
      return {
        live: true,
        fragments: [
          { programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" },
          { programDateTime: 6_000, start: 6, duration: 6, relurl: "run0/s000001.m4s" },
        ],
      };
    }

    async function renderHlsReadyWithStart(startMs: number): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady(vi.fn(), undefined, startMs);
      // The hlsjs attach effect is async (token await + dynamic import) —
      // one more macro/microtask flush lets it construct the mock instance.
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    it("an out-of-window startMs issues the V8 hard seek (POST /seek at the source target) and lands on the seek-spawned run", async () => {
      apiPost.mockResolvedValue({ targetMs: 600_000 });
      const { v, hls } = await renderHlsReadyWithStart(600_000);
      view = v;
      const details = run0Window();
      hls.levels = [{ details }];
      // The first playlist read — the first moment the served window is
      // knowable, and therefore the first moment the axis decision can run.
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });

      expect(
        apiPost,
        "?t= on a transcode session must become a V8 hard seek — the presentation-axis startPosition/currentTime clamp starts playback at 0 instead (browser-player-F9)",
      ).toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.objectContaining({ body: { targetMs: 600_000 } }));

      // The display pins at the deep-link target while the worker restarts.
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("600000");

      // loadedmetadata must NOT drag the element to presentation 600 s —
      // that axis is the very bug: the target only exists in SOURCE time.
      const video = videoEl(v);
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });
      expect(video.currentTime, "the routed-hard start must suppress the presentation-axis loadedmetadata assignment").toBe(0);

      // The seek-spawned run appears in the served window: the landing
      // watch armed by the deep-link hard seek completes exactly like a
      // scrubber hard seek's.
      details.fragments = [...details.fragments, { programDateTime: 600_000, start: 12, duration: 6, relurl: "run1/s000000.m4s" }];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(video.currentTime, "the landing never seeked the element to the seek-spawned run's start").toBe(12);
    });

    it("an in-window startMs stays on the presentation axis — no POST /seek, no needless transcoder restart (A2)", async () => {
      const { v, hls } = await renderHlsReadyWithStart(6_500);
      view = v;
      hls.levels = [{ details: run0Window() }];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(apiPost).not.toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.anything());
    });
  });

  // ── browser-player-F1: hls.js fatal-error recovery ───────────────────────
  // QA 2026-08-20/21 (P1, + three verified duplicates): when the worker's
  // transcode died mid-session (session status -> 'failed', playlists 404),
  // the hls.js ERROR handler retried NETWORK_ERROR fatals with
  // `hls.startLoad()` UNBOUNDEDLY — an endless ~1/s media.m3u8 404 loop
  // behind an indefinite spinner, no UnavailableScreen, no toast, and the
  // session's server-side failed status was never consulted. The native
  // attach effect already had bounded recovery + a fatal-unavailable path;
  // the hls.js path must share the SAME policy: bounded retries, then
  // inspect the session and render UnavailableScreen with the session's
  // errorCode when the server marked it failed.
  describe("hls.js fatal-error recovery (browser-player-F1)", () => {
    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      // The hlsjs attach effect is async (token await + dynamic import) —
      // one more macro/microtask flush lets it construct the mock instance.
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    /** Routes the component's session-inspect GET (goFatal's
     *  `/playback/sessions/{id}`) while keeping the chapters GET happy. */
    function routeSessionGet(sessionBody: PlaybackSession): void {
      apiGet.mockImplementation((path: unknown) =>
        path === "/playback/sessions/{id}" ? Promise.resolve(sessionBody) : Promise.resolve({ items: [] }),
      );
    }

    function retryCount(hls: MockHlsInstance, call: string): number {
      return hls.calls.filter((c) => c.startsWith(call)).length;
    }

    /** Emits fatal hls.js errors with enough clock between them that every
     *  retry the bounded policy is willing to run actually runs (the same
     *  4s cooldown the native attach path uses). */
    async function emitFatals(hls: MockHlsInstance, type: string, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await act(async () => {
          // SPF-7 Phase B: a real hls.js ErrorData always carries `details`
          // (ErrorDetails is non-optional) — the mock supplies a plausible
          // one per type so goFatal's client-cause classification renders
          // real text instead of a literal "undefined".
          hls.emit("hlsError", "hlsError", { fatal: true, type, details: `${type}Mock` });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_100);
        });
      }
    }

    it("a FAILED session's playlist-404 fatal loop is bounded, then UnavailableScreen renders the session's errorCode copy", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "failed", errorCode: "transcode-failed" });
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 6);

      expect(
        retryCount(hls, "startLoad"),
        "hls.js network-fatal retries must be bounded (3, like the native attach path) — unbounded startLoad() is the endless 404 loop",
      ).toBeLessThanOrEqual(3);
      expect(
        document.body.textContent,
        "exhausted retries on a server-side FAILED session must surface UnavailableScreen with the errorCode's copy",
      ).toContain("Transcoding failed");
      expect(document.body.textContent).toContain("transcode-failed");
    });

    it("Cluster F's encoder-malfunction errorCode renders its own distinct copy", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "failed", errorCode: "transcode-encoder-malfunction" });
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 5);

      expect(document.body.textContent).toContain("encoder");
      expect(document.body.textContent).toContain("transcode-encoder-malfunction");
    });

    it("exhaustion with a session the server does NOT report failed falls back to the client-synthesized reason", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet(hlsTranscodeSession()); // status 'created' — a transient network failure, not a dead session
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 5);

      // SPF-7 Phase B: the generic "Playback failed in this browser"
      // fallback is now the SPECIFIC hls.js network-fatal cause — the
      // budget spent retrying it (3 attempts) reaches the screen too.
      const text = document.body.textContent ?? "";
      expect(text).toContain("The stream stopped loading");
      expect(text).toContain("hls-network-error");
      expect(text).toContain("networkErrorMock");
      expect(text).toContain("after 3 retries");
    });

    it("fatal MEDIA_ERROR shares the same bounded budget via recoverMediaError()", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "failed", errorCode: "transcode-failed" });
      vi.useFakeTimers();

      await emitFatals(hls, "mediaError", 6);

      expect(
        retryCount(hls, "recoverMediaError"),
        "hls.js media-fatal retries must consume the same bounded budget",
      ).toBeLessThanOrEqual(3);
      expect(document.body.textContent).toContain("Transcoding failed");
    });

    it("an OTHER-typed fatal (no in-place lever exists) goes straight to the unavailable path, never a silent destroy", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "failed", errorCode: "transcode-failed" });
      vi.useFakeTimers();

      await emitFatals(hls, "otherError", 1);

      expect(document.body.textContent).toContain("Transcoding failed");
    });

    it("the element's 'playing' event resets the hls.js retry budget — a recovered stretch earns a fresh 3", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet(hlsTranscodeSession());
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 3); // budget consumed
      expect(retryCount(hls, "startLoad")).toBe(3);

      const video = videoEl(v);
      await act(async () => {
        video.dispatchEvent(new Event("playing")); // real playback again
      });

      await emitFatals(hls, "networkError", 1);
      expect(
        retryCount(hls, "startLoad"),
        "a stretch that reached real playback again must retry, not go fatal on its first new failure",
      ).toBe(4);
      expect(document.body.textContent).not.toContain("Playback failed in this browser");
    });
  });

  // ── d3-a5: player error/UX surfaces ─────────────────────────────────────
  // Three honesty defects on the fatal/failure surfaces (QA 2026-08-20/21,
  // P3): (1) goFatal only special-cased inspect status 'failed', so a
  // session the SERVER ended mid-playback (eviction/idle sweep/another
  // device) was blamed on the client ("Playback failed in this browser");
  // (2) every fatal path rendered under the default REFUSED framing
  // ("Session refused · planner reasons, verbatim") even though playback had
  // already started — AQ's d3-aq6 `variant` prop exists exactly for this;
  // (3) the two seek-failure toasts rode the default accent variant while
  // every other failure toast in the app passes { variant: "danger" }.
  describe("player error/UX surfaces (d3-a5)", () => {
    /** One listed fragment far from source 0, so a small forward target is
     *  outside the listed window -> classified HARD (same seam as the
     *  gap-F5 failure-surface tests above). */
    function farWindow(): { live: boolean; fragments: unknown[] } {
      return {
        live: true,
        fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000000.m4s" }],
      };
    }

    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      hls.levels = [{ details: farWindow() }];
      return { v, hls };
    }

    /** Routes goFatal's session-inspect GET while keeping the chapters GET
     *  happy (same helper shape as the browser-player-F1 describe). */
    function routeSessionGet(sessionBody: PlaybackSession): void {
      apiGet.mockImplementation((path: unknown) =>
        path === "/playback/sessions/{id}" ? Promise.resolve(sessionBody) : Promise.resolve({ items: [] }),
      );
    }

    async function emitFatals(hls: MockHlsInstance, type: string, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await act(async () => {
          // SPF-7 Phase B: a real hls.js ErrorData always carries `details`
          // (ErrorDetails is non-optional) — the mock supplies a plausible
          // one per type so goFatal's client-cause classification renders
          // real text instead of a literal "undefined".
          hls.emit("hlsError", "hlsError", { fatal: true, type, details: `${type}Mock` });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_100);
        });
      }
    }

    /** The toast's severity dot, only while a toast is actually visible. */
    function visibleToastVariant(): string | null {
      return document.querySelector('[data-visible="true"] [data-variant]')?.getAttribute("data-variant") ?? null;
    }

    it("a session the server ENDED mid-playback renders honest session-ended copy — never 'Playback failed in this browser'", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "ended", errorCode: null });
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 5);

      const text = document.body.textContent ?? "";
      expect(
        text,
        "an eviction/idle-sweep/other-device session end must not be blamed on this browser",
      ).not.toContain("Playback failed in this browser");
      expect(text).toContain(SESSION_ENDED_CODE);
      expect(text).toContain(describeSessionFailureCode(SESSION_ENDED_CODE)?.title);
    });

    it("the fatal surfaces wear the FAILED framing — the pill must never read 'Session refused' for a runtime failure", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet({ ...hlsTranscodeSession(), status: "failed", errorCode: "transcode-failed" });
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 5);

      expect(document.body.textContent).toContain("Session failed");
      expect(document.body.textContent).not.toContain("Session refused");
    });

    it("client-side exhaustion (server session still healthy) keeps the client-error reason but wears the FAILED framing too", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      routeSessionGet(hlsTranscodeSession()); // status 'created'
      vi.useFakeTimers();

      await emitFatals(hls, "networkError", 5);

      // SPF-7 Phase B: the specific client cause, not the generic fallback.
      expect(document.body.textContent).toContain("The stream stopped loading");
      expect(document.body.textContent).toContain("hls-network-error");
      expect(document.body.textContent).toContain("Session failed");
      expect(document.body.textContent).not.toContain("Session refused");
    });

    it("the seek-FAILED toast is a danger toast, not the accent default", async () => {
      const { v } = await renderHlsReady();
      view = v;
      apiPost.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await act(async () => button(v, "Forward 10 seconds").click());

      expect(document.body.textContent).toContain("Seek failed");
      expect(visibleToastVariant()).toBe("danger");
    });

    it("the seek-TIMED-OUT toast is a danger toast too", async () => {
      const { v } = await renderHlsReady();
      view = v;
      vi.useFakeTimers();
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });

      await act(async () => button(v, "Forward 10 seconds").click());
      // Nothing ever lands (no LEVEL_UPDATED with the seek run) — the 20 s
      // lifecycle timer fires the timeout toast.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });

      expect(document.body.textContent).toContain("Seek timed out");
      expect(visibleToastVariant()).toBe("danger");
    });
  });

  // ── gap-F6: phantom heartbeat progress ──────────────────────────────────
  // QA 2026-08-20/21 (P1): a fresh, untouched direct-stream session
  // self-relocated run0→run7 (server-side implicit-seek churn), the element
  // wedged at vt 0 / readyState 1, and the heartbeat STILL wrote progress
  // ~7:31 — presentation 0 mapped through the RELOCATED run's PDT origin —
  // for content never watched. That phantom row then silently seeded the
  // next session's resume point. Progress writes need REAL playback
  // advancement (or an explicit user seek), never a relocated origin.
  describe("phantom heartbeat progress (gap-F6)", () => {
    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    it("a relocated source origin with NO real playback advancement never writes progress", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      // The wedge shape: the playlist has churned to a late run whose PDT
      // origin is ~7:31 into the source, while the element never displayed
      // a single frame (vt 0, readyState 1 = HAVE_METADATA).
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 451_000, start: 0, duration: 6, relurl: "run7/s000237.m4s" }] } }];
      const video = videoEl(v);

      await act(async () => button(v, "Play").click()); // heartbeat armed
      await act(async () => {
        mediaState(video).readyState = 1;
        video.dispatchEvent(new Event("timeupdate")); // vt 0 → maps to source 451_000
        video.pause(); // pause flush — wrote 451_000 pre-fix
      });
      expect(apiPut, "phantom progress was written for content never watched").not.toHaveBeenCalled();

      // The unmount flush must not report it either.
      v.unmount();
      view = null;
      expect(reportProgressOnUnload).not.toHaveBeenCalled();
    });

    it("after REAL advancement, a relocated-origin jump does not overwrite the watched position", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      const details = {
        live: true,
        fragments: [
          { programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" },
          { programDateTime: 6_000, start: 6, duration: 6, relurl: "run0/s000001.m4s" },
        ],
      };
      hls.levels = [{ details }];
      const video = videoEl(v);

      await act(async () => button(v, "Play").click());
      await act(async () => {
        mediaState(video).readyState = 4;
        video.currentTime = 5.75;
        video.dispatchEvent(new Event("timeupdate")); // baseline sample
        video.currentTime = 6;
        video.dispatchEvent(new Event("timeupdate")); // real advancement → watched 6_000
      });

      // The playlist relocates under the player (no user seek): vt 0 now
      // maps to source 451_000. The jump is not advancement.
      details.fragments = [{ programDateTime: 451_000, start: 0, duration: 6, relurl: "run7/s000237.m4s" }];
      await act(async () => {
        video.currentTime = 0;
        video.dispatchEvent(new Event("timeupdate"));
        video.pause();
      });

      const lastBody = (apiPut.mock.calls.at(-1)?.[1] as { body?: { positionMs?: number } } | undefined)?.body;
      expect(lastBody?.positionMs, "the flush must report the last WATCHED position, not the relocated origin").toBe(6_000);
    });

    it("GENUINE advancement under a relocated MAPPING does not launder the mapped position into progress", async () => {
      // Observed live: the element really was playing (its buffered
      // pre-relocation content), but the playlist had churned underneath
      // it, so presentation ~12s mapped through the relocated run's PDT
      // origin to source ~412s — and that mapped lie was written.
      const { v, hls } = await renderHlsReady();
      view = v;
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 400_000, start: 0, duration: 200, relurl: "run7/s000237.m4s" }] } }];
      const video = videoEl(v);

      await act(async () => button(v, "Play").click());
      await act(async () => {
        mediaState(video).readyState = 4;
        // Real, smooth advancement — but every position maps ~400s ahead.
        for (let t = 0; t < 12; t += 2.5) {
          video.currentTime = t;
          video.dispatchEvent(new Event("timeupdate"));
        }
        video.pause();
      });
      expect(apiPut, "a relocated mapping of genuinely-advancing positions was written as progress").not.toHaveBeenCalled();
    });

    it("an explicit user seek still writes progress immediately (no advancement required)", async () => {
      const v = (view = await renderReady()); // direct-play default fixture
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPut).toHaveBeenCalledTimes(1);
      expect(apiPut.mock.calls[0]?.[1]).toMatchObject({ body: { positionMs: 10_000 } });
    });
  });

  // ── d3-a4: progress-write correctness ───────────────────────────────────
  // verify/gap-F6 (P2): every in-session heartbeat PUT /progress 422'd —
  // 'durationMs must be an integer or null' — because the heartbeat send()
  // rounded positionMs but passed the adopted element duration RAW, and an
  // HLS element duration is fractional (observed live: 773347.5). Only the
  // unload path (lib/progress-report.ts) rounded both, so progress writes
  // silently stopped for the whole session (6x 422 in one live run).
  // A/gap-F10-adjacent: duration adoption rides the PRESENTATION axis on
  // relocated playlists (segment numbering continues past nominal EOF) —
  // growth-only adopted 1810859ms on the 586s Idol and PERSISTED it via
  // PUT /progress. The adoption guard needs a plausibility bound against
  // the session's probed duration, and integer ms always.
  describe("progress-write correctness (d3-a4)", () => {
    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    it("the heartbeat flush body carries an INTEGER durationMs even when the element adopted a fractional duration", async () => {
      // Direct-play adopts the element duration unconditionally — and real
      // element durations are fractional. The pause-flush PUT must still
      // send integer ms (the server 422s anything else, verify/gap-F6).
      const v = (view = await renderReady());
      const video = videoEl(v);
      Object.defineProperty(video, "duration", { get: () => 600.5004, configurable: true });
      await act(async () => {
        video.dispatchEvent(new Event("durationchange"));
      });
      await act(async () => button(v, "Play").click());
      apiPut.mockClear();
      await simulateWatchedTo(video, 42);
      await act(async () => {
        video.pause();
      });
      expect(apiPut).toHaveBeenCalledTimes(1);
      const body = (apiPut.mock.calls[0]?.[1] as { body?: { positionMs?: number; durationMs?: number | null } }).body;
      expect(body?.durationMs, "fractional durationMs reaches the wire — the server rejects the whole write with 422").toBe(600_500);
      expect(body?.positionMs).toBe(42_000);
    });

    it("an implausibly large presentation-axis duration on an HLS session (relocated playlist extent) is never adopted nor persisted", async () => {
      // The gap-F10-adjacent live shape scaled to this fixture: probed
      // duration 600s, relocated-playlist cumulative extent ~1810.859s
      // (segment numbering continued past nominal EOF). Growth-only
      // adoption took it; the probed session duration must govern.
      const { v } = await renderHlsReady();
      view = v;
      const video = videoEl(v);
      Object.defineProperty(video, "duration", { get: () => 1810.859, configurable: true });
      await act(async () => {
        video.dispatchEvent(new Event("durationchange"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(
        slider?.getAttribute("aria-valuemax"),
        "the relocated playlist's presentation extent was adopted over the probed duration",
      ).toBe("600000");

      await act(async () => button(v, "Play").click());
      apiPut.mockClear();
      await simulateWatchedTo(video, 30);
      await act(async () => {
        video.pause();
      });
      const body = (apiPut.mock.calls.at(-1)?.[1] as { body?: { durationMs?: number | null } }).body;
      expect(body?.durationMs, "the implausible adopted duration was persisted via PUT /progress").toBe(600_000);
    });

    it("plausible fractional HLS duration growth is adopted as INTEGER ms", async () => {
      // The exact live 422 shape: the completed playlist's fractional
      // extent tops the probe by under a second (773347.5 vs 773347) —
      // legitimate growth, but the float poisoned every later heartbeat.
      const { v } = await renderHlsReady();
      view = v;
      const video = videoEl(v);
      Object.defineProperty(video, "duration", { get: () => 600.7503, configurable: true });
      await act(async () => {
        video.dispatchEvent(new Event("durationchange"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuemax"), "the adopted duration must be integer ms").toBe("600750");
    });

    it("a slow mapped-drift walk (source hopping ~9s per ~250ms sample) freezes the watched position instead of walking it", async () => {
      // A/watched-progress: the source-continuity gate alone admits any
      // drift ≤10s per accepted step — a relocated mapping whose PDT
      // origin creeps between refreshes walks the watched position
      // arbitrarily far while the element only plays milliseconds. Real
      // playback moves BOTH axes together (§9.1.6), so an accepted step
      // must be axis-commensurate too.
      const { v, hls } = await renderHlsReady();
      view = v;
      const fragment = { programDateTime: 0, start: 0, duration: 600, relurl: "run0/s000000.m4s" };
      hls.levels = [{ details: { live: true, fragments: [fragment] } }];
      const video = videoEl(v);

      await act(async () => button(v, "Play").click());
      // Genuine playback to t=30 under a stable mapping (source == pres).
      await simulateWatchedTo(video, 30);

      // The mapping now drifts: each playlist refresh shifts the PDT
      // origin +9s while the element advances 250ms — every step passes
      // the 10s continuity bound, but no real playback looks like this.
      await act(async () => {
        for (let i = 1; i <= 5; i += 1) {
          fragment.programDateTime = 9_000 * i;
          video.currentTime = 30 + 0.25 * i;
          video.dispatchEvent(new Event("timeupdate"));
        }
      });
      apiPut.mockClear();
      await act(async () => {
        video.pause();
      });
      const body = (apiPut.mock.calls.at(-1)?.[1] as { body?: { positionMs?: number } }).body;
      expect(
        body?.positionMs,
        "the drift walk laundered the mapped positions into the watched position (30_000 was the last real one)",
      ).toBe(30_000);
    });
  });

  // gap-F7 (QA 2026-08-20/21, P2): at a natural EOF the element fires
  // `pause` first, then `ended` (WHATWG media event order). Each handler
  // flushed its own fire-and-forget PUT /progress — two CONCURRENT HTTP
  // requests with no ordering guarantee — so the stale 'in-progress'
  // flush could persist AFTER the 'played' flush, leaving the final row
  // {state: 'in-progress', positionMs == durationMs, playCount unbumped}
  // (observed live: QA run 1 of the direct-play EOF repro). The fix
  // routes every apiPut progress write through ONE FIFO lane
  // (lib/progress-write-queue.ts): a write dispatches only after the
  // previous write settles, so the last-issued write is always the last
  // the server processes.
  describe("EOF progress-flush serialization (gap-F7)", () => {
    it("holds the ended 'played' flush until the in-flight pause 'in-progress' flush settles", async () => {
      const v = (view = await renderReady());
      const video = videoEl(v);
      await simulateWatchedTo(video, 599);
      apiPut.mockClear();
      // The pause flush's PUT hangs in flight.
      let releaseInProgressWrite: (() => void) | null = null;
      apiPut.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseInProgressWrite = () => resolve(undefined);
          }),
      );
      await act(async () => {
        // Natural EOF: pause fires, then ended.
        mediaState(video).ended = true;
        video.pause();
        video.dispatchEvent(new Event("ended"));
      });
      expect(
        apiPut,
        "the 'played' flush must WAIT for the in-flight 'in-progress' flush — concurrent PUTs let the stale in-progress write persist last and eat the played state",
      ).toHaveBeenCalledTimes(1);
      expect(apiPut.mock.calls[0]?.[1]).toMatchObject({ body: { state: "in-progress", positionMs: 599_000 } });

      await act(async () => {
        releaseInProgressWrite?.();
      });
      expect(apiPut).toHaveBeenCalledTimes(2);
      expect(apiPut.mock.calls[1]?.[1]).toMatchObject({ body: { state: "played", positionMs: 599_000 } });
    });

    it("a failed in-progress flush does not swallow the queued played flush", async () => {
      const v = (view = await renderReady());
      const video = videoEl(v);
      await simulateWatchedTo(video, 599);
      apiPut.mockClear();
      apiPut.mockImplementationOnce(() => Promise.reject(new Error("network drop")));
      await act(async () => {
        mediaState(video).ended = true;
        video.pause();
        video.dispatchEvent(new Event("ended"));
      });
      expect(apiPut).toHaveBeenCalledTimes(2);
      expect(apiPut.mock.calls.at(-1)?.[1]).toMatchObject({ body: { state: "played", positionMs: 599_000 } });
    });

    // The finding's other half — REGRESSION GUARD, closed by gap-F6's
    // watched-position gate: on an HLS run whose PDT origin > 0 the
    // pause/ended flushes used to send RAW ELEMENT TIME (presentation
    // axis, e.g. 122242 for a true source position of 568791), corrupting
    // the resume point. Every flush now reports the source-axis WATCHED
    // position. The pre-existing pause/ended tests above only cover the
    // direct-play fixture, where the two axes coincide and the bug was
    // invisible — this one pins the non-zero-origin case.
    it("pause and ended flushes report SOURCE-axis ms on a non-zero-origin run, never raw element time", async () => {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      // Deep-link intent at 566s — the resume/relocation shape: the run's
      // fragments start at source 566_000 while presentation starts at 0.
      const v = (view = await renderReady(vi.fn(), undefined, 566_000));
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      hls.levels = [
        { details: { live: true, fragments: [{ programDateTime: 566_000, start: 0, duration: 30, relurl: "run1/s000094.m4s" }] } },
      ];
      const video = videoEl(v);
      await act(async () => button(v, "Play").click());
      await act(async () => {
        mediaState(video).readyState = 4;
        // Real advancement: presentation 0 → 5s maps to source 566_000 → 571_000.
        for (let t = 0; t <= 5; t += 2.5) {
          video.currentTime = t;
          video.dispatchEvent(new Event("timeupdate"));
        }
      });
      apiPut.mockClear();
      await act(async () => {
        video.pause();
      });
      expect(apiPut).toHaveBeenCalledTimes(1);
      expect(
        apiPut.mock.calls[0]?.[1],
        "the pause flush must carry the SOURCE-axis position (571_000), not raw element time (5_000)",
      ).toMatchObject({ body: { state: "in-progress", positionMs: 571_000 } });

      await act(async () => {
        mediaState(video).ended = true;
        video.dispatchEvent(new Event("ended"));
      });
      expect(
        apiPut.mock.calls.at(-1)?.[1],
        "the ended flush must carry the SOURCE-axis position (571_000), not raw element time (5_000)",
      ).toMatchObject({ body: { state: "played", positionMs: 571_000 } });
    });
  });

  // ── browser-player-F6: displayed source-clock desync after hard seeks ───
  // QA 2026-08-20/21 (P2): after a hard-seek landing the displayed clock
  // transiently rode the WRONG AXIS for 5-40 s — either the raw
  // presentation axis (listedFragments() unreadable while an ABR switch's
  // level details refresh: the silent `sourceMs ?? currentTime * 1000`
  // fallback) or the OLD timeline (a stale pre-seek window still covering
  // the position with pre-restart PDTs). Live repro at HEAD: label showed
  // 2:54 (presentation) for ~12 s where the source truth was ~59:40. The
  // source-time mapping must be AUTHORITATIVE from the landing on: the
  // landed run's PDT/run origin anchors the clock, a window listing no run
  // at/after the landed run is untrusted, and when no trustworthy mapping
  // exists the clock HOLDS the last source-axis value — it never shows a
  // presentation-axis number on a source-clocked session.
  describe("displayed source-clock desync (browser-player-F6)", () => {
    /** run0's listed window — NON-zero source origin (3_600_000) so the
     *  presentation and source axes are visibly distinct everywhere. */
    function run0Fragment(): unknown {
      return { programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000000.m4s" };
    }
    /** The seek-spawned run: PDT == the clamped target (10_000). */
    function run1Fragment(): unknown {
      return { programDateTime: 10_000, start: 6, duration: 6, relurl: "run1/s000001.m4s" };
    }

    async function renderHlsReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    /** Drives a full hard seek (202 target 10_000) through landing AND
     *  resume evidence, leaving the clock advancing on the landed run's
     *  source axis. Last authoritative mapping: presentation 6.5 s ->
     *  source 10_500 (through run1's PDT). */
    async function landAndResume(v: TestRender, hls: MockHlsInstance): Promise<HTMLVideoElement> {
      const details = { live: true, fragments: [run0Fragment()] };
      hls.levels = [{ details }];
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);
      details.fragments = [run0Fragment(), run1Fragment()];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      const video = videoEl(v);
      expect(video.currentTime, "the landing never seeked the element to the run's start").toBe(6);
      mediaState(video).readyState = 4;
      await act(async () => {
        await video.play();
      });
      await act(async () => {
        video.currentTime = 6.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuenow"), "sanity: the landed clock maps through run1's PDT").toBe("10500");
      return video;
    }

    it("holds the source axis when an ABR switch exposes a level with no details yet — never the raw presentation axis", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      const video = await landAndResume(v, hls);
      // ABR switches to a rung whose level details have not refreshed yet —
      // the post-restart window where listedFragments() is unreadable.
      hls.levels = [{ details: { live: true, fragments: [run0Fragment(), run1Fragment()] } }, {}];
      hls.currentLevel = 1;
      await act(async () => {
        video.currentTime = 7.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(
        slider?.getAttribute("aria-valuenow"),
        "the displayed clock fell back to the raw presentation axis (7500) while the switched-to level's details refreshed — it must stay on the landed run's source axis",
      ).toBe("11500");
    });

    it("rejects a mapping through a STALE window (no run at/after the landed run) — the old timeline must not repossess the clock", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      const video = await landAndResume(v, hls);
      // The switched-to level's details were last fetched BEFORE the seek
      // restart: they still list ONLY run0, whose old-timeline PDT covers
      // presentation 7.5 s.
      hls.levels = [
        { details: { live: true, fragments: [run0Fragment(), run1Fragment()] } },
        { details: { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 12, relurl: "run0/s000000.m4s" }] } },
      ];
      hls.currentLevel = 1;
      await act(async () => {
        video.currentTime = 7.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(
        slider?.getAttribute("aria-valuenow"),
        "the displayed clock mapped through a stale pre-seek window onto the OLD timeline (3_607_500) — a window listing no run at/after the landed run is not trustworthy",
      ).toBe("11500");
    });

    it("a pause flush during the desync window persists the source axis, never the presentation axis", async () => {
      const { v, hls } = await renderHlsReady();
      view = v;
      const video = await landAndResume(v, hls);
      hls.levels = [{ details: { live: true, fragments: [run0Fragment(), run1Fragment()] } }, {}];
      hls.currentLevel = 1;
      // Two consecutive close samples = real advancement. At HEAD the
      // second sample's presentation-axis value (7500) also passes the
      // gap-F6 source-continuity gate (|7500 - 10000| <= 10 s, watched ==
      // the 202 target) and becomes the WATCHED position — the wrong axis
      // a heartbeat/pause flush then PERSISTS (the ledger's sub-claim c).
      await act(async () => {
        video.currentTime = 7;
        video.dispatchEvent(new Event("timeupdate"));
        video.currentTime = 7.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      apiPut.mockClear();
      await act(async () => {
        video.pause();
      });
      expect(apiPut).toHaveBeenCalledTimes(1);
      expect(
        apiPut.mock.calls[0]?.[1],
        "the pause flush persisted the presentation axis — a desync-window flush corrupts the resume point by the full axis gap",
      ).toMatchObject({ body: { positionMs: 11_500 } });
    });
  });

  // ── browser-player-F5: session end on full-document teardown ───────────
  // On a genuine full navigation / tab close the document is destroyed and
  // React unmount cleanups NEVER run — the "session end on unmount" effect
  // is unreachable, so the session lingered 'active'/'suspended' holding
  // its transcode slot for the 15-minute sweeper window (live repro:
  // suspended row + running ffmpeg 10s after goto-away). The only unload
  // path that fires is `pagehide`, which flushed progress but never ended
  // the session. Contract: a non-persisted pagehide also DELETEs the
  // session on the keepalive path; a persisted (bfcache) pagehide keeps it
  // (the document may come back alive and resume it); and the normal
  // in-app unmount path stays exactly one DELETE — never two.
  describe("session end on full-document teardown (browser-player-F5)", () => {
    it("a genuine pagehide ends the session on the keepalive path, alongside the progress flush", async () => {
      const v = (view = await renderReady());
      await simulateWatchedTo(videoEl(v), 12);

      window.dispatchEvent(new Event("pagehide"));
      expect(reportProgressOnUnload).toHaveBeenCalledTimes(1);
      expect(
        endPlaybackSessionOnUnload,
        "pagehide flushed progress but never ended the session — a full navigation orphans it until the sweeper",
      ).toHaveBeenCalledTimes(1);
      expect(endPlaybackSessionOnUnload).toHaveBeenCalledWith(SERVER_URL, SESSION_ID);
    });

    it("ends the session even when nothing ever played (no progress to flush)", async () => {
      view = await renderReady();

      window.dispatchEvent(new Event("pagehide"));
      expect(reportProgressOnUnload).not.toHaveBeenCalled();
      expect(endPlaybackSessionOnUnload).toHaveBeenCalledTimes(1);
      expect(endPlaybackSessionOnUnload).toHaveBeenCalledWith(SERVER_URL, SESSION_ID);
    });

    it("a bfcache pagehide (persisted) keeps the session alive for a possible restore", async () => {
      view = await renderReady();

      const persistedHide = new Event("pagehide");
      Object.defineProperty(persistedHide, "persisted", { value: true });
      window.dispatchEvent(persistedHide);
      expect(endPlaybackSessionOnUnload).not.toHaveBeenCalled();
    });

    it("the in-app unmount path stays exactly one DELETE, with no unload-path DELETE", async () => {
      const v = (view = await renderReady());
      await simulateWatchedTo(videoEl(v), 8);

      v.unmount();
      view = null;
      expect(endPlaybackSession).toHaveBeenCalledTimes(1);
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
      expect(endPlaybackSessionOnUnload).not.toHaveBeenCalled();
    });

    it("an unmount after the unload path already ended the session never DELETEs twice", async () => {
      const v = (view = await renderReady());

      window.dispatchEvent(new Event("pagehide"));
      expect(endPlaybackSessionOnUnload).toHaveBeenCalledTimes(1);

      v.unmount();
      view = null;
      expect(
        endPlaybackSession,
        "the unmount cleanup re-DELETEd a session the unload path already ended",
      ).not.toHaveBeenCalled();
    });
  });

  // ── gap-F10: the resume prompt's CHOICES on HLS transcode sessions ──────
  // The prompt itself renders symmetrically (pinned below — the QA-era
  // "opened silently at the position" was the gap-F6 phantom-progress /
  // churn era), but both choice handlers acted on the PRESENTATION axis
  // with a bare `currentTime` assignment. On an HLS transcode session that
  // is wrong twice over: a not-yet-produced target wedges the element at a
  // position no data ever arrives for (live repro: Resume→7:39 on run0's
  // ~3:40-produced window froze at readyState 1 for 35s+ while the
  // server's implicit derived-seek fallback churned runs 1..3 at the
  // WRONG origins), and even a LISTED target lands wrong whenever the
  // window's source origin is non-zero (presentation != source). Both
  // choices must route through the V8-classified `seek()` on the SOURCE
  // axis: soft when listed, the first-class POST /seek when not
  // (Start over = source 0 / a fresh run at 0).
  describe("resume choices on HLS transcode sessions (gap-F10)", () => {
    function dialogButtonByPrefix(v: TestRender, prefix: string): HTMLButtonElement {
      const dialog = v.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error("no open dialog");
      const el = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.startsWith(prefix));
      if (!el) throw new Error(`no dialog button starting with "${prefix}"`);
      return el;
    }

    async function renderHlsWithPrompt(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
      const v = await renderReady();
      // The hlsjs attach effect is async (token await + dynamic import) —
      // one more flush lets it construct the mock instance.
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      expect(v.container.querySelector('[role="dialog"]')).toBeTruthy();
      return { v, hls };
    }

    it("shows the resume prompt for an HLS transcode session without auto-seeking or auto-playing (the scout's missing HLS variant)", async () => {
      const { v } = await renderHlsWithPrompt();
      view = v;
      expect(v.container.textContent).toContain("You stopped at 2:00");
      expect(videoEl(v).currentTime).toBe(0);
      expect(videoEl(v).paused).toBe(true);
    });

    it("Resume with the target OUTSIDE the listed window POSTs the first-class /seek — never a presentation-axis clamp", async () => {
      const { v, hls } = await renderHlsWithPrompt();
      view = v;
      // run0's produced window covers source [0, 6000) only — the 120 000
      // resume target is unlisted, exactly the live wedge shape.
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" }] } }];
      apiPost.mockResolvedValueOnce({ targetMs: 120_000 });

      await act(async () => dialogButtonByPrefix(v, "Resume from").click());

      expect(
        apiPost,
        "Resume never issued the V8 hard seek — the old presentation-axis assignment wedges the element and leaves relocation to the server's implicit churn fallback",
      ).toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.objectContaining({ body: { targetMs: 120_000 } }));
      // The element must NOT be teleported to presentation 120s — the
      // landing watch owns the element position from here.
      expect(videoEl(v).currentTime).toBe(0);
      // The scrubber pins at the 202 target (relocating) and the dialog is
      // resolved.
      const slider = v.container.querySelector('[role="slider"][aria-label="Seek"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("120000");
      expect(v.container.querySelector('[role="dialog"]')).toBeNull();
    });

    it("Resume with the target LISTED maps through the source clock — not a bare presentation assignment", async () => {
      const { v, hls } = await renderHlsWithPrompt();
      view = v;
      // A post-restart window whose source origin is non-zero: source
      // [118 000, 124 000) sits at presentation [18, 24) — the 120 000
      // target maps to presentation 20 s, NOT 120 s.
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 118_000, start: 18, duration: 6, relurl: "run1/s000003.m4s" }] } }];

      await act(async () => dialogButtonByPrefix(v, "Resume from").click());

      expect(
        videoEl(v).currentTime,
        "Resume assigned the SOURCE position on the PRESENTATION axis — on a non-zero-origin window that is the wrong place entirely",
      ).toBe(20);
      expect(apiPost).not.toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.anything());
      // Explicit user intent flushes progress at the chosen SOURCE position
      // (gap-F6 semantics, same as every other seek commit).
      expect(apiPut).toHaveBeenCalledWith(
        "/progress/{itemId}",
        expect.objectContaining({ body: expect.objectContaining({ positionMs: 120_000 }) }),
      );
    });

    it("Resume before the first playlist parse hard-seeks instead of assigning presentation time", async () => {
      const { v, hls } = await renderHlsWithPrompt();
      view = v;
      hls.levels = []; // nothing parsed yet — listedFragments() is null
      apiPost.mockResolvedValueOnce({ targetMs: 120_000 });

      await act(async () => dialogButtonByPrefix(v, "Resume from").click());

      expect(
        apiPost,
        "a pre-parse Resume on an hls.js transcode session fell into the no-source-clock bare assignment — it must go through the first-class seek",
      ).toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.objectContaining({ body: { targetMs: 120_000 } }));
      expect(videoEl(v).currentTime).toBe(0);
    });

    it("Start over on a window that no longer lists source 0 seeks the source axis to 0 (fresh run via POST /seek)", async () => {
      const { v, hls } = await renderHlsWithPrompt();
      view = v;
      // A reused/pruned-head window far from the start — presentation 0 is
      // NOT source 0 here, so "start over" needs a fresh run at source 0.
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run2/s000600.m4s" }] } }];
      apiPost.mockResolvedValueOnce({ targetMs: 0 });

      await act(async () => dialogButtonByPrefix(v, "Start over").click());

      expect(
        apiPost,
        "Start over just dismissed the dialog — on a non-zero-origin window playback proceeds from the WRONG source position instead of the beginning",
      ).toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.objectContaining({ body: { targetMs: 0 } }));
      expect(videoEl(v).paused).toBe(false);
      expect(v.container.querySelector('[role="dialog"]')).toBeNull();
    });

    it("Start over with source 0 LISTED stays a local soft seek — no transcoder restart burned", async () => {
      const { v, hls } = await renderHlsWithPrompt();
      view = v;
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" }] } }];

      await act(async () => dialogButtonByPrefix(v, "Start over").click());

      expect(apiPost).not.toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.anything());
      expect(videoEl(v).currentTime).toBe(0);
      expect(videoEl(v).paused).toBe(false);
    });
  });

  // ── d3-a3: native-HLS (MSE-less) source-axis routing ─────────────────────
  // verify/browser-player-F9: the F9 queued-start routing lived ONLY in the
  // hls.js attach effect — the direct-play/native-HLS attach still assigned
  // `video.currentTime = pendingSeekMsRef / 1000` on the PRESENTATION axis
  // for a queued deep-link/chapter start. On a native transcode session
  // (iOS Safari) the target is SOURCE ms; the served window covers only what
  // the worker has produced, so ?t=600 clamped and playback started at ~0
  // with no POST /seek. The queued start must route through the same
  // V8-classified seek() the scrubber uses (soft via the getStartDate PDT
  // anchor when seekable covers it; the first-class hard seek when not;
  // bare presentation only when no PDT exists — pre-V8, ruled).
  // A/browser-player-F6 (native half): the coarse displayed clock consulted
  // the anchor only inside seek() — every timeupdate rode the raw
  // presentation axis after any restart. The resolver now consults the LIVE
  // anchor per tick (lib/source-clock.ts "native-anchor" axis).
  describe("native-HLS source-axis routing (d3-a3)", () => {
    async function renderNativeReady(startMs?: number): Promise<{ v: TestRender; video: HTMLVideoElement }> {
      // Claim native HLS support with jsdom's absent MediaSource so
      // `decideAttachStrategy` resolves 'native-hls' (the same lever as the
      // native-HLS recovery test above; afterEach restores it).
      Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", { configurable: true, value: () => "maybe" });
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady(vi.fn(), undefined, startMs);
      const video = videoEl(v);
      expect(video.src, "the native attach never assigned the manifest URL").toContain(SESSION_ID);
      return { v, video };
    }

    /** Safari's native surface: §9.1.5 rule 7's PDT via getStartDate() and
     *  the element's own seekable ranges. jsdom has neither. */
    function stubNativeSurface(
      video: HTMLVideoElement,
      anchorMs: number | null,
      seekable: [number, number][],
    ): void {
      Object.defineProperty(video, "getStartDate", {
        configurable: true,
        value: () => (anchorMs === null ? new Date(NaN) : new Date(anchorMs)),
      });
      Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => ({
          length: seekable.length,
          start: (i: number) => (seekable[i] as [number, number])[0],
          end: (i: number) => (seekable[i] as [number, number])[1],
        }),
      });
    }

    it("a queued ?t= start OUTSIDE the native window issues the V8 hard seek — never a presentation-axis clamp", async () => {
      apiPost.mockResolvedValue({ targetMs: 600_000 });
      const { v, video } = await renderNativeReady(600_000);
      view = v;
      // run0 produced [0, 12) so far; PDT anchor 0 (fresh session).
      stubNativeSurface(video, 0, [[0, 12]]);
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });

      expect(
        apiPost,
        "?t= on a native transcode session must become a V8 hard seek — the presentation-axis assignment clamps and playback starts at ~0 (verify/browser-player-F9)",
      ).toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.objectContaining({ body: { targetMs: 600_000 } }));
      // The element was NOT dragged to presentation 600 s — the coarse
      // landing (§9.1.10 item 5, ruled) owns the element from the 202 on.
      expect(video.currentTime, "the routed-hard start must suppress the presentation-axis assignment").toBe(0);
      // The display pins at the deep-link target while the worker restarts.
      const slider = v.container.querySelector('[role="slider"][aria-label="Seek"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("600000");
    });

    it("a queued ?t= start INSIDE the native window maps through the PDT anchor onto the presentation axis — no restart burned", async () => {
      const { v, video } = await renderNativeReady(480_000);
      view = v;
      // A relocated window: source 480_000 sits at presentation 6 s
      // (anchor 474_000) — the bare assignment would seek presentation
      // 480 s, entirely the wrong place.
      stubNativeSurface(video, 474_000, [[0, 60]]);
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });

      expect(apiPost).not.toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.anything());
      expect(
        video.currentTime,
        "the queued start assigned SOURCE ms on the PRESENTATION axis — on a non-zero-anchor window that is the wrong place entirely",
      ).toBe(6);
    });

    it("a queued start with NO PDT anchor keeps the presentation axis (pre-V8 server, ruled: the axes coincide)", async () => {
      const { v, video } = await renderNativeReady(30_000);
      view = v;
      stubNativeSurface(video, null, [[0, 600]]);
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });

      expect(apiPost).not.toHaveBeenCalledWith("/playback/sessions/{id}/seek", expect.anything());
      expect(video.currentTime).toBe(30);
    });

    it("the coarse displayed clock consults the native PDT anchor on every timeupdate — never the raw presentation axis after a restart (browser-player-F6)", async () => {
      const { v, video } = await renderNativeReady();
      view = v;
      // A post-restart playlist: presentation 0 is source 120_000.
      stubNativeSurface(video, 120_000, [[0, 60]]);
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });
      await act(async () => {
        mediaState(video).readyState = 4;
        video.currentTime = 12;
        video.dispatchEvent(new Event("timeupdate"));
      });

      const slider = v.container.querySelector('[role="slider"][aria-label="Seek"]');
      expect(
        slider?.getAttribute("aria-valuenow"),
        "the native coarse clock rode the raw presentation axis — onTimeUpdate never consulted getStartDate()",
      ).toBe("132000");
    });
  });

  // ── gap-F6 round 3: landings the run-discovery match can never see ──────
  // Two hard-seek outcomes leave findLandingFragment with nothing to match,
  // and both pinned the scrubber at the dead target until the 20 s timeout:
  //  1. ABSORBED 202 (NEW_FINDINGS A13, live v8-requal): the target is
  //     inside the CURRENT run (e.g. just ahead of the produced edge, or
  //     Start-over to 0 while run0 still covers it) — the server absorbs,
  //     NO new run ever appears, and the only honest landing is the moment
  //     the current window LISTS the target: seek the element there.
  //  2. RELOCATED PAST THE TARGET (the verify-refutation's Start-over on
  //     the fast-completing short): the seek-spawned run raced to ENDLIST
  //     and retention pruned its head PAST the target before any refresh
  //     listed it — the run's earliest SURVIVING fragment is the closest
  //     position that still exists; land there (same honesty as the
  //     tail-only fresh mount) instead of freezing for 20 s.
  describe("absorbed / relocated hard-seek landings (gap-F6 round 3)", () => {
    async function renderHlsReadyLocal(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      hls.currentLevel = 0;
      return { v, hls };
    }

    it("an ABSORBED 202 (no new run) lands the moment the current window lists the target — element seeks, no 20s pin", async () => {
      const { v, hls } = await renderHlsReadyLocal();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      // The window covers source 100.0–106.0s; the viewer sits at 100.5s.
      const details = {
        live: true,
        fragments: [{ programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" }],
      };
      hls.levels = [{ details }];
      // First refresh consumes the one-shot queued-start router
      // (browser-player-F9), as on a real session.
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      // Forward 10s -> target 110_500: NOT listed (just ahead of the
      // produced edge) -> HARD. The server absorbs it into run0 (202, no
      // restart) and simply produces on toward it.
      apiPost.mockResolvedValueOnce({ targetMs: 110_500 });
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);

      // Next refresh: run0 itself now lists the target — no run1 ever will.
      details.fragments = [
        { programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" },
        { programDateTime: 106_000, start: 6, duration: 6.006, relurl: "run0/s000017.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(
        video.currentTime,
        "the absorbed 202 never landed — the watch keeps waiting for a run that will never exist",
      ).toBeCloseTo(10.5, 3);

      // Resume evidence completes the lifecycle: no timeout toast, display live.
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(
        document.body.textContent,
        "an absorbed in-window 202 rode the pin into the 20 s timeout toast",
      ).not.toContain("Seek timed out");
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("110500");
    });

    // rem2-absorbed-seek (V8 requal NEW finding): the round-3 absorbed
    // acceptance above lives ONLY in the LEVEL_UPDATED handler, so it
    // needs one more playlist refresh AFTER the 202 arms the watch. When
    // the window already lists the clamped target at 202-ARRIVAL time —
    // the refresh listing it raced the POST round trip, or the pre-parse
    // Start-over's first parse beat the 202 — and no later refresh comes
    // (young windows can go refresh-quiet: ENDLIST, or hls.js's own
    // cadence), the watch stays armed for a run that will never spawn and
    // the scrubber rides the pin into the 20 s timeout toast (live: ~20.1 s
    // pinned at 0:00 after Start-over). The absorbed landing must happen at
    // the 202 itself: element seek to the mapped presentation time, resume
    // evidence completes the lifecycle exactly like the acceptance above.
    it("an ABSORBED 202 whose target is ALREADY listed at response time lands via the element at the 202 — no later refresh required, no 20 s pin", async () => {
      const { v, hls } = await renderHlsReadyLocal();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      // The window covers source 100.0–106.0s; the viewer sits at 100.5s.
      const details = {
        live: true,
        fragments: [{ programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" }],
      };
      hls.levels = [{ details }];
      // First refresh consumes the one-shot queued-start router
      // (browser-player-F9), as on a real session.
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      // Forward 10s -> target 110_500: NOT listed at seek time -> HARD.
      // Hold the 202 in flight.
      let resolve202: ((r: { targetMs: number }) => void) | null = null;
      apiPost.mockImplementationOnce(() => new Promise((r) => { resolve202 = r; }));
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);

      // While the POST is in flight, run0 produces past the target and a
      // refresh lists it — BEFORE the 202 arrives, so no watch is armed
      // yet and the LEVEL_UPDATED absorbed acceptance sees nothing. The
      // server absorbs the seek into run0 (202, no restart) and this is
      // the LAST refresh the window ever gets.
      details.fragments = [
        { programDateTime: 100_000, start: 0, duration: 6, relurl: "run0/s000016.m4s" },
        { programDateTime: 106_000, start: 6, duration: 6.006, relurl: "run0/s000017.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        resolve202?.({ targetMs: 110_500 });
      });
      expect(
        video.currentTime,
        "the absorbed 202 never landed — its target was already listed when the 202 arrived, and with no later refresh the watch waits for a run that will never exist",
      ).toBeCloseTo(10.5, 3);

      // Resume evidence completes the lifecycle: no timeout toast, display live.
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(
        document.body.textContent,
        "an absorbed 202 with the target listed at response time rode the pin into the 20 s timeout toast",
      ).not.toContain("Seek timed out");
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("110500");
    });

    it("a seek-spawned run that already pruned PAST the target lands at its earliest surviving fragment — not a 20s freeze", async () => {
      const { v, hls } = await renderHlsReadyLocal();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      const details = {
        live: true,
        fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000096.m4s" }],
      };
      hls.levels = [{ details }];
      // First refresh consumes the one-shot queued-start router
      // (browser-player-F9) exactly as a real session's first playlist
      // refresh does — the landing emit below must not be the first.
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      // Hard seek to 10s (Start-over-adjacent shape on the fast short).
      apiPost.mockResolvedValueOnce({ targetMs: 10_000 });
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);

      // The refresh that finally shows run1: it re-encoded from ~0, raced
      // to ENDLIST and pruned its head — the earliest survivor starts at
      // source 460.0s. The target (10s) is gone forever.
      details.fragments = [
        { programDateTime: 460_000, start: 6, duration: 6, relurl: "run1/s000112.m4s" },
        { programDateTime: 466_000, start: 12, duration: 6, relurl: "run1/s000113.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(
        video.currentTime,
        "the relocated-past-target run never landed — the watch holds out for pruned content and freezes into the timeout",
      ).toBe(6);

      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(document.body.textContent).not.toContain("Seek timed out");
      const slider = v.container.querySelector('[role="slider"]');
      expect(slider?.getAttribute("aria-valuenow")).toBe("460000");
    });

    it("a source-clock HLS session never adopts the element's inflated presentation extent as its duration", async () => {
      // The churned-playlist symptom (verify refutation): re-encoded tail
      // runs push the playlist's cumulative EXTINF extent PAST the real
      // file duration (9:34 -> 18:18) and growth-only adoption took it.
      // Once the session displays the SOURCE axis, the element's
      // presentation extent is the wrong axis for the scrubber ceiling by
      // construction — the probed session duration governs.
      const { v, hls } = await renderHlsReadyLocal();
      view = v;
      const video = videoEl(v);
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" }] } }];
      // One mapped timeupdate: the session has SHOWN a source clock.
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      Object.defineProperty(video, "duration", { get: () => 1_098.081, configurable: true });
      await act(async () => {
        video.dispatchEvent(new Event("durationchange"));
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(
        slider?.getAttribute("aria-valuemax"),
        "the churned playlist's presentation extent replaced the probed source duration",
      ).toBe("600000");
    });
  });

  // ── d3-a1: seek landing / supersession family ───────────────────────────
  // Four residuals of the V8 landing lifecycle observed in the 2026-08-23/24
  // requalification + verify passes: (1) the pre-first-frame absorbed 202
  // (v8-requal Start-over: 20.1 s pinned at 0:00), (2) a completed previous
  // landing cancelling an in-flight newer seek (gap-F5-adjacent, "newest
  // wins" owner ruling), (3) the landing refresh arriving on a rung the
  // player is not current on (verify-A ABR flap: FALSE 'Seek timed out'),
  // and (4) rung churn needing a bounded landing-window extension.
  describe("seek landing/supersession (d3-a1)", () => {
    async function renderHlsSeekReady(): Promise<{ v: TestRender; hls: MockHlsInstance }> {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: hlsTranscodeSession() });
      const v = await renderReady();
      await act(async () => {});
      const hls = hlsInstances[hlsInstances.length - 1];
      if (!hls) throw new Error("the hlsjs attach effect never constructed an hls.js instance");
      return { v, hls };
    }

    it("an ABSORBED 202 before any frame has played (currentLevel -1, only the start rung's playlist loaded) lands via the element — no 20 s pin", async () => {
      const { v, hls } = await renderHlsSeekReady();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      // resolveStartLevel starts hls.js loading the server's encoding rung
      // — the TOP rung, never index 0 on a multi-rung ladder — so before
      // the first frame plays, currentLevel is -1 and ONLY the loading
      // level has details. The v8-requal Start-over pin (20.1 s at 0:00)
      // is exactly this shape: the window was parsed and listed the
      // target, but the player read the never-loaded level 0.
      hls.currentLevel = -1;
      hls.loadLevel = 1;
      const details = { live: true, fragments: [{ programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" }] };
      hls.levels = [{}, { details }];
      // First refresh consumes the one-shot queued-start router (F9).
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      // Forward 10s -> a target ahead of the produced edge: HARD. Hold the
      // 202 in flight while run0 produces past the target (absorbed — no
      // new run will ever spawn, and no later refresh is guaranteed).
      let resolve202: ((r: { targetMs: number }) => void) | null = null;
      apiPost.mockImplementationOnce(() => new Promise((r) => { resolve202 = r; }));
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);
      details.fragments = [
        { programDateTime: 0, start: 0, duration: 6, relurl: "run0/s000000.m4s" },
        { programDateTime: 6_000, start: 6, duration: 6.006, relurl: "run0/s000001.m4s" },
      ];
      await act(async () => {
        resolve202?.({ targetMs: 10_500 });
      });
      expect(
        video.currentTime,
        "the pre-first-frame absorbed 202 never landed — listedFragments() read the never-loaded level 0 and the pin rides into the 20 s timeout (v8-requal: ~20.1 s pinned at 0:00 after Start over)",
      ).toBeCloseTo(10.5, 3);
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(document.body.textContent).not.toContain("Seek timed out");
    });

    it("completing a PREVIOUS landing's resume evidence never cancels an in-flight NEWER seek — newest wins (gap-F5-adjacent)", async () => {
      const { v, hls } = await renderHlsSeekReady();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      hls.currentLevel = 0;
      const details = { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" }] };
      hls.levels = [{ details }];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      // Seek #1 lands (discovery) but its resume evidence is still pending.
      apiPost.mockResolvedValueOnce({ targetMs: 3_610_500 });
      await act(async () => button(v, "Forward 10 seconds").click());
      details.fragments = [
        { programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" },
        { programDateTime: 3_610_500, start: 6, duration: 6, relurl: "run1/s000601.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(video.currentTime, "seek #1's discovery landing never seeked the element").toBe(6);
      // SPF-5: past the coalescing window, so seek #2 below dispatches
      // immediately as its own independent POST instead of coalescing.
      await act(async () => {
        vi.advanceTimersByTime(HARD_SEEK_COALESCE_MS);
      });
      // Seek #2 goes out while #1 awaits resume evidence — hold its 202.
      let resolve202: ((r: { targetMs: number }) => void) | null = null;
      apiPost.mockImplementationOnce(() => new Promise((r) => { resolve202 = r; }));
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(2);
      // #1's landed position becomes displayable WHILE #2's 202 is in flight.
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      // #2's 202 arrives — it must still arm: the pin sits at ITS target.
      await act(async () => {
        resolve202?.({ targetMs: 3_620_500 });
      });
      const slider = v.container.querySelector('[role="slider"]');
      expect(
        slider?.getAttribute("aria-valuenow"),
        "the NEWEST seek's 202 was silently dropped — completing the previous landing bumped the supersession epoch and cancelled it",
      ).toBe("3620500");
      // And #2 then lands and completes like any hard seek.
      details.fragments = [
        ...details.fragments,
        { programDateTime: 3_620_500, start: 12, duration: 6, relurl: "run2/s000602.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(video.currentTime).toBe(12);
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(document.body.textContent).not.toContain("Seek timed out");
    });

    it("a landing that appears on a rung the player is NOT current on still lands — the LEVEL_UPDATED event's own details drive the watch (verify-A ABR flap)", async () => {
      const { v, hls } = await renderHlsSeekReady();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      hls.currentLevel = 0;
      const staleDetails = { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" }] };
      hls.levels = [{ details: staleDetails }, {}];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      apiPost.mockResolvedValueOnce({ targetMs: 3_610_500 });
      await act(async () => button(v, "Forward 10 seconds").click());
      expect(apiPost).toHaveBeenCalledTimes(1);
      // ABR flapped mid-landing: the refresh that lists the seek-spawned
      // run1 belongs to ANOTHER level; the current level's own details are
      // stale and will not refresh again (its loader was abandoned by the
      // switch). Live shape: FALSE 'Seek timed out' at +20 s, landing ~40 s
      // late, 9x 503s on the abandoned old-run segment in between.
      const freshDetails = {
        live: true,
        fragments: [
          { programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" },
          { programDateTime: 3_610_500, start: 8, duration: 6, relurl: "run1/s000601.m4s" },
        ],
      };
      hls.levels = [{ details: staleDetails }, { details: freshDetails }];
      await act(async () => {
        hls.emit("hlsLevelUpdated", "hlsLevelUpdated", { details: freshDetails, level: 1 });
      });
      expect(
        video.currentTime,
        "the landing refresh arrived on a non-current rung and was ignored — the watch misses the 20 s window and toasts a FALSE 'Seek timed out' (verify-A)",
      ).toBe(8);
      // The switch becomes effective; the landed position is displayable.
      hls.currentLevel = 1;
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(document.body.textContent).not.toContain("Seek timed out");
    });

    it("a rung switch mid-landing EXTENDS the landing window instead of failing while the session still progresses", async () => {
      const { v, hls } = await renderHlsSeekReady();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      hls.currentLevel = 0;
      const details = { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" }] };
      hls.levels = [{ details }];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      apiPost.mockResolvedValueOnce({ targetMs: 3_610_500 });
      await act(async () => button(v, "Forward 10 seconds").click());
      // 15 s in, ABR switches rungs — the pipeline is demonstrably still
      // working toward the target (lane F defers rung restarts post-seek;
      // the client half must not fail the landing for the handoff).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await act(async () => {
        hls.emit("hlsLevelSwitching", "hlsLevelSwitching", { level: 1 });
      });
      // 25 s total: the un-extended timer would have toasted at 20 s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        document.body.textContent,
        "a rung switch mid-landing did not extend the landing window — FALSE 'Seek timed out' while the seek was still in progress (verify-A)",
      ).not.toContain("Seek timed out");
      // The landing then completes normally.
      details.fragments = [
        ...details.fragments,
        { programDateTime: 3_610_500, start: 6, duration: 6, relurl: "run1/s000601.m4s" },
      ];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      expect(video.currentTime).toBe(6);
      mediaState(video).readyState = 4;
      await act(async () => {
        video.dispatchEvent(new Event("seeked"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HARD_SEEK_LANDING_TIMEOUT_MS + 500);
      });
      expect(document.body.textContent).not.toContain("Seek timed out");
    });

    it("landing extensions are BOUNDED: rung churn cannot stretch the lifecycle past its hard cap — the toast still comes", async () => {
      const { v, hls } = await renderHlsSeekReady();
      view = v;
      vi.useFakeTimers();
      const video = videoEl(v);
      hls.currentLevel = 0;
      hls.levels = [{ details: { live: true, fragments: [{ programDateTime: 3_600_000, start: 0, duration: 6, relurl: "run0/s000600.m4s" }] } }];
      await act(async () => {
        hls.emit("hlsLevelUpdated");
      });
      await act(async () => {
        video.currentTime = 0.5;
        video.dispatchEvent(new Event("timeupdate"));
      });
      apiPost.mockResolvedValueOnce({ targetMs: 3_610_500 });
      await act(async () => button(v, "Forward 10 seconds").click());
      // A rung switch every 10 s, landing never arriving: the lifecycle
      // must still be bounded — never an indefinite pin (§9.1.9).
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await act(async () => {
          hls.emit("hlsLevelSwitching", "hlsLevelSwitching", { level: i % 2 });
        });
      }
      expect(
        document.body.textContent,
        "rung churn stretched the landing lifecycle indefinitely — the bounded-timeout invariant (§9.1.9) is broken",
      ).toContain("Seek timed out");
    });
  });

  // ── Subtitles: picking a text track re-creates the session pinned to it ──
  // (docs/PLAYBACK.md §2.6 pin → Stage E 'hls-vtt' → the subtitle-extract
  // worker → GET /playback/sessions/{id}/subtitles/sub0.vtt). Off is a
  // client-side hide; re-picking the already-extracted stream just shows
  // it again — neither mints a session.
  describe("subtitle selection", () => {
    // The side-track is fetched with a CORS request and handed to <track>
    // as a same-origin blob URL (lib/subtitle-track-fetch.ts) — a bare
    // cross-origin <track src> is refused by browsers ("Unsafe attempt to
    // load URL … Domains, protocols and ports must match"), which the
    // 2026-09-03 live check hit against the real :3000/:3001 split.
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset().mockResolvedValue(new Response("WEBVTT\n", { status: 200, headers: { "content-type": "text/vtt" } }));
      vi.stubGlobal("fetch", fetchMock);
      if (!("createObjectURL" in URL)) {
        Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:test/vtt" });
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
      }
    });

    function subtitleStream(index: number): PlaybackSession["media"] extends infer M ? (M extends { subtitle: (infer S)[] } ? S : never) : never {
      return { index, codec: "subrip", language: "eng", isForced: false, isDefault: false, isExternal: false, externalPath: null };
    }
    function withSubtitle(id: string, extracted: boolean): PlaybackSession {
      const base = directPlaySession();
      if (!base.media) throw new Error("fixture has no media");
      return {
        ...base,
        id,
        plan: { ...base.plan, subtitle: extracted ? { strategy: "hls-vtt", streamIndex: 3 } : { strategy: "none" } },
        media: { ...base.media, subtitle: [subtitleStream(3)] },
      };
    }
    function optionButton(v: TestRender, text: string): HTMLButtonElement {
      const el = Array.from(v.container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.startsWith(text));
      if (!el) throw new Error(`no option "${text}"`);
      return el;
    }

    it("picking a text subtitle re-creates the session with the pin, keeps the position, skips the resume prompt, and attaches the VTT side-track", async () => {
      createPlaybackSession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: withSubtitle(SESSION_ID, false) })
        .mockResolvedValueOnce({ ok: true, session: withSubtitle(SECOND_SESSION_ID, true) });
      const v = (view = await renderReady());
      const video = videoEl(v);
      await act(async () => button(v, "Play").click());
      video.currentTime = 42;
      expect(v.container.querySelector("track")).toBeNull();

      await act(async () => button(v, "Audio and subtitle tracks").click());
      await act(async () => optionButton(v, "SUBRIP · eng").click());

      expect(createPlaybackSession).toHaveBeenCalledTimes(2);
      expect(createPlaybackSession).toHaveBeenLastCalledWith(ITEM_ID, "stream", undefined, { subtitleStreamIndex: 3 });
      expect(findProgressForItem).toHaveBeenCalledTimes(1); // no second resume prompt
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID); // the unpinned session is released
      expect(video.src).toContain(SECOND_SESSION_ID);

      const track = v.container.querySelector("track");
      expect(track).not.toBeNull();
      expect(track?.getAttribute("src")).toMatch(/^blob:/);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/playback/sessions/${SECOND_SESSION_ID}/subtitles/sub0.vtt`),
        expect.objectContaining({ mode: "cors" }),
      );
      expect(optionButton(v, "SUBRIP · eng").getAttribute("data-active")).toBe("true");

      // The swapped source resumes where the viewer was (the attach effect's
      // own currentTime carry-over), not at 0 and not at a resume prompt.
      await act(async () => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });
      expect(video.currentTime).toBe(42);
    });

    it("Off hides the track without a new session; re-picking the extracted stream shows it again without one either", async () => {
      createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: withSubtitle(SESSION_ID, true) });
      const v = (view = await renderReady());
      // The server auto-selected (or a prior pin produced) an extracted
      // stream: the picker reflects it and the track is attached.
      await act(async () => button(v, "Audio and subtitle tracks").click());
      expect(optionButton(v, "SUBRIP · eng").getAttribute("data-active")).toBe("true");
      expect(v.container.querySelector("track")).not.toBeNull();

      await act(async () => optionButton(v, "Off").click());
      expect(v.container.querySelector("track")).toBeNull();
      expect(optionButton(v, "Off").getAttribute("data-active")).toBe("true");

      await act(async () => optionButton(v, "SUBRIP · eng").click());
      expect(v.container.querySelector("track")).not.toBeNull();
      expect(createPlaybackSession).toHaveBeenCalledTimes(1);
    });
  });
});
