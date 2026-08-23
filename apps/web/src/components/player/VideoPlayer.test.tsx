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

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { LoombreApiError } from "@loombre/sdk";
import { HARD_SEEK_LANDING_TIMEOUT_MS } from "../../lib/source-time.js";
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
  levels: { details?: { live: boolean; fragments: unknown[] } }[];
  currentLevel: number;
  nextLevel: number;
  autoLevelEnabled: boolean;
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
  calls: string[];
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb?: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  detachMedia(): void;
  startLoad(pos?: number): void;
  stopLoad(): void;
  destroy(): void;
}
const hlsInstances: MockHlsInstance[] = [];
vi.mock("hls.js", () => {
  class MockHls implements MockHlsInstance {
    static isSupported = (): boolean => true;
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed",
      LEVEL_SWITCHED: "hlsLevelSwitched",
      LEVEL_UPDATED: "hlsLevelUpdated",
      ERROR: "hlsError",
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    levels: { details?: { live: boolean; fragments: unknown[] } }[] = [];
    currentLevel = -1;
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
    loadSource(): void {
      this.calls.push("loadSource");
    }
    attachMedia(): void {
      this.calls.push("attachMedia");
    }
    detachMedia(): void {}
    startLoad(pos?: number): void {
      this.calls.push(`startLoad(${pos})`);
    }
    stopLoad(): void {
      this.calls.push("stopLoad");
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
  define("buffered", { get: () => ({ length: 0, start: () => 0, end: () => 0 }) });
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
    createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
    endPlaybackSession.mockReset().mockResolvedValue(undefined);
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
    await act(async () => {
      video.currentTime = 42;
      video.dispatchEvent(new Event("timeupdate"));
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

    await act(async () => {
      video.currentTime = 599;
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("ended"));
    });
    expect(apiPut.mock.calls.at(-1)?.[1]).toMatchObject({ body: { state: "played", positionMs: 599_000 } });
  });

  it("flushes the latest position on an in-app unmount (Back), which fires no pagehide", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);

    await act(async () => {
      video.currentTime = 73;
      video.dispatchEvent(new Event("timeupdate"));
    });
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

    await act(async () => {
      video.currentTime = 12;
      video.dispatchEvent(new Event("timeupdate"));
    });
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
    expect(v.container.textContent).toContain("can’t play on this device right now");
    expect(v.container.textContent).toContain("Playback failed in this browser");
  });

  it("a MEDIA_ERR_DECODE error is unrecoverable — no reattach at all, straight to the fatal unavailable path", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3 /* MEDIA_ERR_DECODE */ }) });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(v.container.textContent).toContain("Playback failed in this browser");
  });

  it("a MEDIA_ERR_SRC_NOT_SUPPORTED error is unrecoverable too — same fatal path, no reattach attempted", async () => {
    const v = (view = await renderReady());
    const video = videoEl(v);
    const loadSpy = vi.spyOn(video, "load");
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */ }) });
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(v.container.textContent).toContain("Playback failed in this browser");
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
  it("a 404 from createPlaybackSession (e.g. an item with zero playable media files) surfaces UnavailableScreen — never an indefinite spinner", async () => {
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
    // The SAME fatal-unavailable path client-side DECODE/SRC_NOT_SUPPORTED
    // already reaches (clientPlaybackErrorReasons(), lib/playback-reasons.ts)
    // — no server plan reasons exist for a failure this shape either, so
    // this reuses that exact synthesized copy rather than inventing new UI.
    expect(v!.container.textContent).toContain("Playback failed in this browser");
    expect(v!.container.querySelector("video")).toBeNull();
  });

  it("an unexpected error from createPlaybackSession (not just 404) also surfaces UnavailableScreen, never a silent hang", async () => {
    createPlaybackSession.mockReset().mockRejectedValueOnce(new Error("network down"));
    let v: TestRender | null = null;
    await act(async () => {
      v = renderIntoBody(
        <ToastProvider>
          <VideoPlayer itemId={ITEM_ID} onBack={vi.fn()} />
        </ToastProvider>,
      );
    });
    view = v;
    expect(v!.container.textContent).toContain("Playback failed in this browser");
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

      let resolveFirst: ((r: { targetMs: number }) => void) | null = null;
      let resolveSecond: ((r: { targetMs: number }) => void) | null = null;
      apiPost
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

      await act(async () => button(v, "Forward 10 seconds").click());
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
        ).toContain("Seek timed out");
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
  });
});
