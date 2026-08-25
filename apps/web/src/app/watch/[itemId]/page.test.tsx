// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/watch/[itemId]/page.test.tsx
//
// REGRESSION GUARD (77-agent review, "every per-version Play button starts
// the same DEFAULT media file"): components/detail/VersionRow.tsx emits the
// clicked version as a `?mediaFileId=` query param on its own
// /watch/{itemId} link (VersionRow.test.tsx guards that half). This file
// guards the OTHER half — that the param survives this route and reaches
// the REAL PlanRequest (POST /playback/sessions, whose `mediaFileId`
// "defaults to the item's primary media_files row when omitted"), instead
// of being dropped so every version silently plays the default file.
//
// The route's own VideoPlayer renders for real here — only its I/O
// collaborators are mocked — so the assertion lands on the actual session
// request a user's click produces, not on a prop hand-off.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { ToastProvider } from "../../../components/ui/Toast.js";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";
import type { ItemSummary } from "../../../lib/item-lookup.js";
import { describeReasonCode, ITEM_UNAVAILABLE_CODE } from "../../../lib/playback-reasons.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];

const SERVER_URL = "http://localhost:9000";
const ITEM_ID = "01890000-0000-7000-8000-000000000001";
const SESSION_ID = "01890000-0000-7000-8000-0000000000aa";
/** A NON-default media_files row for the same item — the "4K"/alternate-cut
 *  version a user picks out of a detail page's Versions list. */
const ALT_FILE_ID = "01890000-0000-7000-8000-0000000000d9";

const createPlaybackSession = vi.fn();
const endPlaybackSession = vi.fn();
const playTrack = vi.fn();
const playQueue = vi.fn();
const routerBack = vi.fn();
const routerReplace = vi.fn();

// gap-F9: the route branches on `err instanceof ItemLookupError` /
// `instanceof LoombreApiError`, so the two mocked modules below must export
// real classes the tests can construct — `vi.hoisted` makes them available
// inside the hoisted `vi.mock` factories. Same shape as the real ones
// (lib/item-lookup.ts's `itemId`, lib/api-client.ts's `status`).
const { FakeItemLookupError, FakeLoombreApiError } = vi.hoisted(() => {
  class FakeItemLookupError extends Error {
    constructor(public readonly itemId: string) {
      super(`No playable item found for id ${itemId} (tried movie/episode/track/album)`);
      this.name = "ItemLookupError";
    }
  }
  class FakeLoombreApiError extends Error {
    constructor(public readonly status: number) {
      super(`HTTP ${status}`);
      this.name = "LoombreApiError";
    }
  }
  return { FakeItemLookupError, FakeLoombreApiError };
});

let searchParams = new URLSearchParams();
let summary: ItemSummary = movieSummary();
/** When set, `fetchItemSummary` rejects with it instead of resolving. */
let lookupError: Error | null = null;
/** When set, `fetchItemSummary` waits on it before settling — the "the
 *  probes are still in flight" window verify/gap-F9 is about (up to four
 *  sequential kind probes; ~100ms local, seconds on a remote server). */
let lookupGate: Promise<void> | null = null;

const router = { back: routerBack, replace: routerReplace };

vi.mock("next/navigation", () => ({
  useParams: () => ({ itemId: ITEM_ID }),
  useSearchParams: () => searchParams,
  useRouter: () => router,
}));

// The music mini player lives above the route layout (AppProviders) and
// keeps playing across navigation — this route only hands off to it.
vi.mock("../../../components/music/MusicPlayerProvider.js", () => ({
  useMusicPlayer: () => ({ playTrack, playQueue }),
}));

// SystemNoticeProvider likewise lives above the route layout (AppProviders)
// — this route's VideoPlayer mounts NoticeOverlayStrip against it, but
// this file is about ?mediaFileId/?t deep-link plumbing, not system
// notices (see NoticeOverlayStrip.test.tsx for that coverage), so it's
// mocked away exactly like MusicPlayerProvider above.
vi.mock("../../../components/notices/SystemNoticeProvider.js", () => ({
  useSystemNotice: () => ({
    notice: null,
    severity: null,
    serverOffsetMs: 0,
    dismissed: false,
    dismiss: vi.fn(),
    bannerVisible: false,
  }),
}));

vi.mock("../../../lib/playback-session.js", () => ({
  createPlaybackSession: (...args: unknown[]) => createPlaybackSession(...args),
  endPlaybackSession: (...args: unknown[]) => endPlaybackSession(...args),
}));

vi.mock("../../../lib/item-lookup.js", () => ({
  fetchItemSummary: async () => {
    if (lookupGate) await lookupGate;
    if (lookupError) throw lookupError;
    return summary;
  },
  ItemLookupError: FakeItemLookupError,
  backdropImage: () => null,
}));

const findProgressForItem = vi.fn();

vi.mock("../../../lib/progress-lookup.js", () => ({
  findProgressForItem: (...args: unknown[]) => findProgressForItem(...args),
  isWorthResuming: (p: { positionMs: number }) => p.positionMs >= 5000,
}));

vi.mock("../../../lib/progress-report.js", () => ({
  reportProgressOnUnload: vi.fn(),
}));

// Shared by two real callers: WatchPage's own album-track fetch (GET
// /albums/{id}/tracks) and VideoPlayer's S7/K9 chapters fetch (GET
// /items/{id}/chapters) — both only ever read `.items` off the result, so
// a generic `{ items: [] }` default resolves both sensibly with no
// per-test override needed.
const apiGet = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  LoombreApiError: FakeLoombreApiError,
}));

/** Flipped by the signed-out test below (d3-c6). */
let authenticated = true;

vi.mock("../../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    getSnapshot: () => ({ serverUrl: SERVER_URL, accessToken: "test-access-token" }),
    getAccessToken: async () => "test-access-token",
  }),
}));

// Imported AFTER the mocks (app/home/page.test.tsx's established
// convention) so the route module picks them up.
const { default: WatchPage } = await import("./page.js");

/** jsdom implements almost none of HTMLMediaElement — the player's attach
 *  effect assigns `src` and calls `load()`, which jsdom answers with a "not
 *  implemented" console error. Only the surface this route touches is
 *  replaced (see VideoPlayer.test.tsx for the full-fidelity version). */
function installMediaStubs(): void {
  const proto = HTMLMediaElement.prototype;
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };
  define("play", { value: () => Promise.resolve() });
  define("pause", { value: () => undefined });
  define("load", { value: () => undefined });
  define("canPlayType", { value: () => "" });
  define("paused", { get: () => true });
  define("duration", { get: () => 600 });
  define("buffered", { get: () => ({ length: 0, start: () => 0, end: () => 0 }) });
}

installMediaStubs();

/** jsdom has no window.matchMedia, which ResumePrompt's SheetOrModal needs
 *  (VideoPlayer.test.tsx's identical note) — only needed for the deep-link-
 *  vs-resume-prompt test below, but installing it unconditionally is
 *  harmless for the rest of this file's tests. */
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

function movieSummary(): ItemSummary {
  return {
    id: ITEM_ID,
    itemType: "movie",
    title: "Arrival",
    subtitle: null,
    images: [],
    durationMs: 600_000,
    mediaFiles: [],
  };
}

function trackSummary(): ItemSummary {
  return {
    id: ITEM_ID,
    itemType: "track",
    title: "Heliotrope",
    subtitle: "Track 3",
    images: [],
    durationMs: 214_000,
    mediaFiles: [],
  };
}

function albumSummary(): ItemSummary {
  return {
    id: ITEM_ID,
    itemType: "album",
    title: "Ashenwood",
    subtitle: "2019",
    images: [],
    durationMs: null,
    mediaFiles: [],
  };
}

/** GET /albums/{id}/tracks rows, in album order. */
function albumTracks(): Array<{ id: string; title: string; trackNumber: number; durationMs: number; albumId: string }> {
  return [
    { id: "01890000-0000-7000-8000-00000000e001", title: "Lanternfly", trackNumber: 1, durationMs: 191_000, albumId: ITEM_ID },
    { id: "01890000-0000-7000-8000-00000000e002", title: "Ashenwood", trackNumber: 2, durationMs: 246_000, albumId: ITEM_ID },
  ];
}

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
    media: { fileId: ALT_FILE_ID, container: "mkv", durationMs: 600_000, sizeBytes: 1, overallBitrateBps: 1, video: [], audio: [], subtitle: [] },
    status: "created",
    errorCode: null,
    manifestUrl: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

/** jsdom's `window.history.length` is always 1 and read-only; the route
 *  reads it to tell "there IS a previous entry to go back to" from "this
 *  document is the first entry" (bookmark / typed URL / new tab). Defined
 *  on the instance so `afterEach` can delete it back to the real getter. */
function setHistoryLength(length: number): void {
  Object.defineProperty(window.history, "length", { configurable: true, get: () => length });
}

function restoreHistoryLength(): void {
  Reflect.deleteProperty(window.history, "length");
}

function backButton(view: TestRender): HTMLButtonElement | undefined {
  return Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Back");
}

/** Renders the route and settles its chained lookups (item summary, then —
 *  for video — session create and the progress lookup). */
async function renderRoute(): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderIntoBody(
      <ToastProvider>
        <WatchPage />
      </ToastProvider>,
    );
  });
  await act(async () => undefined);
  if (!view) throw new Error("render produced nothing");
  return view;
}

describe("WatchPage", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    installMatchMedia();
    searchParams = new URLSearchParams();
    summary = movieSummary();
    lookupError = null;
    lookupGate = null;
    authenticated = true;
    createPlaybackSession.mockReset().mockResolvedValue({ ok: true, session: directPlaySession() });
    endPlaybackSession.mockReset().mockResolvedValue(undefined);
    findProgressForItem.mockReset().mockResolvedValue(null);
    apiGet.mockReset().mockResolvedValue({ items: [] });
    playTrack.mockReset();
    playQueue.mockReset();
    routerBack.mockReset();
    routerReplace.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    restoreHistoryLength();
    // pushState LEAKS across tests in a file (jsdom keeps the document's
    // URL), and lib/auth-return-path.ts reads location — put it back.
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("starts the version named by ?mediaFileId, not the item's default file", async () => {
    searchParams = new URLSearchParams({ mediaFileId: ALT_FILE_ID });
    view = await renderRoute();
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", ALT_FILE_ID);
  });

  it("leaves the file unpinned on a plain /watch/{itemId} link, so the server's primary file wins", async () => {
    view = await renderRoute();
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", undefined);
  });

  it("keeps the ?type hint working alongside the version param", async () => {
    searchParams = new URLSearchParams({ type: "episode", mediaFileId: ALT_FILE_ID });
    summary = { ...movieSummary(), itemType: "episode" };
    view = await renderRoute();
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", ALT_FILE_ID);
  });

  it("hands the picked version to the music player for a track", async () => {
    searchParams = new URLSearchParams({ mediaFileId: ALT_FILE_ID });
    summary = trackSummary();
    view = await renderRoute();
    expect(createPlaybackSession).not.toHaveBeenCalled();
    expect(playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: ITEM_ID, title: "Heliotrope", mediaFileId: ALT_FILE_ID }),
    );
  });

  // S7 chapters: app/restricted/scenes/[id]/page.tsx's markers list links
  // here with `?t=<wholeSeconds>` — this route must convert it to ms and
  // hand it to VideoPlayer as `startMs`, which wins over the resume prompt
  // (VideoPlayer.test.tsx covers the seek/no-prompt mechanics in full
  // fidelity; this is the route-level proof the query param actually
  // reaches it).
  it("?t=<seconds> suppresses the resume prompt even when a worth-resuming saved position exists", async () => {
    searchParams = new URLSearchParams({ t: "90" });
    findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
    view = await renderRoute();
    expect(view.container.textContent).not.toContain("You stopped at");
  });

  it("a plain /watch/{itemId} link (no ?t=) still shows the resume prompt when a worth-resuming saved position exists", async () => {
    findProgressForItem.mockResolvedValue({ itemId: ITEM_ID, positionMs: 120_000, state: "in-progress" });
    view = await renderRoute();
    expect(view.container.textContent).toContain("You stopped at");
  });

  it("ignores a malformed ?t= (non-numeric/negative) rather than crashing the route", async () => {
    searchParams = new URLSearchParams({ t: "not-a-number" });
    view = await renderRoute();
    expect(createPlaybackSession).toHaveBeenCalledWith(ITEM_ID, "stream", undefined);
  });

  // gap-F8: the music handoff used to end in an unconditional
  // `router.back()`. The MusicPlayerProvider that just received the queue
  // lives ABOVE this route (AppProviders, mounted by the root layout), so
  // the handoff only survives if the browser stays in THIS document. A
  // history traversal cannot promise that: reached by a direct URL /
  // bookmark / new tab (the reported repro) the previous entry is another
  // DOCUMENT, and going back to it tears down the provider — and with it
  // the queue — before it ever created a playback session; with no
  // previous entry at all `back()` does nothing and the user is stranded
  // on a route that renders null. Landing on the item's own page is a
  // same-document client navigation, so it holds in every arrival case.
  describe("music handoff (gap-F8)", () => {
    it("hands a track to the persistent player and lands on the track's own page, never a history traversal", async () => {
      summary = trackSummary();
      view = await renderRoute();

      expect(playTrack).toHaveBeenCalledWith(expect.objectContaining({ itemId: ITEM_ID, title: "Heliotrope" }));
      expect(routerReplace).toHaveBeenCalledWith(`/items/track/${ITEM_ID}`);
      expect(routerBack).not.toHaveBeenCalled();
    });

    it("queues a whole album in album order and lands on the album's own page", async () => {
      summary = albumSummary();
      apiGet.mockImplementation(async (path: unknown) =>
        path === "/albums/{id}/tracks" ? { items: albumTracks() } : { items: [] },
      );
      view = await renderRoute();

      expect(playQueue).toHaveBeenCalledWith([
        expect.objectContaining({ itemId: "01890000-0000-7000-8000-00000000e001", title: "Lanternfly" }),
        expect.objectContaining({ itemId: "01890000-0000-7000-8000-00000000e002", title: "Ashenwood" }),
      ]);
      expect(routerReplace).toHaveBeenCalledWith(`/items/album/${ITEM_ID}`);
      expect(routerBack).not.toHaveBeenCalled();
    });

    // playQueue([]) is SET_QUEUE with no tracks, which lib/queue.ts's
    // reducer answers with `{ items: [], currentIndex: null }` — i.e. it
    // STOPS whatever the user is currently listening to. An album with
    // nothing playable in it must not do that.
    it("leaves a playing queue alone when the album has no tracks", async () => {
      summary = albumSummary();
      view = await renderRoute();

      expect(playQueue).not.toHaveBeenCalled();
      expect(routerReplace).toHaveBeenCalledWith(`/items/album/${ITEM_ID}`);
    });
  });

  // gap-F9: /watch/{an id this viewer cannot see} — restricted content the
  // guard filters out, a deleted item, a mistyped id. Every kind probe 404s,
  // so lib/item-lookup.ts's `fetchItemSummary` rejects with ItemLookupError.
  // The route used to have NO error handling on that promise at all: the
  // rejection became a silent unhandled rejection, `routed` never left
  // "pending", and the route rendered `null` FOREVER — a completely blank
  // black page with no text and no control (QA: innerText length 0 after
  // 15s; only the browser's own Back escapes). Containment is correct and
  // stays correct (nothing about the item is revealed) — the user must just
  // not be stranded.
  describe("unresolvable item (gap-F9)", () => {
    it("renders the unavailable screen instead of a permanent blank page when every kind probe 404s", async () => {
      lookupError = new FakeItemLookupError(ITEM_ID);
      view = await renderRoute();

      expect(view.container.textContent).not.toBe("");
      // VideoPlayer's own fallback copy for a title-less item, per the
      // report's `expected` (VideoPlayer.tsx's `item?.title ?? "This item"`).
      expect(view.container.textContent).toContain("This item");
      expect(backButton(view)).toBeDefined();
      // Nothing about the item leaked into the render, and no session was
      // ever attempted for an id the viewer cannot see.
      expect(createPlaybackSession).not.toHaveBeenCalled();
    });

    it("Back goes back when this document has a previous history entry", async () => {
      setHistoryLength(3);
      lookupError = new FakeItemLookupError(ITEM_ID);
      view = await renderRoute();

      await act(async () => {
        backButton(view!)?.click();
      });
      expect(routerBack).toHaveBeenCalledTimes(1);
      expect(routerReplace).not.toHaveBeenCalled();
    });

    // Reached by a bookmark / typed URL / new tab there is no previous entry
    // and `router.back()` is a NO-OP — a Back button that does nothing is
    // the same stranding this finding is about (gap-F8's note, same route).
    it("Back lands on /home when /watch is this document's first history entry", async () => {
      setHistoryLength(1);
      lookupError = new FakeItemLookupError(ITEM_ID);
      view = await renderRoute();

      await act(async () => {
        backButton(view!)?.click();
      });
      expect(routerReplace).toHaveBeenCalledWith("/home");
      expect(routerBack).not.toHaveBeenCalled();
    });

    // A non-404 failure (server down, 500 on one of the probe endpoints)
    // rejects the same promise and produced the same blank page.
    it("renders the unavailable screen for a non-404 lookup failure too", async () => {
      lookupError = new FakeLoombreApiError(500);
      view = await renderRoute();

      expect(view.container.textContent).toContain("This item");
      expect(view.container.textContent).toContain("HTTP 500");
      expect(backButton(view)).toBeDefined();
    });

    // C/gap-F9-followup: UnavailableScreen's own copy is session-refusal
    // shaped ("Session refused · HTTP 404", and "No specific reason was
    // reported." when `reasons` is empty) — true for a plan the server
    // refused, a lie for an item that never resolved at all: no session was
    // ever requested here. lib/playback-reasons.ts's `item-unavailable` is
    // the same client-synthesized-reason pattern as
    // transcode-slots-exhausted / client-playback-error.
    it("says why the item can't be opened instead of 'No specific reason was reported.'", async () => {
      lookupError = new FakeItemLookupError(ITEM_ID);
      view = await renderRoute();

      const text = view.container.textContent ?? "";
      expect(text).not.toContain("No specific reason was reported.");
      expect(text).toContain(describeReasonCode(ITEM_UNAVAILABLE_CODE).title);
      expect(text).toContain(ITEM_UNAVAILABLE_CODE);
    });

    // d3-a5 (lane C's own handoff: "consume `variant` here" — AQ's d3-aq6
    // prop had not merged when lane C ran): an item that never resolved is
    // not a REFUSED session — no plan was ever made, so "Session refused ·
    // Planner reasons, verbatim" was a lie on this path. AQ's `unavailable`
    // framing exists exactly for it.
    it("wears the UNAVAILABLE framing — an unresolved item is not a refused session (d3-a5)", async () => {
      lookupError = new FakeItemLookupError(ITEM_ID);
      view = await renderRoute();

      const text = view.container.textContent ?? "";
      expect(text).toContain("Unavailable");
      expect(text).not.toContain("Session refused");
      expect(text).not.toContain("Planner reasons");
    });

    // The album branch's own `GET /albums/{id}/tracks` is inside the same
    // promise chain — it must not be able to strand the route either.
    it("renders the unavailable screen when the album's track fetch fails", async () => {
      summary = albumSummary();
      apiGet.mockImplementation(async (path: unknown) => {
        if (path === "/albums/{id}/tracks") throw new FakeLoombreApiError(503);
        return { items: [] };
      });
      view = await renderRoute();

      expect(view.container.textContent).toContain("This item");
      expect(backButton(view)).toBeDefined();
    });
  });

  // verify/gap-F9 (the OTHER half of the same report): even when the lookup
  // eventually succeeds, this route rendered `null` for the whole probing
  // window — a blank full-bleed page with no indication anything is
  // happening. lib/item-lookup.ts probes in parallel now, but a remote server
  // still makes that a real, visible wait, and a click that paints nothing
  // reads as a dead app.
  describe("pending lookup (verify/gap-F9)", () => {
    /** Renders with the lookup deliberately unsettled, and hands back the
     *  release valve. */
    async function renderWhilePending(): Promise<{ view: TestRender; settle: () => Promise<void> }> {
      let release: () => void = () => undefined;
      lookupGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rendered = await renderRoute();
      return {
        view: rendered,
        settle: async () => {
          release();
          await act(async () => undefined);
          await act(async () => undefined);
        },
      };
    }

    it("REGRESSION GUARD: shows a loading surface while the item is still being resolved, not a blank page", async () => {
      const pending = await renderWhilePending();
      view = pending.view;

      expect(view.container.textContent).not.toBe("");
      expect(view.container.querySelector('[role="status"]')).not.toBeNull();
      // Still nothing has been started for an item that may not even exist.
      expect(createPlaybackSession).not.toHaveBeenCalled();

      await pending.settle();
    });

    it("replaces the loading surface with the player once the lookup resolves", async () => {
      const pending = await renderWhilePending();
      view = pending.view;
      await pending.settle();

      expect(view.container.querySelector('[role="status"]')).toBeNull();
      expect(createPlaybackSession).toHaveBeenCalled();
    });
  });

  // D/browser-shell-browse-F1 adjacent (d3-c6): a signed-out arrival at a
  // /watch link — a shared link, a bookmark opened in a fresh browser — was
  // sent to a bare /login, so signing in dropped the viewer on /home with no
  // trace of what they had clicked. lib/auth-return-path.ts already owns the
  // (open-redirect-safe) return-path encoding used by the rest of the shell.
  describe("signed-out arrival keeps the destination (d3-c6)", () => {
    it("REGRESSION GUARD: redirects to /login?next=<this watch url>, not a bare /login", async () => {
      authenticated = false;
      window.history.pushState({}, "", `/watch/${ITEM_ID}?type=movie`);

      view = await renderRoute();

      expect(routerReplace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/watch/${ITEM_ID}?type=movie`)}`);
      // Nothing about the item is fetched for a viewer with no session.
      expect(createPlaybackSession).not.toHaveBeenCalled();
    });

    it("still just goes to /login when there is no usable path to come back to", async () => {
      authenticated = false;
      window.history.pushState({}, "", "/login");

      view = await renderRoute();

      expect(routerReplace).toHaveBeenCalledWith("/login");
    });
  });
});
