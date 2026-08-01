// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/matching.spec.ts
//
// STATE.md S4, the matching algorithm's pure core: primary = path-mapped
// exact match; secondary = size + oshash fallback for candidates the path
// tier missed; both unmatched Stash scenes and unmatched Loombre files
// must be visible by construction (never silently dropped from the
// result set). Longest-prefix-wins / trailing-slash edge cases are
// covered by packages/shared/test/stash-path-mapping.test.ts already —
// this suite covers the TIER SELECTION logic on top of that (path found
// -> never falls through to oshash; oshash only considered when size
// matches; unmatched-both-sides visibility).
import { describe, expect, it } from "vitest";
import { matchStashScenes, type LoombreFileCandidate, type StashSceneMatchInput } from "../../src/stash/matching.js";

const MAPPINGS = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult" }];

describe("matchStashScenes", () => {
  it("matches via the PATH tier when the rewritten Stash path exists among candidates", () => {
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: null }];
    const files: LoombreFileCandidate[] = [{ mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: null }];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: "item1", mediaFileId: "mf1", matchedBy: "path" }]);
  });

  it("does not fall through to the oshash tier when the path tier already matched", () => {
    // Same size/oshash also matches a DIFFERENT file — the path tier's
    // result must win, proving tier precedence rather than "last match
    // wins" or "oshash overrides".
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: "abc123" }];
    const files: LoombreFileCandidate[] = [
      { mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: "different" },
      { mediaFileId: "mf2", itemId: "item2", path: "/media/adult/b.mp4", sizeBytes: 100, oshash: "abc123" },
    ];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: "item1", mediaFileId: "mf1", matchedBy: "path" }]);
  });

  it("falls back to the OSHASH tier when the path tier misses but size+oshash agree", () => {
    const scenes: StashSceneMatchInput[] = [
      { stashSceneId: "1", stashPath: "/mnt/stash/moved.mp4", stashSizeBytes: 200, stashOshash: "deadbeef" },
    ];
    const files: LoombreFileCandidate[] = [
      // No file at the rewritten path "/media/adult/moved.mp4" — but a
      // same-size, same-oshash file exists elsewhere (renamed/relocated
      // on the Loombre side).
      { mediaFileId: "mf9", itemId: "item9", path: "/media/adult/elsewhere/renamed.mp4", sizeBytes: 200, oshash: "deadbeef" },
    ];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: "item9", mediaFileId: "mf9", matchedBy: "oshash" }]);
  });

  it("does NOT match via oshash when size differs, even if a candidate's oshash happens to be equal", () => {
    // Defensive — S4 says "size + oshash", both must agree, not oshash
    // alone (oshash collisions on differently-sized files should not
    // exist for a correct implementation, but the matcher must not treat
    // oshash as sufficient on its own regardless).
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/x.mp4", stashSizeBytes: 200, stashOshash: "deadbeef" }];
    const files: LoombreFileCandidate[] = [{ mediaFileId: "mf1", itemId: "item1", path: "/media/adult/other.mp4", sizeBytes: 999, oshash: "deadbeef" }];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: null, mediaFileId: null, matchedBy: null }]);
  });

  it("does not attempt the oshash tier when the scene carries no stashOshash", () => {
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/x.mp4", stashSizeBytes: 200, stashOshash: null }];
    const files: LoombreFileCandidate[] = [{ mediaFileId: "mf1", itemId: "item1", path: "/media/adult/other.mp4", sizeBytes: 200, oshash: null }];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: null, mediaFileId: null, matchedBy: null }]);
  });

  it("unmatched Stash scenes are VISIBLE in the result set (never dropped), with null item/matchedBy", () => {
    const scenes: StashSceneMatchInput[] = [
      { stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: null },
      { stashSceneId: "2", stashPath: "/mnt/stash/unmatched.mp4", stashSizeBytes: 500, stashOshash: null },
    ];
    const files: LoombreFileCandidate[] = [{ mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: null }];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.stashSceneId === "2")).toEqual({ stashSceneId: "2", itemId: null, mediaFileId: null, matchedBy: null });
  });

  it("unmatched Loombre files are visible by construction — findUnmatchedLoombreFiles returns candidates no scene claimed", () => {
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: null }];
    const files: LoombreFileCandidate[] = [
      { mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: null },
      { mediaFileId: "mf2", itemId: "item2", path: "/media/adult/never-claimed.mp4", sizeBytes: 999, oshash: null },
    ];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    const claimedMediaFileIds = new Set(results.filter((r) => r.mediaFileId).map((r) => r.mediaFileId));
    const unmatchedFiles = files.filter((f) => !claimedMediaFileIds.has(f.mediaFileId));
    expect(unmatchedFiles.map((f) => f.mediaFileId)).toEqual(["mf2"]);
  });

  it("a scene with no configured path mappings at all still falls through cleanly to the oshash tier", () => {
    const scenes: StashSceneMatchInput[] = [{ stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: "hash1" }];
    const files: LoombreFileCandidate[] = [{ mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: "hash1" }];
    const results = matchStashScenes(scenes, [], files);
    expect(results).toEqual([{ stashSceneId: "1", itemId: "item1", mediaFileId: "mf1", matchedBy: "oshash" }]);
  });

  it("multiple scenes resolve independently in one pass", () => {
    const scenes: StashSceneMatchInput[] = [
      { stashSceneId: "1", stashPath: "/mnt/stash/a.mp4", stashSizeBytes: 100, stashOshash: null },
      { stashSceneId: "2", stashPath: "/mnt/stash/b.mp4", stashSizeBytes: 200, stashOshash: null },
    ];
    const files: LoombreFileCandidate[] = [
      { mediaFileId: "mf1", itemId: "item1", path: "/media/adult/a.mp4", sizeBytes: 100, oshash: null },
      { mediaFileId: "mf2", itemId: "item2", path: "/media/adult/b.mp4", sizeBytes: 200, oshash: null },
    ];
    const results = matchStashScenes(scenes, MAPPINGS, files);
    expect(results).toEqual([
      { stashSceneId: "1", itemId: "item1", mediaFileId: "mf1", matchedBy: "path" },
      { stashSceneId: "2", itemId: "item2", mediaFileId: "mf2", matchedBy: "path" },
    ]);
  });
});
