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

import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];

const SERVER_URL = "http://localhost:9000";
const TRACK_ID = "01890000-0000-7000-8000-000000000031";
const SESSION_ID = "01890000-0000-7000-8000-0000000000ab";
/** A NON-default media_files row for the same track — the alternate
 *  (lossless/remaster) version a user picks out of its Versions list. */
const ALT_FILE_ID = "01890000-0000-7000-8000-0000000000d8";

const createDirectPlaySession = vi.fn();
const endPlaybackSession = vi.fn();

vi.mock("../../lib/playback-session.js", () => ({
  createDirectPlaySession: (...args: unknown[]) => createDirectPlaySession(...args),
  endPlaybackSession: (...args: unknown[]) => endPlaybackSession(...args),
}));

vi.mock("../../lib/api-client.js", () => ({
  apiPut: vi.fn(),
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

async function playAndSettle(track: PlayableTrackInput): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderIntoBody(
      <MusicPlayerProvider>
        <PlayOnMount track={track} />
      </MusicPlayerProvider>,
    );
  });
  await act(async () => undefined);
  if (!view) throw new Error("render produced nothing");
  return view;
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
});
