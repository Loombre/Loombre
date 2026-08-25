// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/music/MusicPlayerProvider.test.tsx
//
// REGRESSION GUARD (77-agent review, "every per-version Play button starts
// the same DEFAULT media file"): a TRACK detail page renders the same
// Versions list movies/episodes do (app/items/[itemType]/[id]/
// DetailScreens.tsx's VersionsSection), so a picked track version arrives
// here — via /watch/{itemId}?mediaFileId=… -> playTrack() — and has to
// reach the real session request. Everything else about this provider
// (gapless handoff, queue reducer, heartbeat) already has pure unit
// coverage in lib/ (gapless.test.ts, queue.test.ts, heartbeat.test.ts);
// only the "which FILE does a queued track play" hop needs the provider
// itself rendered, because it lives in `loadIntoSlot`.
//
// jsdom implements almost none of HTMLMediaElement (`play()` returns
// undefined, `load()` is unimplemented), so the surface this provider
// touches is stubbed on the prototype — same approach as
// components/player/VideoPlayer.test.tsx.

import { act, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { ToastProvider } from "../ui/Toast.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];

const SERVER_URL = "http://localhost:9000";
const TRACK_ID = "01890000-0000-7000-8000-000000000031";
const SESSION_ID = "01890000-0000-7000-8000-0000000000ab";
/** The queue's SECOND track + its session, for the superseded-load leak
 *  test below (AUD-A3g-001). */
const TRACK_2_ID = "01890000-0000-7000-8000-000000000032";
const SESSION_2_ID = "01890000-0000-7000-8000-0000000000ac";
/** A third queued track, so a reorder/removal can shift the CURRENT index
 *  without the current row being first or last (browser-player-F11). */
const TRACK_3_ID = "01890000-0000-7000-8000-000000000033";
/** The session a DUPLICATE preload would create (d4-m2) — distinct so a
 *  test can name the one that must never exist. */
const SESSION_3_ID = "01890000-0000-7000-8000-0000000000ad";
/** A NON-default media_files row for the same track — the alternate
 *  (lossless/remaster) version a user picks out of its Versions list. */
const ALT_FILE_ID = "01890000-0000-7000-8000-0000000000d8";

const createDirectPlaySession = vi.fn();
const endPlaybackSession = vi.fn();

vi.mock("../../lib/playback-session.js", () => ({
  createDirectPlaySession: (...args: unknown[]) => createDirectPlaySession(...args),
  endPlaybackSession: (...args: unknown[]) => endPlaybackSession(...args),
}));

// Resolves (not `vi.fn()` bare): the provider's heartbeat `send` does
// `void apiPut(...).catch(...)`, and `stopHeartbeat(true)` flushes one on
// every `ended` — an undefined return would throw there. Hoisted into a
// named double (same wrapper convention as createDirectPlaySession above)
// so d4-m1 can assert on the PUT /progress BODY the heartbeat sends.
const apiPut = vi.fn(async (_path: string, _init: unknown) => undefined);

vi.mock("../../lib/api-client.js", () => ({
  apiPut: (path: string, init: unknown) => apiPut(path, init),
}));

vi.mock("../../lib/progress-report.js", () => ({
  reportProgressOnUnload: vi.fn(),
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: SERVER_URL, accessToken: "test-access-token" }),
    getAccessToken: async () => "test-access-token",
  }),
}));

// Imported AFTER the mocks (app/home/page.test.tsx's established
// convention) so the module under test picks them up.
const { MusicPlayerProvider, useMusicPlayer } = await import("./MusicPlayerProvider.js");
type PlayableTrackInput = Parameters<ReturnType<typeof useMusicPlayer>["playTrack"]>[0];

function installMediaStubs(): void {
  const proto = HTMLMediaElement.prototype;
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };
  define("play", { value: () => Promise.resolve() });
  define("pause", { value: () => undefined });
  define("load", { value: () => undefined });
  define("paused", { get: () => true });
  define("duration", { get: () => 214 });
}

installMediaStubs();

function directPlaySession(): PlaybackSession {
  return {
    id: SESSION_ID,
    itemId: TRACK_ID,
    userId: "01890000-0000-7000-8000-0000000000b1",
    deviceId: "01890000-0000-7000-8000-0000000000c1",
    plan: {
      decision: "direct-play",
      reasons: [],
      container: "source",
      video: { action: "none" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      ladder: [],
      ffmpegArgs: [],
      engineVersion: "1.0.0",
    },
    status: "created",
    errorCode: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

/** Fires exactly one playTrack() on mount — `playTrack` is useCallback-
 *  stabilized by the provider, so this effect never re-runs. */
function PlayOnMount({ track }: { track: PlayableTrackInput }): null {
  const { playTrack } = useMusicPlayer();
  useEffect(() => {
    playTrack(track);
  }, [playTrack, track]);
  return null;
}

/** Captures the live context value so a test can drive playQueue()/next()
 *  imperatively — the superseded-load test needs to race a skip against an
 *  in-flight createDirectPlaySession, which a mount-only harness can't. */
let capturedCtx: ReturnType<typeof useMusicPlayer> | null = null;
function CaptureContext(): null {
  capturedCtx = useMusicPlayer();
  return null;
}

/** The provider ALWAYS renders under a <ToastProvider> in the real app
 *  (components/providers/AppProviders.tsx mounts ToastProvider outermost,
 *  explicitly so "mini-player actions" can toast) and calls useToast(), so
 *  every render here supplies one — same convention as
 *  settings/sections/UsersSection.test.tsx. */
function renderPlayer(children: ReactNode): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <MusicPlayerProvider>{children}</MusicPlayerProvider>
    </ToastProvider>,
  );
}

/** Text of the toast viewport's aria-live region (components/ui/Toast.tsx —
 *  permanently mounted, empty string when nothing is showing). */
function toastText(container: HTMLElement): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

/** The contract's ProgressUpdate (packages/contract/openapi.yaml): integer
 *  positionMs, integer-or-null durationMs. */
interface ProgressBody {
  positionMs: number;
  durationMs: number | null;
  state: string;
  sessionId?: string;
}

/** Body of the most recent PUT /progress/{itemId} the heartbeat sent. */
function lastProgressBody(): ProgressBody {
  const call = [...apiPut.mock.calls].reverse().find(([path]) => path === "/progress/{itemId}");
  if (!call) throw new Error("no PUT /progress/{itemId} was sent");
  return (call[1] as { body: ProgressBody }).body;
}

/** Drains the promise/effect cascade a queue advance sets off: create
 *  rejects -> catch -> dispatch NEXT -> effect -> next create -> … */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => undefined);
  }
}

async function playAndSettle(track: PlayableTrackInput): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderPlayer(<PlayOnMount track={track} />);
  });
  await act(async () => undefined);
  if (!view) throw new Error("render produced nothing");
  return view;
}

/** Renders the provider, captures its context, and starts `tracks` playing. */
async function playQueueAndSettle(tracks: PlayableTrackInput[]): Promise<TestRender> {
  capturedCtx = null;
  let view: TestRender | null = null;
  await act(async () => {
    view = renderPlayer(<CaptureContext />);
  });
  await act(async () => {
    capturedCtx!.playQueue(tracks, 0);
  });
  await flush();
  if (!view) throw new Error("render produced nothing");
  return view;
}

/** A caught API error shaped exactly like the one lib/api-client.ts's
 *  LoombreApiError delivers to a catch — an Error carrying the RFC 9457
 *  problem body. Duck-typed rather than the real class (this file mocks
 *  api-client.js wholesale, and lib/api-error-message.ts reads `.problem`
 *  structurally). */
function apiError(status: number, title: string, detail?: string): Error {
  return Object.assign(new Error(title), {
    status,
    problem: { type: "about:blank", title, status, ...(detail === undefined ? {} : { detail }) },
  });
}

/** Runs `body` with an unhandledRejection listener installed, and gives node
 *  the macrotask turn it needs to emit (it only fires AFTER the microtask
 *  queue drains) before reporting what it caught. */
async function captureUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

describe("MusicPlayerProvider", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
    endPlaybackSession.mockReset().mockResolvedValue(undefined);
    apiPut.mockClear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("pins a queued track's session to the picked version's file", async () => {
    view = await playAndSettle({ itemId: TRACK_ID, title: "Heliotrope", mediaFileId: ALT_FILE_ID });
    expect(createDirectPlaySession).toHaveBeenCalledWith(TRACK_ID, "stream", ALT_FILE_ID);
  });

  it("leaves the file unpinned when no version was picked, so the server's primary file wins", async () => {
    view = await playAndSettle({ itemId: TRACK_ID, title: "Heliotrope" });
    expect(createDirectPlaySession).toHaveBeenCalledWith(TRACK_ID, "stream", undefined);
  });

  // AUD-A3g-001 regression guard: a load superseded while its
  // createDirectPlaySession was in flight returns BEFORE recording the
  // session in sessionsRef — so no slot reuse and no unmount cleanup can
  // ever reach it, and the server session stays live until the 15-minute
  // idle sweeper. This file's own header promises the opposite ("the
  // just-finished track's session is ended as soon as its slot is
  // reused"): the superseded invocation must end the session it created.
  it("ends the session created by a superseded track load instead of leaking it", async () => {
    let resolveFirst: (r: unknown) => void = () => undefined;
    createDirectPlaySession
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValueOnce({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

    capturedCtx = null;
    await act(async () => {
      view = renderPlayer(<CaptureContext />);
    });
    await act(async () => {
      capturedCtx!.playQueue(
        [
          { itemId: TRACK_ID, title: "Heliotrope" },
          { itemId: TRACK_2_ID, title: "Second Sun" },
        ],
        0,
      );
    });
    // Skip while track 1's create is still in flight — this supersedes it.
    await act(async () => {
      capturedCtx!.next();
    });
    // Track 1's create resolves late: its session must be ended, not dropped.
    await act(async () => {
      resolveFirst({ ok: true, session: directPlaySession() });
    });
    expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    // The winning (track 2) session is live, not ended.
    expect(endPlaybackSession).not.toHaveBeenCalledWith(SESSION_2_ID);
  });

  // browser-player-F10: POST /playback/sessions 404s for a track whose file
  // is gone (a seed fixture, or real media deleted under the server).
  // createPlaybackSession re-throws anything that isn't 409/422/429, and
  // loadIntoSlot awaited it with no try/catch from two fire-and-forget
  // `void loadIntoSlot(…)` call sites — so the rejection was unhandled, the
  // mini player sat dead at 0:00, and the `!result.ok` warn-and-skip path
  // below it could never run for this failure shape.
  describe("track load failure (browser-player-F10)", () => {
    const TWO_TRACKS: PlayableTrackInput[] = [
      { itemId: TRACK_ID, title: "Low Water" },
      { itemId: TRACK_2_ID, title: "Second Sun" },
    ];

    it("toasts the failure and skips to the next track when the session create throws", async () => {
      createDirectPlaySession
        .mockReset()
        .mockRejectedValueOnce(apiError(404, "Not Found", "The file for this track is missing."))
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      view = await playQueueAndSettle(TWO_TRACKS);

      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(2, TRACK_2_ID, "stream", undefined);
      expect(capturedCtx!.current?.itemId).toBe(TRACK_2_ID);

      const toast = toastText(view.container);
      expect(toast).toContain("Low Water");
      expect(toast).toContain("The file for this track is missing.");
      expect(view.container.querySelector('[data-variant="danger"]')).not.toBeNull();
    });

    it("leaves no unhandled rejection behind when the session create throws", async () => {
      createDirectPlaySession.mockReset().mockRejectedValue(apiError(404, "Not Found"));

      const unhandled = await captureUnhandledRejections(async () => {
        view = await playQueueAndSettle(TWO_TRACKS);
      });

      expect(unhandled).toHaveLength(0);
    });

    it("stops once the queue is exhausted instead of skipping forever", async () => {
      createDirectPlaySession.mockReset().mockRejectedValue(apiError(500, "Internal Server Error"));

      view = await playQueueAndSettle(TWO_TRACKS);

      // Exactly one attempt per queued track — the skip is bounded by the
      // queue, and parking at currentIndex: null ends it.
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      expect(capturedCtx!.current).toBeNull();
      expect(capturedCtx!.isPlaying).toBe(false);

      const toast = toastText(view.container);
      expect(toast).toContain("Second Sun");
      expect(toast).toMatch(/nothing else in the queue/i);
    });

    it("keeps a failed PRELOAD silent: no toast, no skip, the current track plays on", async () => {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockRejectedValue(apiError(404, "Not Found"));

      const unhandled = await captureUnhandledRejections(async () => {
        view = await playQueueAndSettle([{ ...TWO_TRACKS[0]!, durationMs: 200_000 }, TWO_TRACKS[1]!]);

        // Cross the near-end threshold on the ACTIVE element (slot A) so the
        // gapless machine asks for a preload of track 2 into slot B.
        const active = view.container.querySelectorAll("audio")[0]!;
        Object.defineProperty(active, "currentTime", { configurable: true, get: () => 199 });
        await act(async () => {
          active.dispatchEvent(new Event("timeupdate"));
        });
        await flush();
      });

      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      expect(unhandled).toHaveLength(0);
      // Nothing user-visible has failed yet — track 1 is still playing, and
      // the failure will be surfaced (once) if track 2 ever becomes current.
      expect(toastText(view!.container)).toBe("");
      expect(capturedCtx!.current?.itemId).toBe(TRACK_ID);
    });
  });

  // d3-m2 (browser-player-F10 follow-up): F10 fixed only the session-CREATE
  // half. A track whose session creates FINE but whose media then fails —
  // segment 404, decode error, a token that expired on the session file URL
  // — hit no listener at all: the provider wired timeupdate/loadedmetadata/
  // ended/play/pause on each <audio> and never 'error', so the mini player
  // parked at 0:00 in silence with nothing to skip it along.
  describe("media element failure (d3-m2)", () => {
    const TWO_TRACKS: PlayableTrackInput[] = [
      { itemId: TRACK_ID, title: "Low Water" },
      { itemId: TRACK_2_ID, title: "Second Sun" },
    ];

    /** MediaError on a real element is read-only and jsdom never populates
     *  it (it has no decoder), so the failing element declares its own. */
    function setMediaError(el: HTMLMediaElement, code: number): void {
      Object.defineProperty(el, "error", { configurable: true, get: () => ({ code }) });
    }

    it("toasts and skips when the ACTIVE element errors after a healthy session create", async () => {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      view = await playQueueAndSettle(TWO_TRACKS);
      expect(capturedCtx!.current?.itemId).toBe(TRACK_ID);

      const active = view.container.querySelectorAll("audio")[0]!;
      setMediaError(active, 3); // MEDIA_ERR_DECODE
      await act(async () => {
        active.dispatchEvent(new Event("error"));
      });
      await flush();

      const toast = toastText(view.container);
      expect(toast).toContain("Low Water");
      expect(toast).toMatch(/decode/i);
      expect(view.container.querySelector('[data-variant="danger"]')).not.toBeNull();
      // Skipped, and the dead track's session did not leak.
      expect(capturedCtx!.current?.itemId).toBe(TRACK_2_ID);
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it("names the failure shape: a src the server would not deliver reads differently from a decode error", async () => {
      createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
      view = await playQueueAndSettle([TWO_TRACKS[0]!]);

      const active = view.container.querySelectorAll("audio")[0]!;
      setMediaError(active, 4); // MEDIA_ERR_SRC_NOT_SUPPORTED — 404/expired token/unsupported
      await act(async () => {
        active.dispatchEvent(new Event("error"));
      });
      await flush();

      const toast = toastText(view.container);
      expect(toast).toContain("Low Water");
      expect(toast).not.toMatch(/decode/i);
      // Last track in the queue: the tail says so instead of promising a skip.
      expect(toast).toMatch(/nothing else in the queue/i);
      expect(capturedCtx!.current).toBeNull();
    });

    it("ignores MEDIA_ERR_ABORTED — an aborted fetch is the app's own doing, not a broken track", async () => {
      createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
      view = await playQueueAndSettle(TWO_TRACKS);

      const active = view.container.querySelectorAll("audio")[0]!;
      setMediaError(active, 1); // MEDIA_ERR_ABORTED
      await act(async () => {
        active.dispatchEvent(new Event("error"));
      });
      await flush();

      expect(toastText(view.container)).toBe("");
      expect(capturedCtx!.current?.itemId).toBe(TRACK_ID);
    });

    it("keeps a PRELOAD slot's error silent, but un-primes it so `ended` falls back to a fresh load", async () => {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      view = await playQueueAndSettle([{ ...TWO_TRACKS[0]!, durationMs: 200_000 }, TWO_TRACKS[1]!]);

      // Cross the near-end threshold so track 2 is primed into slot B.
      const active = view.container.querySelectorAll("audio")[0]!;
      Object.defineProperty(active, "currentTime", { configurable: true, get: () => 199 });
      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      await flush();
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);

      const preloading = view.container.querySelectorAll("audio")[1]!;
      setMediaError(preloading, 2); // MEDIA_ERR_NETWORK
      await act(async () => {
        preloading.dispatchEvent(new Event("error"));
      });
      await flush();

      // Nothing user-visible has failed yet — track 1 is still playing.
      expect(toastText(view.container)).toBe("");
      expect(capturedCtx!.current?.itemId).toBe(TRACK_ID);
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_2_ID);

      // The dead slot must not still look primed, or `ended` flips to it and
      // plays silence. It has to fall back to a fresh load instead.
      await act(async () => {
        active.dispatchEvent(new Event("ended"));
      });
      await flush();

      expect(capturedCtx!.current?.itemId).toBe(TRACK_2_ID);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(3);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(3, TRACK_2_ID, "stream", undefined);
    });
  });

  // d3-m3 (browser-player-F11 follow-up): ONE `loadTokenRef` guarded BOTH
  // slots, so any newer load superseded every older one regardless of which
  // element it was for. A preload into the idle slot therefore cancelled an
  // in-flight ACTIVE load: the active invocation returned early (ending its
  // own session, never setting `src`, never dispatching LOAD_ACTIVE) and the
  // track the user asked for silently never played.
  //
  // Reachable: skip to a new track near the end of the current one, and the
  // still-playing element keeps firing `timeupdate` past the near-end
  // threshold while the new track's session create is in flight.
  describe("per-slot load tokens (d3-m3)", () => {
    // React 19's `act` warns ("environment is not configured to support
    // act") when the slot-A load settles into a play() that resolves across
    // act scopes. Scoped to this describe, exactly like VideoPlayer.test
    // .tsx's StrictMode describe, so the rest of the file keeps its
    // pre-existing warning behavior.
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it("does not let a preload into the other slot supersede an in-flight load into the active slot", async () => {
      let resolveActive: (r: unknown) => void = () => undefined;
      createDirectPlaySession
        .mockReset()
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolveActive = res;
            }),
        )
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      capturedCtx = null;
      await act(async () => {
        view = renderPlayer(<CaptureContext />);
      });
      await act(async () => {
        capturedCtx!.playQueue(
          [
            { itemId: TRACK_ID, title: "Low Water" },
            { itemId: TRACK_2_ID, title: "Second Sun" },
          ],
          0,
        );
      });
      await flush();
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);

      // The still-mounted element crosses the near-end threshold (its
      // stubbed duration is 214s) while slot A's load is still in flight,
      // so the provider fires a PRELOAD into slot B.
      const active = view!.container.querySelectorAll("audio")[0]!;
      Object.defineProperty(active, "currentTime", { configurable: true, get: () => 213 });
      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      await flush();
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(2, TRACK_2_ID, "stream", undefined);

      // Slot A's create finally lands. It owns slot A and nothing has
      // superseded it THERE, so it must finish the load — not end its own
      // session and walk away.
      await act(async () => {
        resolveActive({ ok: true, session: directPlaySession() });
      });
      await flush();

      expect(endPlaybackSession).not.toHaveBeenCalledWith(SESSION_ID);
      expect(active.src).toContain(SESSION_ID);
      // LOAD_ACTIVE + autoplay actually ran, i.e. the load finished rather
      // than bailing out at the supersession check.
      expect(capturedCtx!.isPlaying).toBe(true);
    });

    it("still supersedes an older load into the SAME slot", async () => {
      let resolveFirst: (r: unknown) => void = () => undefined;
      createDirectPlaySession
        .mockReset()
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolveFirst = res;
            }),
        )
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      capturedCtx = null;
      await act(async () => {
        view = renderPlayer(<CaptureContext />);
      });
      await act(async () => {
        capturedCtx!.playQueue(
          [
            { itemId: TRACK_ID, title: "Low Water" },
            { itemId: TRACK_2_ID, title: "Second Sun" },
          ],
          0,
        );
      });
      // Skip while track 1's create is in flight: track 2 loads into the
      // SAME (still active) slot, so track 1's invocation IS superseded.
      await act(async () => {
        capturedCtx!.next();
      });
      await flush();
      await act(async () => {
        resolveFirst({ ok: true, session: directPlaySession() });
      });
      await flush();

      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
      expect(endPlaybackSession).not.toHaveBeenCalledWith(SESSION_2_ID);
    });
  });

  // d3-m4 (browser-player-F11 adjacent): the "current track changed" effect
  // only ever asked whether the ACTIVE slot already holds the new entry —
  // never "does ANY slot hold it". So removing the CURRENT row while the
  // next track was already preloaded into the other slot threw that primed
  // session away and created a second one for the same track in the active
  // slot: a wasted POST /playback/sessions, a leaked primed session, and a
  // lost gapless handoff.
  describe("removing the current row with the next track already primed (d3-m4)", () => {
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    /** Plays track 1 and primes track 2 into the other slot, the way the
     *  real near-end threshold does. */
    async function playAndPrimeNext(): Promise<TestRender> {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      const rendered = await playQueueAndSettle([
        { itemId: TRACK_ID, title: "Low Water", durationMs: 200_000 },
        { itemId: TRACK_2_ID, title: "Second Sun" },
      ]);

      const active = rendered.container.querySelectorAll("audio")[0]!;
      Object.defineProperty(active, "currentTime", { configurable: true, get: () => 199 });
      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      await flush();
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      return rendered;
    }

    it("promotes the primed slot instead of creating a second session for the same track", async () => {
      view = await playAndPrimeNext();

      await act(async () => {
        capturedCtx!.removeFromQueue(capturedCtx!.current!.entryId);
      });
      await flush();

      expect(capturedCtx!.current?.itemId).toBe(TRACK_2_ID);
      // The whole point: no THIRD create for a track already primed.
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      // ...and the primed session is the one now playing, not a discard.
      expect(endPlaybackSession).not.toHaveBeenCalledWith(SESSION_2_ID);
      expect(capturedCtx!.isPlaying).toBe(true);
      // The removed track's own session is released rather than left live.
      expect(endPlaybackSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it("plays the promoted slot's element, and leaves the removed track's element paused", async () => {
      view = await playAndPrimeNext();
      const [slotA, slotB] = [
        view.container.querySelectorAll("audio")[0]!,
        view.container.querySelectorAll("audio")[1]!,
      ];
      const playB = vi.spyOn(slotB, "play");
      const pauseA = vi.spyOn(slotA, "pause");

      await act(async () => {
        capturedCtx!.removeFromQueue(capturedCtx!.current!.entryId);
      });
      await flush();

      expect(playB).toHaveBeenCalled();
      expect(pauseA).toHaveBeenCalled();
      // Position resets to the top of the promoted track.
      expect(capturedCtx!.positionMs).toBe(0);
    });

    it("still loads fresh when the removed row's successor is NOT the primed one", async () => {
      view = await playAndPrimeNext();
      // Queue the primed track away: enqueue a third track and jump the
      // removal target so the new current entry is one no slot holds.
      await act(async () => {
        capturedCtx!.enqueue({ itemId: TRACK_3_ID, title: "Third Rail" });
      });
      await act(async () => {
        // Remove the PRIMED entry first, then the current one, so the new
        // current entry (Third Rail) was never loaded anywhere.
        capturedCtx!.removeFromQueue(capturedCtx!.queueState.items[1]!.entryId);
      });
      await flush();
      await act(async () => {
        capturedCtx!.removeFromQueue(capturedCtx!.current!.entryId);
      });
      await flush();

      expect(capturedCtx!.current?.itemId).toBe(TRACK_3_ID);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(3);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(3, TRACK_3_ID, "stream", undefined);
    });
  });

  // browser-player-F11: the "current track changed" effect keyed itself on
  // [queueState.currentIndex, queueState.items.length], but REORDER/REMOVE
  // (lib/queue.ts) deliberately MOVE currentIndex so it keeps following the
  // same entry — so every queue edit that shifts the current row re-ran the
  // effect for a track that never changed, and its only guard
  // (`gaplessState.loaded[active] === track.itemId`) is not yet true while
  // the session create is still in flight, nor ever true for a load that
  // failed. Result: a duplicate POST /playback/sessions (and a fresh
  // el.src + el.load()) for the already-playing entry, per edit.
  describe("queue edits that shift the current index (browser-player-F11)", () => {
    const THREE_TRACKS: PlayableTrackInput[] = [
      { itemId: TRACK_ID, title: "Low Water" },
      { itemId: TRACK_2_ID, title: "Second Sun" },
      { itemId: TRACK_3_ID, title: "Third Rail" },
    ];

    /** Starts the 3-track queue at `startIndex` with the current track's
     *  session create left IN FLIGHT — the window in which a re-fired
     *  effect is observable as a second create for the same entry. */
    async function playQueueMidLoad(startIndex: number): Promise<TestRender> {
      createDirectPlaySession.mockReset().mockImplementation(
        () =>
          new Promise(() => {
            /* never settles: the load stays in flight for the whole test */
          }),
      );
      capturedCtx = null;
      let rendered: TestRender | null = null;
      await act(async () => {
        rendered = renderPlayer(<CaptureContext />);
      });
      await act(async () => {
        capturedCtx!.playQueue(THREE_TRACKS, startIndex);
      });
      await flush();
      if (!rendered) throw new Error("render produced nothing");
      return rendered;
    }

    it("does not re-create the current track's session when the current row is moved up", async () => {
      view = await playQueueMidLoad(2);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);
      const currentEntryId = capturedCtx!.current!.entryId;

      await act(async () => {
        capturedCtx!.reorderQueue(2, 1);
      });
      await flush();

      // Pure reorder: same entry, new index, NO second session create.
      expect(capturedCtx!.current?.entryId).toBe(currentEntryId);
      expect(capturedCtx!.queueState.currentIndex).toBe(1);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);
    });

    it("does not re-create the current track's session when an earlier row is removed", async () => {
      view = await playQueueMidLoad(2);
      const currentEntryId = capturedCtx!.current!.entryId;
      const firstEntryId = capturedCtx!.queueState.items[0]!.entryId;

      await act(async () => {
        capturedCtx!.removeFromQueue(firstEntryId);
      });
      await flush();

      expect(capturedCtx!.current?.entryId).toBe(currentEntryId);
      expect(capturedCtx!.queueState.currentIndex).toBe(1);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);
    });

    it("still loads the new current track when the current row itself is removed", async () => {
      view = await playQueueMidLoad(1);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(1, TRACK_2_ID, "stream", undefined);

      await act(async () => {
        capturedCtx!.removeFromQueue(capturedCtx!.current!.entryId);
      });
      await flush();

      // A DIFFERENT entry is current now — that must still load.
      expect(capturedCtx!.current?.itemId).toBe(TRACK_3_ID);
      expect(createDirectPlaySession).toHaveBeenNthCalledWith(2, TRACK_3_ID, "stream", undefined);
    });

    it("leaves a PLAYING track's element untouched across a reorder and a removal", async () => {
      view = await playQueueAndSettle(THREE_TRACKS.map((t) => ({ ...t })));
      const active = view.container.querySelectorAll("audio")[0]!;
      const srcBefore = active.src;
      expect(srcBefore).not.toBe("");

      await act(async () => {
        capturedCtx!.enqueue({ itemId: TRACK_3_ID, title: "Third Rail (again)" });
      });
      await act(async () => {
        capturedCtx!.reorderQueue(0, 2);
      });
      await act(async () => {
        capturedCtx!.removeFromQueue(capturedCtx!.queueState.items[0]!.entryId);
      });
      await flush();

      // Same element, same src: nothing restarted the playing track.
      expect(active.src).toBe(srcBefore);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);
    });

    // The same identity rule, seen from the other side: the OLD guard
    // compared itemIds, so the same track queued twice in a row looked
    // "already loaded" in the active slot and the second entry never
    // played — the queue advanced and then sat silent.
    it("loads the second queue entry for a repeated track instead of assuming the slot holds it", async () => {
      createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
      view = await playQueueAndSettle([
        { itemId: TRACK_ID, title: "Low Water" },
        { itemId: TRACK_ID, title: "Low Water" },
      ]);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(1);

      // `ended` with nothing preloaded: advance only, and let the effect do
      // a fresh (non-gapless) load in the SAME slot.
      const active = view.container.querySelectorAll("audio")[0]!;
      await act(async () => {
        active.dispatchEvent(new Event("ended"));
      });
      await flush();

      expect(capturedCtx!.queueState.currentIndex).toBe(1);
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
    });
  });

  // d4-m1 (backlog #116, the exact twin of the video player's d3-a4/gap-F6):
  // the contract's ProgressUpdate declares an INTEGER durationMs, and an
  // <audio> element's `duration` is a float by nature. `onLoadedMetadata`
  // adopted `el.duration * 1000` raw into durationRef, and the heartbeat
  // `send` passed that straight through — so once a track reported a
  // fractional duration EVERY music heartbeat 422'd
  // ('durationMs must be an integer or null') and music progress silently
  // stopped being written. Only the unload path was safe, because it alone
  // went through lib/progress-body.ts's rounding builder.
  describe("progress body integrity (d4-m1)", () => {
    /** The live-observed gap-F6 shape: a fractional element duration. */
    const FRACTIONAL_SECONDS = 773.3475;

    function setElementClock(el: HTMLMediaElement, durationSeconds: number, currentSeconds: number): void {
      Object.defineProperty(el, "duration", { configurable: true, get: () => durationSeconds });
      Object.defineProperty(el, "currentTime", { configurable: true, get: () => currentSeconds });
    }

    it("rounds an adopted fractional element duration instead of 422ing every heartbeat", async () => {
      createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
      view = await playQueueAndSettle([{ itemId: TRACK_ID, title: "Low Water" }]);

      const active = view.container.querySelectorAll("audio")[0]!;
      setElementClock(active, FRACTIONAL_SECONDS, 12.3456);
      await act(async () => {
        active.dispatchEvent(new Event("loadedmetadata"));
      });

      // The adopted duration is what the mini player shows AND what every
      // later heartbeat carries: integer ms at the point of adoption
      // (773347.5 rounds up, exactly like every other ms in this app).
      expect(capturedCtx!.durationMs).toBe(773_348);

      apiPut.mockClear();
      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      // `pause` flushes the heartbeat immediately (docs/PLAYBACK.md §9).
      await act(async () => {
        active.dispatchEvent(new Event("pause"));
      });
      await flush();

      const body = lastProgressBody();
      expect(Number.isInteger(body.durationMs)).toBe(true);
      expect(body.durationMs).toBe(773_348);
      expect(Number.isInteger(body.positionMs)).toBe(true);
      expect(body.positionMs).toBe(12_346);
      expect(body.sessionId).toBe(SESSION_ID);
    });

    it("keeps the queue's own integer durationMs when the element never reports one", async () => {
      createDirectPlaySession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
      view = await playQueueAndSettle([{ itemId: TRACK_ID, title: "Low Water", durationMs: 200_000 }]);

      const active = view.container.querySelectorAll("audio")[0]!;
      Object.defineProperty(active, "duration", { configurable: true, get: () => Number.NaN });
      await act(async () => {
        active.dispatchEvent(new Event("loadedmetadata"));
        active.dispatchEvent(new Event("pause"));
      });
      await flush();

      const body = lastProgressBody();
      expect(body.durationMs).toBe(200_000);
      expect(Number.isInteger(body.positionMs)).toBe(true);
    });
  });

  // d4-m2 (backlog #124, M/d3-m3-adjacent): `gaplessState.preloadPending`
  // only latches when PRELOAD_NEXT is dispatched, which happens AFTER the
  // session create resolves — so every `timeupdate` tick inside that
  // in-flight window (the element fires ~4/s) started ANOTHER preload for
  // the same next track. Observed live as POSTs 61+62 for one preload; the
  // superseded one self-cleaned via DELETE (d3-m3's token discipline), so
  // it was churn rather than a leak — but it is still a duplicate
  // POST /playback/sessions per tick against a server whose transcode slots
  // are counted. The latch has to be taken at REQUEST time, and the
  // provider already keeps a request-time record: `slotEntryRef` claims a
  // slot for an entry synchronously, before `loadIntoSlot`'s first await.
  describe("request-time preload latch (d4-m2)", () => {
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    const TWO_TRACKS: PlayableTrackInput[] = [
      { itemId: TRACK_ID, title: "Low Water", durationMs: 200_000 },
      { itemId: TRACK_2_ID, title: "Second Sun" },
    ];

    /** Plays track 1 and returns its element parked past the near-end
     *  threshold, so every `timeupdate` dispatched on it asks to preload. */
    async function playPastThreshold(): Promise<[TestRender, HTMLMediaElement]> {
      const rendered = await playQueueAndSettle(TWO_TRACKS);
      const active = rendered.container.querySelectorAll("audio")[0]!;
      Object.defineProperty(active, "currentTime", { configurable: true, get: () => 199 });
      return [rendered, active];
    }

    it("starts ONE preload when two timeupdate ticks land inside the create's in-flight window", async () => {
      let resolvePreload: (r: unknown) => void = () => undefined;
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolvePreload = res;
            }),
        )
        // Anything after the second call is a DUPLICATE preload — given a
        // distinct session id so the assertions below can name it.
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_3_ID, itemId: TRACK_2_ID } });

      const [rendered, active] = await playPastThreshold();
      view = rendered;

      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      await act(async () => {
        active.dispatchEvent(new Event("timeupdate"));
      });
      await flush();

      // 1 active + 1 preload. A third is the duplicate this guards against.
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);

      // The in-flight preload lands and primes slot B — nothing superseded
      // it, so nothing had to be cleaned up after it either.
      await act(async () => {
        resolvePreload({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });
      });
      await flush();

      const preloading = rendered.container.querySelectorAll("audio")[1]!;
      expect(preloading.src).toContain(SESSION_2_ID);
      expect(endPlaybackSession).not.toHaveBeenCalled();
    });

    it("does not re-request a preload on every later tick once the next track is primed", async () => {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockResolvedValue({ ok: true, session: { ...directPlaySession(), id: SESSION_2_ID, itemId: TRACK_2_ID } });

      const [rendered, active] = await playPastThreshold();
      view = rendered;

      for (let tick = 0; tick < 4; tick += 1) {
        await act(async () => {
          active.dispatchEvent(new Event("timeupdate"));
        });
        await flush();
      }

      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
    });

    it("does not retry a preload whose create FAILED on every subsequent tick", async () => {
      createDirectPlaySession
        .mockReset()
        .mockResolvedValueOnce({ ok: true, session: directPlaySession() })
        .mockRejectedValue(apiError(404, "Not Found"));

      const unhandled = await captureUnhandledRejections(async () => {
        const [rendered, active] = await playPastThreshold();
        view = rendered;
        for (let tick = 0; tick < 3; tick += 1) {
          await act(async () => {
            active.dispatchEvent(new Event("timeupdate"));
          });
          await flush();
        }
      });

      // One attempt, not one per tick: a failed preload is surfaced (once)
      // by the fresh load that runs if that track ever becomes current —
      // re-POSTing it four times a second is a 404 storm, not a retry.
      expect(createDirectPlaySession).toHaveBeenCalledTimes(2);
      expect(unhandled).toHaveLength(0);
      // Still silent, still playing track 1 (failTrackLoad's preloadOnly contract).
      expect(toastText(view!.container)).toBe("");
      expect(capturedCtx!.current?.itemId).toBe(TRACK_ID);
    });
  });
});
