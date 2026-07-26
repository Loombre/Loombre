// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/persistence.spec.ts
//
// Live-DB round-trip for the hardware capability snapshot (migrations/
// 0011_hw_capability_snapshots.sql). Single-owner dev DB per the repo's
// standing policy (STATE.md 2026-07-23 note) — this suite resets the
// schema itself, mirroring every other apps/worker live-DB spec's
// self-sufficient convention.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCurrentHwCapabilitySnapshot, getCurrentVerifiedCapabilities } from "@loombre/db";
import { recordVerifiedCapabilitiesSnapshot } from "@loombre/db/internal";
import { validateVerifiedCapabilities } from "../../src/hwcaps/schema.js";
import { makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

describe("hw_capability_snapshots persistence round-trip", () => {
  const db = makeDb();
  const raw = makeRawClient();

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
  });

  afterAll(async () => {
    await db.destroy();
    await raw.end();
  });

  it("returns null when no snapshot has ever been recorded for a platform", async () => {
    expect(await getCurrentHwCapabilitySnapshot(db, "darwin")).toBeNull();
    expect(await getCurrentVerifiedCapabilities(db, "darwin")).toBeNull();
  });

  it("round-trips a snapshot: platform/fingerprint fields + backends in position order", async () => {
    const { snapshot, backends } = await recordVerifiedCapabilitiesSnapshot(db, {
      platform: "darwin",
      ffmpegBuildHash: "hash-1",
      gpuFingerprint: "gpu-1",
      verifiedAtMs: 1_700_000_000_000,
      backends: [
        { position: 0, backend: "videotoolbox", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["videotoolbox"], verifiedAtMs: 1_700_000_000_001 },
        { position: 1, backend: "software", decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1_700_000_000_002 },
      ],
    });

    expect(snapshot.platform).toBe("darwin");
    expect(snapshot.is_current).toBe(true);
    expect(backends).toHaveLength(2);

    const readBack = await getCurrentHwCapabilitySnapshot(db, "darwin");
    expect(readBack).not.toBeNull();
    expect(readBack!.ffmpegBuildHash).toBe("hash-1");
    expect(readBack!.gpuFingerprint).toBe("gpu-1");
    expect(readBack!.platform).toBe("darwin");
    expect(readBack!.backends.map((b) => b.backend)).toEqual(["videotoolbox", "software"]); // position order preserved
    expect(readBack!.backends[0]!.decode).toEqual(["h264", "hevc"]);
    expect(readBack!.backends[1]!.toneMap).toEqual([]);

    const engineShape = await getCurrentVerifiedCapabilities(db, "darwin");
    expect(engineShape).toEqual({ backends: readBack!.backends });
    // The exact §2.5 shape the shared validator (P3.3 exit-gate item)
    // accepts — a live round trip through real Postgres validates too, not
    // just the in-memory fixtures/synthetic objects.
    expect(validateVerifiedCapabilities(engineShape).valid).toBe(true);
  });

  it("a second snapshot for the SAME platform flips the prior one's is_current false (exactly one current per platform)", async () => {
    await recordVerifiedCapabilitiesSnapshot(db, {
      platform: "darwin",
      ffmpegBuildHash: "hash-2",
      gpuFingerprint: "gpu-2",
      verifiedAtMs: 1_700_000_001_000,
      backends: [{ position: 0, backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1_700_000_001_000 }],
    });

    const { rows } = await raw.query<{ ffmpeg_build_hash: string; is_current: boolean }>(
      `SELECT ffmpeg_build_hash, is_current FROM hw_capability_snapshots WHERE platform = 'darwin' ORDER BY verified_at_ms`,
    );
    expect(rows).toEqual([
      { ffmpeg_build_hash: "hash-1", is_current: false },
      { ffmpeg_build_hash: "hash-2", is_current: true },
    ]);

    const { rows: currentCountRows } = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM hw_capability_snapshots WHERE platform = 'darwin' AND is_current`,
    );
    expect(currentCountRows[0]!.count).toBe("1");

    const current = await getCurrentHwCapabilitySnapshot(db, "darwin");
    expect(current!.ffmpegBuildHash).toBe("hash-2");
  });

  it("a snapshot for a DIFFERENT platform doesn't touch darwin's current row", async () => {
    await recordVerifiedCapabilitiesSnapshot(db, {
      platform: "linux",
      ffmpegBuildHash: "linux-hash",
      gpuFingerprint: "",
      verifiedAtMs: 1_700_000_002_000,
      backends: [{ position: 0, backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1_700_000_002_000 }],
    });

    const darwinCurrent = await getCurrentHwCapabilitySnapshot(db, "darwin");
    expect(darwinCurrent!.ffmpegBuildHash).toBe("hash-2"); // unchanged

    const linuxCurrent = await getCurrentHwCapabilitySnapshot(db, "linux");
    expect(linuxCurrent!.ffmpegBuildHash).toBe("linux-hash");
    expect(linuxCurrent!.gpuFingerprint).toBe("");
  });

  it("an empty backends array persists cleanly (no backends rows, snapshot row still current)", async () => {
    const { snapshot, backends } = await recordVerifiedCapabilitiesSnapshot(db, {
      platform: "win32",
      ffmpegBuildHash: "win-hash",
      gpuFingerprint: "win-gpu",
      verifiedAtMs: 1_700_000_003_000,
      backends: [],
    });
    expect(backends).toEqual([]);
    const current = await getCurrentHwCapabilitySnapshot(db, "win32");
    expect(current!.backends).toEqual([]);
    expect(current!.verifiedAtMs).toBe(snapshot.verified_at_ms);
  });
});
