// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/spec-doc-drift.spec.ts
//
// sdk-drift-check style, for the generated developer-facing spec document.
// See json-schema-drift.spec.ts's header — same discipline, same reason.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateLppSpecMarkdown } from "../src/generate/spec.js";
import { LPP_SPEC_MARKDOWN_PATH } from "../src/generate/write.js";

describe("spec/lpp-v1.md drift", () => {
  it("matches a fresh regeneration byte-for-byte", () => {
    const committed = readFileSync(LPP_SPEC_MARKDOWN_PATH, "utf8");
    const regenerated = generateLppSpecMarkdown();
    expect(committed).toBe(regenerated);
  });
});
