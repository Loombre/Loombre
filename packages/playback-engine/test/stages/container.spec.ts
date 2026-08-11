// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/container.ts (Stage A — docs/PLAYBACK.md §3).
 * Lives in the package's NORMAL (non-matrix) test project — vitest.config.ts's
 * `include` covers `test/**\/*.spec.ts` — never touching matrix/'s case
 * files or burn-up manifest.
 *
 * Per this step's instructions, coverage includes: in-list container,
 * out-of-list, empty directPlayContainers, music containers, and the
 * "B-E-copy re-evaluation" contract at the stub level (i.e. that Stage A in
 * isolation never itself claims 'direct-play' is final — that composition
 * happens one level up, in src/plan.ts, which test/plan.spec.ts covers).
 */
import { describe, expect, it } from "vitest";
import { evaluateContainer } from "../../src/stages/container.js";
import type { DeviceProfile, MediaInfo } from "../../src/types.js";

function makeDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: "high",
        maxLevel: 41,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 8_000_000,
    video: [
      {
        index: 0,
        codec: "h264",
        profile: "high",
        level: 41,
        width: 1920,
        height: 1080,
        bitDepth: 8,
        frameRate: 23.976,
        bitrateBps: 5_000_000,
        hdr: "none",
        dvProfile: null,
        dvBlCompatId: null,
        interlaced: false,
        openGop: false,
      },
    ],
    audio: [
      {
        index: 1,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
        bitrateBps: 160_000,
        language: "eng",
        isDefault: true,
        hasAtmos: false,
      },
    ],
    subtitle: [],
    ...overrides,
  };
}

describe("Stage A: evaluateContainer", () => {
  it("container in directPlayContainers -> verdict direct-play, reasons []", () => {
    const media = makeMedia({ container: "mp4" });
    const device = makeDevice({ directPlayContainers: ["mp4", "webm"] });
    expect(evaluateContainer(media, device)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("container NOT in directPlayContainers -> verdict direct-stream, container-not-direct-playable reason", () => {
    const media = makeMedia({ container: "mkv" });
    const device = makeDevice({ directPlayContainers: ["mp4", "webm"] });
    const result = evaluateContainer(media, device);
    expect(result.verdict).toBe("direct-stream");
    expect(result.reasons).toEqual([{ code: "container-not-direct-playable", detail: "container=mkv" }]);
  });

  it("the fired reason carries no streamIndex — container is a MediaInfo property, not a stream property", () => {
    const media = makeMedia({ container: "avi" });
    const device = makeDevice({ directPlayContainers: ["mp4"] });
    const [reason] = evaluateContainer(media, device).reasons;
    expect(reason).toBeDefined();
    expect(reason).not.toHaveProperty("streamIndex");
  });

  it("empty directPlayContainers array -> always direct-stream, regardless of container", () => {
    const device = makeDevice({ directPlayContainers: [] });
    // v1.1 widening (STATE.md H3, docs/PLAYBACK.md §2.1): asf/mpeg/flv/aac/
    // aiff included alongside the original 11 — evaluateContainer is a pure
    // function of (container, directPlayContainers) with no per-member
    // special-casing, so the property holds identically for every closed
    // Container union member, old or new.
    for (const container of [
      "mp4",
      "mkv",
      "webm",
      "avi",
      "ts",
      "mov",
      "flac",
      "mp3",
      "ogg",
      "m4a",
      "wav",
      "asf",
      "mpeg",
      "flv",
      "aac",
      "aiff",
    ] as const) {
      const media = makeMedia({ container });
      const result = evaluateContainer(media, device);
      expect(result.verdict, `container=${container}`).toBe("direct-stream");
      expect(result.reasons, `container=${container}`).toEqual([
        { code: "container-not-direct-playable", detail: `container=${container}` },
      ]);
    }
  });

  it("music containers (no video streams) direct-play when the container is in the device's list", () => {
    const media = makeMedia({ container: "flac", video: [], audio: [makeMedia().audio[0]!] });
    const device = makeDevice({ directPlayContainers: ["flac", "mp3", "m4a", "ogg", "wav"], video: [] });
    expect(evaluateContainer(media, device)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("music containers (no video streams) direct-stream when the container is NOT in the device's list", () => {
    const media = makeMedia({ container: "mp3", video: [], audio: [makeMedia().audio[0]!] });
    const device = makeDevice({ directPlayContainers: ["flac"], video: [] });
    const result = evaluateContainer(media, device);
    expect(result.verdict).toBe("direct-stream");
    expect(result.reasons).toEqual([{ code: "container-not-direct-playable", detail: "container=mp3" }]);
  });

  it("is a pure function of (media.container, device.directPlayContainers) only — video/audio/subtitle content never changes its verdict", () => {
    const device = makeDevice({ directPlayContainers: ["mkv"] });
    const bareMedia = makeMedia({ container: "mkv", video: [], audio: [], subtitle: [] });
    const richMedia = makeMedia({ container: "mkv" });
    expect(evaluateContainer(bareMedia, device)).toEqual(evaluateContainer(richMedia, device));
  });

  it("is deterministic: identical inputs produce a deep-equal result across calls", () => {
    const media = makeMedia({ container: "ts" });
    const device = makeDevice({ directPlayContainers: ["mp4"] });
    const first = evaluateContainer(media, device);
    const second = evaluateContainer(media, device);
    expect(second).toEqual(first);
  });
});
