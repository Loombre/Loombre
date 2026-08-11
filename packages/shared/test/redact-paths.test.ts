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
//
// F1/F4: the redact-ALL shapes live in a SHARED golden-vector fixture
// (test/fixtures/redact-path-vectors.json) consumed BOTH here and by
// packages/jobs's redactAllPaths unit suite, so a future divergence
// between the two package-local copies of this matcher is caught. The
// ADVERSARIAL block below (UNC, glued-prefix, quoted/JSON file://,
// space-containing bare, same-line frame+message) is the M-7 completeness
// hardening: each shape leaked verbatim before the matcher was widened.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSlashes, redactPathsInText, stripFileUrlPrefix } from "../src/redact-paths.js";

const REDACT_ALL = () => true;
const REDACT_NONE = () => false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RedactVector {
  name: string;
  input: string;
  expected: string;
}

const { vectors } = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "redact-path-vectors.json"), "utf8"),
) as { vectors: RedactVector[] };

describe("redactPathsInText — shared golden-vector fixture (F4: byte-for-byte identical to packages/jobs's redactAllPaths)", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(redactPathsInText(vector.input, REDACT_ALL)).toBe(vector.expected);
    });
  }
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

  it("a shouldRedact that keeps a space-containing bare path leaves it FULLY intact — the widened matcher captures the whole path (no truncated-tail leak) so the predicate sees, and can keep, all of it", () => {
    // The widened bare-path matcher spans internal spaces up to the final
    // basename; a predicate returning false must therefore leave the ENTIRE
    // path (directory structure included), not a truncated head, exactly as-is.
    const input = "scan failed: /data/My Movies/film.mkv not found";
    expect(redactPathsInText(input, REDACT_NONE)).toBe(input);
  });
});

describe("selective-predicate parity with apps/worker's dataDir-aware redactPaths (the widened matcher must not regress the 'inside dataDir, leave intact' behavior)", () => {
  // A stand-in for apps/worker/src/crash/redact.ts's isInsideDataDir: the
  // exact predicate shape redactPathsInText is driven with in production.
  // The dataDir deliberately CONTAINS A SPACE ("App Support"), the precise
  // shape that would break under a space-TRUNCATING bare matcher: a
  // truncated "/root/App" no longer starts-with the dataDir, so it would be
  // wrongly redacted. The widened matcher captures the whole path, so the
  // predicate classifies it correctly and it is left intact.
  const dataDir = "/root/App Support/Loombre";
  const insideDataDir = (path: string): boolean => {
    const norm = normalizeSlashes(stripFileUrlPrefix(path));
    const root = normalizeSlashes(dataDir).replace(/\/+$/, "");
    return norm === root || norm.startsWith(`${root}/`);
  };
  const redactOutsideDataDir = (text: string) => redactPathsInText(text, (path) => !insideDataDir(path));

  it("a parenthesised stack-frame path INSIDE the space-containing dataDir is left byte-for-byte intact", () => {
    const line = "    at Object.func (/root/App Support/Loombre/postgres/superuser.secret:1:1)";
    expect(redactOutsideDataDir(line)).toBe(line);
  });

  it("one line with an INSIDE-dataDir frame AND an OUTSIDE-dataDir trailing message path: frame kept, message path redacted", () => {
    const line = "loaded (/root/App Support/Loombre/plugins/x.js:3:9) then failed reading /home/alex/.ssh/id_rsa";
    expect(redactOutsideDataDir(line)).toBe("loaded (/root/App Support/Loombre/plugins/x.js:3:9) then failed reading <redacted>/id_rsa");
  });

  it("a multi-line stack mixes inside-dataDir (kept) and outside-dataDir (collapsed) frames, spaces and all", () => {
    const stack = [
      "Error: ENOENT",
      "    at inside (/root/App Support/Loombre/postgres/data/base/16384/2610:1:1)",
      "    at outside (/home/alex/My Videos/scanner.js:42:11)",
      "    at /home/alex/My Code/index.js:7:3",
    ].join("\n");
    const redacted = redactOutsideDataDir(stack);
    expect(redacted).toContain("/root/App Support/Loombre/postgres/data/base/16384/2610:1:1"); // inside dataDir, kept
    expect(redacted).toContain("<redacted>/scanner.js:42:11"); // outside, space in dir, collapsed
    expect(redacted).toContain("<redacted>/index.js:7:3"); // outside bare frame, space in dir, collapsed
    expect(redacted).not.toContain("My Videos");
    expect(redacted).not.toContain("My Code");
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
