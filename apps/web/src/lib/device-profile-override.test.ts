// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/device-profile-override.test.ts
//
// d3-a6 (A/v8-requal): the session-create capability payload used to be the
// LIVE probe alone — on a QA rig whose display is SDR (Playwright Chrome),
// the probe says hdr10:false and overrides the deliberately-stored HDR
// device profile from login, so the browser could never exercise the V8
// video-copy plan shape (always the 1080p tone-map plan). The DECISION
// spec'd here: the live probe stays authoritative for every real user (an
// automatic stored-profile-wins rule would let a stale login-time HDR claim
// force an un-tone-mapped HDR10 video-copy onto an SDR panel — the Device
// schema has no marker separating a curated profile from a login-probe
// snapshot, so the rule could not be scoped); instead a DELIBERATE,
// per-browser override (localStorage `loombre.device-profile-override.v1`,
// a JSON merge-patch) is merged ABOVE the probe by the session-create/plan
// payload builders, with the probe filling every gap. No key -> behavior
// byte-identical to before.
//
// Storage/probe edges are injected (this suite's no-vi.mock convention —
// see device-profile.test.ts's ProbeEnv pattern).

import { describe, expect, it } from "vitest";
import type { DeviceProfile } from "./device-profile.js";
import {
  DEVICE_PROFILE_OVERRIDE_KEY,
  mergeDeviceProfileOverride,
  readDeviceProfileOverride,
  resolveSessionDeviceProfile,
} from "./device-profile-override.js";

/** The finding's live-probe shape: SDR display (hdr10:false) but 10-bit
 *  HEVC decode — exactly what Playwright Chrome probes on the QA rig. */
function sdrProbedProfile(): DeviceProfile {
  return {
    profileId: "web-chrome",
    directPlayContainers: ["mp4", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: "high",
        maxLevel: 51,
        maxBitDepth: 8,
        maxWidth: 4096,
        maxHeight: 2160,
        maxFrameRate: 30,
        maxBitrateBps: null,
      },
      {
        codec: "hevc",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [
      { codec: "aac", maxChannels: 2, passthrough: false },
      { codec: "opus", maxChannels: 2, passthrough: false },
    ],
    subtitles: { renderText: ["subrip", "webvtt"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function storageWith(value: string | null): { getItem(key: string): string | null; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getItem(key: string) {
      reads.push(key);
      return value;
    },
  };
}

describe("readDeviceProfileOverride", () => {
  it("returns the parsed patch for a stored JSON object, read from the v1 key", () => {
    const storage = storageWith('{"hdr":{"hdr10":true}}');
    expect(readDeviceProfileOverride(storage)).toEqual({ hdr: { hdr10: true } });
    expect(storage.reads).toEqual([DEVICE_PROFILE_OVERRIDE_KEY]);
  });

  it("returns null when the key is absent", () => {
    expect(readDeviceProfileOverride(storageWith(null))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(readDeviceProfileOverride(storageWith("{not json"))).toBeNull();
  });

  it("returns null for JSON that is not a plain object (array / string / number / null)", () => {
    expect(readDeviceProfileOverride(storageWith("[1,2]"))).toBeNull();
    expect(readDeviceProfileOverride(storageWith('"hdr"'))).toBeNull();
    expect(readDeviceProfileOverride(storageWith("42"))).toBeNull();
    expect(readDeviceProfileOverride(storageWith("null"))).toBeNull();
  });

  it("returns null when storage access throws (blocked localStorage)", () => {
    const storage = {
      getItem() {
        throw new Error("denied");
      },
    };
    expect(readDeviceProfileOverride(storage)).toBeNull();
  });

  it("returns null when no storage exists at all (SSR)", () => {
    expect(readDeviceProfileOverride(null)).toBeNull();
  });
});

describe("mergeDeviceProfileOverride", () => {
  it("merges a nested override above the probe, keeping probed siblings (hdr10 flips, hlg/dolbyVision stay probed)", () => {
    const merged = mergeDeviceProfileOverride(sdrProbedProfile(), { hdr: { hdr10: true } });
    expect(merged.hdr).toEqual({ hdr10: true, hlg: false, dolbyVision: false });
    // Everything not named by the patch is the probe's own answer.
    expect(merged.profileId).toBe("web-chrome");
    expect(merged.video).toEqual(sdrProbedProfile().video);
    expect(merged.audio).toEqual(sdrProbedProfile().audio);
  });

  it("replaces arrays wholesale (no per-element merge)", () => {
    const hdrVideo = [
      {
        codec: "hevc",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 30,
        maxBitrateBps: null,
      },
    ];
    const merged = mergeDeviceProfileOverride(sdrProbedProfile(), { video: hdrVideo });
    expect(merged.video).toEqual(hdrVideo);
  });

  it("assigns scalars and null verbatim (null is a legal DeviceProfile value, never a delete marker)", () => {
    const merged = mergeDeviceProfileOverride(sdrProbedProfile(), {
      profileId: "web-qa-rig",
      maxStreamBitrateBps: 20_000_000,
    });
    expect(merged.profileId).toBe("web-qa-rig");
    expect(merged.maxStreamBitrateBps).toBe(20_000_000);
    const backToNull = mergeDeviceProfileOverride(merged, { maxStreamBitrateBps: null });
    expect(backToNull.maxStreamBitrateBps).toBeNull();
  });

  it("carries unknown keys through verbatim so the server's strict Ajv rejects a typo'd patch LOUDLY (422), never silently no-ops it", () => {
    const merged = mergeDeviceProfileOverride(sdrProbedProfile(), { hdr10: true });
    expect((merged as unknown as Record<string, unknown>)["hdr10"]).toBe(true);
  });

  it("never mutates the probed profile", () => {
    const probed = sdrProbedProfile();
    mergeDeviceProfileOverride(probed, { hdr: { hdr10: true }, video: [] });
    expect(probed).toEqual(sdrProbedProfile());
  });
});

describe("resolveSessionDeviceProfile", () => {
  it("returns the probe result untouched (same reference) when no override is stored — real users' planning is byte-identical", async () => {
    const probed = sdrProbedProfile();
    const resolved = await resolveSessionDeviceProfile(async () => probed, storageWith(null));
    expect(resolved).toBe(probed);
  });

  it("merges a stored HDR override above the SDR probe — the finding's exact shape: the QA rig's payload claims hdr10 + 4K 10-bit HEVC, unlocking the V8 video-copy plan", async () => {
    const override = {
      hdr: { hdr10: true },
      video: [
        {
          codec: "hevc",
          maxProfile: null,
          maxLevel: null,
          maxBitDepth: 10,
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 30,
          maxBitrateBps: null,
        },
      ],
    };
    const resolved = await resolveSessionDeviceProfile(
      async () => sdrProbedProfile(),
      storageWith(JSON.stringify(override)),
    );
    expect(resolved.hdr).toEqual({ hdr10: true, hlg: false, dolbyVision: false });
    expect(resolved.video).toEqual(override.video);
    // Probe still fills every gap the patch does not name.
    expect(resolved.hls).toEqual({ container: "fmp4", supportsFmp4: true, lowLatency: false });
    expect(resolved.audio).toEqual(sdrProbedProfile().audio);
  });

  it("falls back to the probe alone when the stored value is unusable", async () => {
    const probed = sdrProbedProfile();
    const resolved = await resolveSessionDeviceProfile(async () => probed, storageWith("{broken"));
    expect(resolved).toBe(probed);
  });
});
