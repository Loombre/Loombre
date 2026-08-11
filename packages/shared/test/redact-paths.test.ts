// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/redact-paths.test.ts
//
// M-7 fix wave (second half): redactPathsInText is the generic
// path-matching machinery lifted out of apps/worker/src/crash/redact.ts
// (whose own test/crash/redact.spec.ts exhaustively covers the
// dataDir-aware WRAPPING behavior — 34 cases, unchanged and still green
// after this lift). This file covers the primitive directly: the
// caller-supplied `shouldRedact` decision is honored exactly (both
// unconditional "redact everything" — packages/jobs's ledger-error use
// case, which has no "trusted root directory" concept at all — and a
// selective predicate), and the stack-frame/quoted/bare-path matching
// rules fire the same way regardless of which decision function drives
// them.

import { describe, expect, it } from "vitest";
import { normalizeSlashes, redactPathsInText, stripFileUrlPrefix } from "../src/redact-paths.js";

const REDACT_ALL = () => true;
const REDACT_NONE = () => false;

describe("redactPathsInText — unconditional redaction (packages/jobs's use case: no trusted root)", () => {
  it("redacts a quoted absolute path to <redacted>/<basename>", () => {
    expect(redactPathsInText(`ENOENT: no such file or directory, open '/data/library/Movies/Film (2020)/movie.mkv'`, REDACT_ALL)).toBe(
      `ENOENT: no such file or directory, open '<redacted>/movie.mkv'`,
    );
  });

  it("redacts a bare unquoted absolute path", () => {
    expect(redactPathsInText("scan failed: staging path /data/staging/incoming-xyz not found", REDACT_ALL)).toBe(
      "scan failed: staging path <redacted>/incoming-xyz not found",
    );
  });

  it("redacts EVERY absolute path in a multi-path message, independently", () => {
    expect(redactPathsInText("rename '/library/old/a.mkv' -> '/library/new/a.mkv' failed", REDACT_ALL)).toBe(
      "rename '<redacted>/a.mkv' -> '<redacted>/a.mkv' failed",
    );
  });

  it("redacts a Windows-style absolute path — the <redacted>/ prefix always uses a forward slash, regardless of the original separator", () => {
    expect(redactPathsInText(`open 'C:\\Users\\alex\\Videos\\movie.mkv' failed`, REDACT_ALL)).toBe(`open '<redacted>/movie.mkv' failed`);
  });

  it("redacts a stack-frame-shaped line (parenthesized form) — same matching rule crash reports use", () => {
    expect(redactPathsInText("    at readFile (/home/alex/app/scanner.js:42:11)", REDACT_ALL)).toBe(
      "    at readFile (<redacted>/scanner.js:42:11)",
    );
  });

  it("leaves relative paths / non-path text untouched", () => {
    expect(redactPathsInText("scan failed: unexpected token at position 12", REDACT_ALL)).toBe("scan failed: unexpected token at position 12");
  });

  it("multi-line text is redacted line by line", () => {
    const input = "first: '/data/a/x.mkv'\nsecond: '/data/b/y.mkv'";
    expect(redactPathsInText(input, REDACT_ALL)).toBe("first: '<redacted>/x.mkv'\nsecond: '<redacted>/y.mkv'");
  });
});

describe("redactPathsInText — the shouldRedact decision is honored exactly", () => {
  it("shouldRedact: () => false leaves every matched path exactly as-is", () => {
    const input = "open '/data/library/movie.mkv' failed";
    expect(redactPathsInText(input, REDACT_NONE)).toBe(input);
  });

  it("a selective predicate redacts only the paths it says to", () => {
    const input = "old '/keep/this/one.mkv' new '/redact/this/one.mkv'";
    const shouldRedact = (path: string) => path.startsWith("/redact");
    expect(redactPathsInText(input, shouldRedact)).toBe("old '/keep/this/one.mkv' new '<redacted>/one.mkv'");
  });

  it("the path passed to shouldRedact is the pre-basename-extraction path (the predicate sees the full path, not just the tail)", () => {
    const seen: string[] = [];
    redactPathsInText("open '/data/library/movie.mkv' failed", (path) => {
      seen.push(path);
      return true;
    });
    expect(seen).toEqual(["/data/library/movie.mkv"]);
  });
});

describe("normalizeSlashes / stripFileUrlPrefix (exported for a caller's own path-classification logic, e.g. apps/worker's isInsideDataDir)", () => {
  it("normalizeSlashes converts backslashes to forward slashes", () => {
    expect(normalizeSlashes("C:\\Users\\alex\\file.txt")).toBe("C:/Users/alex/file.txt");
  });

  it("normalizeSlashes is a no-op for an already-POSIX path", () => {
    expect(normalizeSlashes("/data/library/movie.mkv")).toBe("/data/library/movie.mkv");
  });

  it("stripFileUrlPrefix decodes a percent-encoded file:// URL to a real path", () => {
    expect(stripFileUrlPrefix("file:///Users/alex/App%20Development/x.js")).toBe("/Users/alex/App Development/x.js");
  });

  it("stripFileUrlPrefix passes non-file:// input through unchanged", () => {
    expect(stripFileUrlPrefix("/data/library/movie.mkv")).toBe("/data/library/movie.mkv");
  });

  it("stripFileUrlPrefix never throws on malformed percent-encoding — falls back to the raw string", () => {
    expect(() => stripFileUrlPrefix("file:///bad%")).not.toThrow();
  });
});
