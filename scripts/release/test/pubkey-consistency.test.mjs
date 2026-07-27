// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/pubkey-consistency.test.mjs
//
// Pure node:test coverage for scripts/release/lib/pubkey-consistency.mjs —
// in-memory fixtures only, no real files, no CI environment (mirrors
// derive-version.test.mjs / embed-public-key.test.mjs's conventions). Run
// via `pnpm scripts:test` or `node --test scripts/release/test/`.
//
// H5 (release-integrity guards against the placeholder minisign key): the
// audit finding was that the old check-pubkey-consistency.mjs only ever
// compared locations to EACH OTHER — five identical placeholders agree
// perfectly, so it would PASS against an all-placeholder tree, and
// docs/install/linux.md wasn't even in its checked list. The tests below
// pin down both fixes: placeholder detection as its own, prior failure
// condition (even when every location agrees), and the docs-wide sweep
// that catches an unwired page.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BEGIN_MARKER,
  END_MARKER,
  FIXED_LOCATIONS,
  OWNER_ACTION,
  PLACEHOLDER_KEY_LINE,
  checkPubkeyConsistency,
  detectPlaceholder,
  extractGeneratedTsKey,
  extractMarkedBlock,
  normalize,
} from "../lib/pubkey-consistency.mjs";

const REAL_KEY_BLOCK =
  "untrusted comment: minisign public key 9EA9BD1D8785E084\nRWSE4IWHHb2pnrgvN8eVIFOOv1vK84f5Zkk8lMtw6t4VlggsYAOj2oA5";

const OTHER_REAL_KEY_BLOCK =
  "untrusted comment: minisign public key DEADBEEFDEADBEEF\nRWTdifferentDifferentDifferentDifferentDifferentDiffere";

const PLACEHOLDER_BLOCK =
  "untrusted comment: PLACEHOLDER — NOT a real key. Generate a real keypair per keys/README.md before any real release; this all-zero key never verifies anything.\n" +
  PLACEHOLDER_KEY_LINE;

function markedBlockDoc(title, keyBlock) {
  return [
    `# ${title}`,
    "",
    "some intro prose",
    "",
    `<!-- ${BEGIN_MARKER} -->`,
    "```",
    keyBlock,
    "```",
    `<!-- ${END_MARKER} -->`,
    "",
    "some trailing prose",
    "",
  ].join("\n");
}

/** The OLD, broken docs/install/linux.md shape: the ``` fence WRAPS the
 *  markers instead of the markers wrapping the fence, so there is no fence
 *  strictly BETWEEN BEGIN_MARKER and END_MARKER. */
function fenceWrapsMarkersDoc(keyBlock) {
  return ["some intro prose", "", "```", `<!-- ${BEGIN_MARKER} -->`, keyBlock, `<!-- ${END_MARKER} -->`, "```", ""].join(
    "\n",
  );
}

function generatedTsDoc(keyBlock) {
  return `// GENERATED\nexport const LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = ${JSON.stringify(`${keyBlock}\n`)};\n`;
}

function rawKeyFile(keyBlock) {
  return `${keyBlock}\n`;
}

function renderLocation(loc, keyBlock) {
  switch (loc.kind) {
    case "raw":
      return rawKeyFile(keyBlock);
    case "markedBlock":
      return markedBlockDoc(loc.label, keyBlock);
    case "generatedTs":
      return generatedTsDoc(keyBlock);
    default:
      throw new Error(`test fixture: unknown kind ${loc.kind}`);
  }
}

/** All five FIXED_LOCATIONS rendered with the same key block, keyed by
 *  label — overrides lets a test swap in a different rendering for one
 *  or more labels. */
function buildFiles(overrides = {}) {
  const files = {};
  for (const loc of FIXED_LOCATIONS) {
    files[loc.label] = loc.label in overrides ? overrides[loc.label] : renderLocation(loc, REAL_KEY_BLOCK);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Unit-level: normalize / extractMarkedBlock / extractGeneratedTsKey /
// detectPlaceholder
// ---------------------------------------------------------------------------

test("normalize: CRLF -> LF and trims surrounding whitespace", () => {
  assert.equal(normalize("a\r\nb\r\n  "), "a\nb");
  assert.equal(normalize("  \n\nfoo\n\n  "), "foo");
});

test("extractMarkedBlock: extracts the single fenced block between markers", () => {
  const doc = markedBlockDoc("t", REAL_KEY_BLOCK);
  assert.equal(extractMarkedBlock(doc, "t"), REAL_KEY_BLOCK);
});

test("extractMarkedBlock: throws a clear, file-naming structural error when markers are missing", () => {
  assert.throws(() => extractMarkedBlock("no markers here", "some/file.md"), /some\/file\.md.*missing or misordered/s);
});

test("extractMarkedBlock: throws a clear, file-naming structural error when the fence WRAPS the markers (old linux.md shape)", () => {
  const doc = fenceWrapsMarkersDoc(REAL_KEY_BLOCK);
  assert.throws(() => extractMarkedBlock(doc, "docs/install/linux.md"), (err) => {
    assert.match(err.message, /docs\/install\/linux\.md/);
    assert.match(err.message, /found 0/);
    assert.match(err.message, /WRAPS the markers/);
    return true;
  });
});

test("extractGeneratedTsKey: decodes the JS string literal", () => {
  const src = generatedTsDoc(REAL_KEY_BLOCK);
  assert.equal(extractGeneratedTsKey(src, "x.ts"), `${REAL_KEY_BLOCK}\n`);
});

test("extractGeneratedTsKey: throws a clear, file-naming structural error when the export is absent", () => {
  assert.throws(() => extractGeneratedTsKey("export const SOMETHING_ELSE = 1;\n", "x.ts"), /x\.ts.*could not find/s);
});

test("detectPlaceholder: true for the all-zero key line even with a non-placeholder-worded comment", () => {
  assert.equal(detectPlaceholder(`untrusted comment: minisign public key 0000000000000000\n${PLACEHOLDER_KEY_LINE}`), true);
});

test("detectPlaceholder: true for the 'PLACEHOLDER' comment signal even if the key body were ever changed", () => {
  assert.equal(detectPlaceholder("untrusted comment: PLACEHOLDER — not real\nRWsomethingNotAllZero"), true);
});

test("detectPlaceholder: false for a real key block", () => {
  assert.equal(detectPlaceholder(REAL_KEY_BLOCK), false);
});

// ---------------------------------------------------------------------------
// checkPubkeyConsistency: the five required scenarios (E-5)
// ---------------------------------------------------------------------------

test("checkPubkeyConsistency: all five locations real and byte-identical -> PASS", () => {
  const verdict = checkPubkeyConsistency({ files: buildFiles() });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("checkPubkeyConsistency: placeholder in one location -> FAIL, message names the file and the owner action", () => {
  const linuxLoc = FIXED_LOCATIONS.find((l) => l.label === "docs/install/linux.md");
  const files = buildFiles({ "docs/install/linux.md": renderLocation(linuxLoc, PLACEHOLDER_BLOCK) });

  const verdict = checkPubkeyConsistency({ files });

  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((p) => p.label === "docs/install/linux.md");
  assert.ok(problem, "expected a problem entry for docs/install/linux.md");
  assert.equal(problem.type, "placeholder");
  // Names the exact file:
  assert.match(problem.message, /docs\/install\/linux\.md/);
  // Names the owner action (verbatim wording from OWNER_ACTION, asserted
  // both directly and via the constant so a future wording tweak in one
  // place can't silently desync from the other):
  assert.ok(problem.message.includes(OWNER_ACTION));
  assert.match(problem.message, /generate the real keypair per keys\/README\.md/);
  assert.match(problem.message, /pnpm embed-public-key/);
});

test("checkPubkeyConsistency: ALL locations holding the placeholder still FAILS (the exact H5 regression — mutual equality alone would have passed this)", () => {
  const files = {};
  for (const loc of FIXED_LOCATIONS) {
    files[loc.label] = renderLocation(loc, PLACEHOLDER_BLOCK);
  }

  const verdict = checkPubkeyConsistency({ files });

  assert.equal(verdict.ok, false);
  const placeholderProblems = verdict.problems.filter((p) => p.type === "placeholder");
  assert.equal(placeholderProblems.length, FIXED_LOCATIONS.length);
  // Every location mutually agrees (all placeholders are byte-identical) —
  // this must NOT also produce spurious "mismatch" problems; placeholder
  // detection is a prior, separate check.
  assert.equal(
    verdict.problems.some((p) => p.type === "mismatch"),
    false,
  );
});

test("checkPubkeyConsistency: all real but one location mismatched -> FAIL", () => {
  const files = buildFiles({
    "scripts/release/release-notes-template.md": renderLocation(
      FIXED_LOCATIONS.find((l) => l.label === "scripts/release/release-notes-template.md"),
      OTHER_REAL_KEY_BLOCK,
    ),
  });

  const verdict = checkPubkeyConsistency({ files });

  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find(
    (p) => p.type === "mismatch" && p.label === "scripts/release/release-notes-template.md",
  );
  assert.ok(problem, "expected a mismatch problem for the disagreeing template");
});

test("checkPubkeyConsistency: marker-with-no-fence (old linux.md shape) -> clear structural error, not a silent pass", () => {
  const linuxLoc = FIXED_LOCATIONS.find((l) => l.label === "docs/install/linux.md");
  const files = buildFiles({ "docs/install/linux.md": fenceWrapsMarkersDoc(REAL_KEY_BLOCK) });
  void linuxLoc;

  const verdict = checkPubkeyConsistency({ files });

  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((p) => p.type === "structural" && p.label === "docs/install/linux.md");
  assert.ok(problem, "expected a structural problem for docs/install/linux.md");
  assert.match(problem.message, /found 0/);
});

test("checkPubkeyConsistency: docs sweep catches a placeholder marker block in an arbitrary (non-fixed) docs path", () => {
  const files = buildFiles();
  const docsSweep = [{ path: "docs/some/other/page.md", content: markedBlockDoc("other page", PLACEHOLDER_BLOCK) }];

  const verdict = checkPubkeyConsistency({ files, docsSweep });

  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((p) => p.label === "docs/some/other/page.md");
  assert.ok(problem, "expected the docs sweep to catch the arbitrary-path placeholder");
  assert.equal(problem.type, "placeholder");
  assert.ok(problem.message.includes(OWNER_ACTION));
});

test("checkPubkeyConsistency: docs sweep is silent on pages with no marker block at all", () => {
  const files = buildFiles();
  const docsSweep = [{ path: "docs/unrelated/page.md", content: "# Unrelated\n\nNothing to see here.\n" }];

  const verdict = checkPubkeyConsistency({ files, docsSweep });

  assert.equal(verdict.ok, true);
});

test("checkPubkeyConsistency: docs sweep skips a path that duplicates a FIXED_LOCATIONS label (already fully checked above)", () => {
  const files = buildFiles();
  // Same label as a fixed location, but deliberately malformed content —
  // if the sweep didn't skip it, this would produce a second, redundant
  // structural-error problem for the very same file.
  const docsSweep = [{ path: "docs/install/linux.md", content: "not even close to the marked shape" }];

  const verdict = checkPubkeyConsistency({ files, docsSweep });

  assert.equal(verdict.ok, true);
});

test("checkPubkeyConsistency: a missing fixed location is reported, not thrown", () => {
  const files = buildFiles();
  delete files["keys/minisign.pub"];

  const verdict = checkPubkeyConsistency({ files });

  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((p) => p.label === "keys/minisign.pub");
  assert.ok(problem);
  assert.equal(problem.type, "missing");
});
