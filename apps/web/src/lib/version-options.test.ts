// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/version-options.test.ts

import { describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { currentVersionId, versionOptionsFor, versionSwitchHref } from "./version-options.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

function file(overrides: Partial<MediaFileSummary> & { id: string }): MediaFileSummary {
  return {
    versionLabel: null,
    container: "mkv",
    width: 1920,
    height: 1080,
    sizeBytes: 1_000,
    durationMs: 60_000,
    isDefault: false,
    videoCodec: "h264",
    bitDepth: 8,
    hdr: "none",
    audioTracks: [],
    subtitleTracks: [],
    ...overrides,
  };
}

const UHD = file({ id: "f-2160", width: 3840, height: 2160, videoCodec: "vp9", hdr: "hdr10", container: "webm", isDefault: true });
const HD = file({ id: "f-1080" });
const LABELLED = file({ id: "f-cut", versionLabel: "Director's Cut", container: null, videoCodec: null, hdr: null });

describe("versionOptionsFor", () => {
  it("labels by versionLabel, else resolution; details carry codec/HDR/container; the URL's file is current", () => {
    const options = versionOptionsFor([UHD, HD, LABELLED], "f-1080");
    expect(options).toEqual([
      { id: "f-2160", label: "2160p", detail: "VP9 · HDR10 · WEBM", isCurrent: false, isDefault: true },
      { id: "f-1080", label: "1080p", detail: "H.264 · MKV", isCurrent: true, isDefault: false },
      { id: "f-cut", label: "Director's Cut", detail: null, isCurrent: false, isDefault: false },
    ]);
  });

  it("with no ?mediaFileId the DEFAULT file is current (the server's own default), else the first", () => {
    expect(currentVersionId([HD, UHD], undefined)).toBe("f-2160");
    expect(currentVersionId([HD, LABELLED], undefined)).toBe("f-1080");
    expect(versionOptionsFor([HD, UHD], undefined).find((o) => o.isCurrent)?.id).toBe("f-2160");
  });
});

describe("versionSwitchHref", () => {
  it("keeps the URL the source of truth: type hint, the picked file, and the position as whole seconds", () => {
    expect(versionSwitchHref("item-1", "f-1080", { hintType: "episode", positionMs: 754_900 })).toBe("/watch/item-1?type=episode&mediaFileId=f-1080&t=754");
  });

  it("drops a start-of-file position and a missing hint", () => {
    expect(versionSwitchHref("item-1", "f-1080", { positionMs: 1_200 })).toBe("/watch/item-1?mediaFileId=f-1080");
    expect(versionSwitchHref("item-1", "f-1080")).toBe("/watch/item-1?mediaFileId=f-1080");
  });
});
