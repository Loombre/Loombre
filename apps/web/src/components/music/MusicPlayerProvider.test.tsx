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
// every `ended` — an undefined return would throw there.
vi.mock("../../lib/api-client.js", () => ({
  apiPut: vi.fn(async () => undefined),
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
});
