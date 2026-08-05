// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { canonicalizePathForMatch, rewriteStashPath, type StashPathMapping } from "../src/stash-path-mapping.js";

describe("rewriteStashPath (STATE.md S4/K10 — path-mapping match primary)", () => {
  it("rewrites a path under a single configured prefix", () => {
    const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult" }];
    expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
  });

  it("returns null when no configured prefix matches", () => {
    const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult" }];
    expect(rewriteStashPath("/mnt/other/foo.mp4", mappings)).toBeNull();
  });

  it("returns null for an empty mapping list", () => {
    expect(rewriteStashPath("/mnt/stash/foo.mp4", [])).toBeNull();
  });

  it("matches a path that is EXACTLY the prefix (no trailing remainder)", () => {
    const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult" }];
    expect(rewriteStashPath("/mnt/stash", mappings)).toBe("/media/adult");
  });

  it("does NOT match a sibling directory that merely shares a string prefix (segment-boundary rule)", () => {
    // "/mnt/stash2/foo.mp4" must not match the "/mnt/stash" prefix — a
    // naive `.startsWith()` would incorrectly match here.
    const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult" }];
    expect(rewriteStashPath("/mnt/stash2/foo.mp4", mappings)).toBeNull();
  });

  describe("longest-prefix-wins", () => {
    it("picks the more specific (longer) of two overlapping prefixes", () => {
      const mappings: StashPathMapping[] = [
        { stashPrefix: "/mnt/stash", loombrePrefix: "/media/general" },
        { stashPrefix: "/mnt/stash/scenes", loombrePrefix: "/media/adult/scenes" },
      ];
      expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
      // A path under the shorter prefix only still resolves via that one.
      expect(rewriteStashPath("/mnt/stash/other/foo.mp4", mappings)).toBe("/media/general/other/foo.mp4");
    });

    it("is independent of array order — longer prefix wins regardless of position", () => {
      const mappings: StashPathMapping[] = [
        { stashPrefix: "/mnt/stash/scenes", loombrePrefix: "/media/adult/scenes" },
        { stashPrefix: "/mnt/stash", loombrePrefix: "/media/general" },
      ];
      expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
    });
  });

  describe("trailing-slash handling", () => {
    it("a configured prefix WITH a trailing slash still matches correctly", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash/", loombrePrefix: "/media/adult" }];
      expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
    });

    it("a configured loombrePrefix WITH a trailing slash does not double-slash the rewritten path", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash", loombrePrefix: "/media/adult/" }];
      expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
    });

    it("both prefixes carrying trailing slashes still normalize cleanly", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/stash/", loombrePrefix: "/media/adult/" }];
      expect(rewriteStashPath("/mnt/stash/scenes/foo.mp4", mappings)).toBe("/media/adult/scenes/foo.mp4");
    });
  });

  describe("case handling (explicit, documented decision: case-SENSITIVE)", () => {
    it("does not match when the case differs — a case-sensitive filesystem could hold two distinct paths", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/Stash", loombrePrefix: "/media/adult" }];
      expect(rewriteStashPath("/mnt/stash/foo.mp4", mappings)).toBeNull();
    });

    it("matches when case is identical", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "/mnt/Stash", loombrePrefix: "/media/adult" }];
      expect(rewriteStashPath("/mnt/Stash/foo.mp4", mappings)).toBe("/media/adult/foo.mp4");
    });
  });

  describe("Windows-style Stash paths (backslash normalization)", () => {
    it("normalizes backslashes in both the configured prefix and the input path", () => {
      const mappings: StashPathMapping[] = [{ stashPrefix: "C:\\Stash\\Videos", loombrePrefix: "/media/adult" }];
      expect(rewriteStashPath("C:\\Stash\\Videos\\scene.mp4", mappings)).toBe("/media/adult/scene.mp4");
    });
  });

  it("ignores a mapping with an empty stashPrefix (never matches, never crashes)", () => {
    const mappings: StashPathMapping[] = [{ stashPrefix: "", loombrePrefix: "/media/adult" }];
    expect(rewriteStashPath("/mnt/stash/foo.mp4", mappings)).toBeNull();
  });
});

describe("canonicalizePathForMatch (separator-agnostic equality for the Loombre candidate side)", () => {
  it("normalizes native Windows backslashes to forward slashes so a stored path matches a rewriteStashPath result", () => {
    // Loombre stores media_files.path with NATIVE separators (the scanner
    // records walked.absPath verbatim), so a Windows server holds '\'-
    // separated paths — while rewriteStashPath always emits '/'. The
    // candidate side must be canonicalized to the same convention before the
    // equality check, or the path tier never matches on Windows.
    expect(canonicalizePathForMatch("D:\\Media\\Adult\\a.mp4")).toBe("D:/Media/Adult/a.mp4");
  });

  it("leaves an already-POSIX path untouched (idempotent on the common case)", () => {
    expect(canonicalizePathForMatch("/media/adult/a.mp4")).toBe("/media/adult/a.mp4");
  });

  it("agrees with rewriteStashPath's output for the same file across separator conventions", () => {
    // The invariant the two comparison sites rely on: a Windows-native
    // candidate path, once canonicalized, equals the rewrite of the Stash
    // scene that points at the same file.
    const mappings: StashPathMapping[] = [{ stashPrefix: "/stash-media", loombrePrefix: "D:\\Media\\Adult" }];
    const rewritten = rewriteStashPath("/stash-media/a.mp4", mappings);
    expect(canonicalizePathForMatch("D:\\Media\\Adult\\a.mp4")).toBe(rewritten);
  });

  it("does not fold case (preserves the module's deliberate case-sensitivity)", () => {
    expect(canonicalizePathForMatch("D:\\Media\\A.mp4")).toBe("D:/Media/A.mp4");
    expect(canonicalizePathForMatch("D:\\Media\\A.mp4")).not.toBe("d:/media/a.mp4");
  });
});
