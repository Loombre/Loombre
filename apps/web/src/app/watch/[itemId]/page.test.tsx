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

let searchParams = new URLSearchParams();
let summary: ItemSummary = movieSummary();

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
  fetchItemSummary: async () => summary,
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
}));

vi.mock("../../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => true,
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
});
