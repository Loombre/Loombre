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

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: vi.fn(),
  apiPut: (...args: unknown[]) => apiPut(...args),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

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

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: SERVER_URL, accessToken: "test-access-token" }),
    getAccessToken: async () => "test-access-token",
  }),
}));

// ── media-element fake ────────────────────────────────────────────────────
interface FakeMediaState {
  paused: boolean;
  currentTime: number;
  volume: number;
  muted: boolean;
  audioTracks: { id: string; enabled: boolean }[];
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
  define("load", { value: () => undefined });
  define("canPlayType", { value: () => "" });
  define("paused", { get(this: HTMLMediaElement) { return mediaState(this).paused; } });
  define("currentTime", {
    get(this: HTMLMediaElement) { return mediaState(this).currentTime; },
    set(this: HTMLMediaElement, value: number) { mediaState(this).currentTime = value; },
  });
  define("duration", { get: () => 600 });
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
    noticeMockValue = { notice: null, severity: null, serverOffsetMs: 0, dismissed: false, dismiss: vi.fn(), bannerVisible: false };
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
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

    await act(async () => button(v, "Forward 30 seconds").click());
    expect(video.currentTime).toBe(30);
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut.mock.calls[0]?.[1]).toMatchObject({
      body: { positionMs: 30_000, durationMs: 600_000, state: "in-progress", sessionId: SESSION_ID },
    });

    await act(async () => button(v, "Back 15 seconds").click());
    expect(video.currentTime).toBe(15);
    expect(apiPut).toHaveBeenCalledTimes(2);
    expect(apiPut.mock.calls[1]?.[1]).toMatchObject({ body: { positionMs: 15_000 } });
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
});
