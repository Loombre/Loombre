// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/music-tag-first.spec.ts
//
// Music is TAG-FIRST (STATE.md P1.4, docs/PLAN.md §8.1) — this suite
// proves both halves of that rule:
//   1. `readTagsWithMusicMetadata` (src/scan/music-tags.ts) correctly reads
//      real embedded ID3 tags via a real ffmpeg-authored mp3 (skips
//      cleanly without ffmpeg, mirroring test/probe/probe.integration.spec.ts's
//      convention).
//   2. The scanner (src/scan/scanner.ts) prefers tags over filename parsing
//      when tags are present, and falls back to parseMusicPath when the
//      injectable TagReader seam returns null (missing/unreadable tags) —
//      exercised via the fake tag-reader seam, no real audio file needed
//      for this half.

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTagsWithMusicMetadata, type TagReader, type ParsedTags } from "../../src/scan/music-tags.js";
import { runScan } from "../../src/scan/scanner.js";
import { createHashPool, type HashPool } from "../../src/scan/identity/pool.js";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";
import { createLibrary, makeDb, makeMemoryQueue, makeRawClient, makeTmpLibraryDir, resetSchema, writeFakeMediaFile } from "./helpers.js";

const ffmpegAvailable = ffmpegAvailableStrict();

describe.skipIf(!ffmpegAvailable)("readTagsWithMusicMetadata (real ffmpeg-tagged mp3)", () => {
  const dir = makeTmpLibraryDir("tags-real");
  const mp3Path = join(dir, "tagged.mp3");

  beforeAll(() => {
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg.ok) return;
    execFileSync(
      ffmpeg.binary.path,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        "-id3v2_version",
        "3",
        "-metadata",
        "title=Test Track",
        "-metadata",
        "artist=Test Artist",
        "-metadata",
        "album=Test Album",
        "-metadata",
        "track=3",
        mp3Path,
      ],
      { stdio: "ignore" }
    );
  }, 30_000);

  it("reads back the embedded title/artist/album/track tags", async () => {
    expect(existsSync(mp3Path)).toBe(true);
    const tags = await readTagsWithMusicMetadata(mp3Path);
    expect(tags).not.toBeNull();
    expect(tags?.title).toBe("Test Track");
    expect(tags?.artist).toBe("Test Artist");
    expect(tags?.album).toBe("Test Album");
    expect(tags?.trackNumber).toBe(3);
  });

  it("returns null (not a throw) for a non-audio file", async () => {
    const junkPath = join(dir, "not-audio.mp3");
    writeFakeMediaFile(junkPath, "definitely not an mp3", 64);
    const tags = await readTagsWithMusicMetadata(junkPath);
    expect(tags).toBeNull();
  });
});

describe("scanner tag-first precedence (fake TagReader seam)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("tag-first-scan");
    libraryId = await createLibrary(raw, { name: "Tag First Library", mediaKind: "music", paths: [libraryDir] });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("prefers tags over the filename when the tag reader returns usable tags, even if the filename parses to something different", async () => {
    // Filename would parse (via parseMusicPath) to trackNumber 1, title
    // "Filename Title" with no artist/album context (flat directory) — the
    // fake tag reader below returns COMPLETELY different values, and the
    // resulting catalog item must reflect the TAGS, proving tag-first.
    const filePath = join(libraryDir, "01 Filename Title.mp3");
    writeFakeMediaFile(filePath, "tag-first-1", 128);

    const fakeTags: ParsedTags = {
      artist: "Tagged Artist",
      album: "Tagged Album",
      discNumber: 1,
      trackNumber: 9,
      title: "Tagged Title",
    };
    const tagReader: TagReader = async (absPath) => (absPath === filePath ? fakeTags : null);

    const { queue } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue, hashPool, tagReader },
      { libraryId, full: true },
      { jobId: "018f0000-0000-7000-8000-00000000aaa1" }
    );

    const artistRow = await raw.query<{ id: string; title: string }>(
      "SELECT id, title FROM catalog_items WHERE item_type = 'artist' AND library_id = $1",
      [libraryId]
    );
    expect(artistRow.rows.map((r) => r.title)).toContain("Tagged Artist");

    const trackRow = await raw.query<{ track_number: number; title: string }>(
      `SELECT td.track_number, ci.title FROM catalog_items ci
       JOIN track_details td ON td.item_id = ci.id
       WHERE ci.library_id = $1 AND ci.item_type = 'track'`,
      [libraryId]
    );
    expect(trackRow.rows).toHaveLength(1);
    expect(trackRow.rows[0]!.title).toBe("Tagged Title");
    expect(trackRow.rows[0]!.track_number).toBe(9);
  });

  it("falls back to parseMusicPath when the tag reader returns null (missing/unreadable tags)", async () => {
    const artistDir = join(libraryDir, "Fallback Artist", "Fallback Album");
    const filePath = join(artistDir, "02 Fallback Title.mp3");
    writeFakeMediaFile(filePath, "tag-first-2", 128);

    const tagReader: TagReader = async () => null; // simulates missing/unreadable tags

    const { queue } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue, hashPool, tagReader },
      { libraryId, full: false },
      { jobId: "018f0000-0000-7000-8000-00000000aaa2" }
    );

    const trackRow = await raw.query<{ track_number: number; title: string }>(
      `SELECT td.track_number, ci.title FROM catalog_items ci
       JOIN track_details td ON td.item_id = ci.id
       WHERE ci.library_id = $1 AND ci.item_type = 'track' AND ci.title = 'Fallback Title'`,
      [libraryId]
    );
    expect(trackRow.rows).toHaveLength(1);
    expect(trackRow.rows[0]!.track_number).toBe(2);

    const artistRow = await raw.query<{ title: string }>(
      "SELECT title FROM catalog_items WHERE item_type = 'artist' AND library_id = $1 AND title = 'Fallback Artist'",
      [libraryId]
    );
    expect(artistRow.rows).toHaveLength(1);
  });
});
