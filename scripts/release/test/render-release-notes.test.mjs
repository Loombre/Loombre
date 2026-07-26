// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { renderReleaseNotes } from "../lib/render-release-notes.mjs";

test("renderReleaseNotes substitutes every placeholder", () => {
  const out = renderReleaseNotes("# {{LOOMBRE_VERSION}} for {{REPO}} ({{TAG}})", {
    LOOMBRE_VERSION: "0.9.0",
    REPO: "Loombre/Loombre",
    TAG: "v0.9.0",
  });
  assert.equal(out, "# 0.9.0 for Loombre/Loombre (v0.9.0)");
});

test("renderReleaseNotes substitutes repeated occurrences of the same placeholder", () => {
  const out = renderReleaseNotes("{{REPO}} .. {{REPO}}", { REPO: "x/y" });
  assert.equal(out, "x/y .. x/y");
});

test("renderReleaseNotes throws on an unresolved placeholder", () => {
  assert.throws(
    () => renderReleaseNotes("{{LOOMBRE_VERSION}} {{MISSING}}", { LOOMBRE_VERSION: "1.0.0" }),
    /unresolved placeholder.*MISSING/,
  );
});

test("renderReleaseNotes leaves literal ``` fences untouched (no escaping needed)", () => {
  const out = renderReleaseNotes("```\nsome code {{X}}\n```", { X: "y" });
  assert.equal(out, "```\nsome code y\n```");
});
