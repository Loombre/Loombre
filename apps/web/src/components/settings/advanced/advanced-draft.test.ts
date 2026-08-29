// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/advanced/advanced-draft.test.ts
//
// The text ⇄ value edge. The point of these cases is D-5 defect D6: the
// prototype enforced nothing but JSON parseability, so every registry bound
// documented in prose (majorityAgeYears >= 18, the 1–64 range) was
// unenforced. Here every parse goes through the projected JSON Schema.

import { describe, expect, it } from "vitest";
import { parseDraft, summaryText } from "./advanced-draft.js";
import type { AdvancedEntry } from "./advanced-model.js";

function entry(overrides: Partial<AdvancedEntry>): AdvancedEntry {
  return {
    key: "transcode.maxSimultaneousTranscodes",
    category: "transcode",
    categoryLabel: "Transcode",
    description: "How many transcodes may run at once.",
    scope: "ui",
    requiresRestart: false,
    defaultValue: 2,
    valueSchema: { type: "integer", minimum: 1, maximum: 64 },
    locked: false,
    value: 2,
    source: "default",
    widget: "number",
    editable: true,
    modified: false,
    prefix: "transcode.",
    leaf: "maxSimultaneousTranscodes",
    ...overrides,
  } as AdvancedEntry;
}

describe("parseDraft", () => {
  it("accepts a number inside the schema's bounds", () => {
    expect(parseDraft(entry({}), "8")).toEqual({ ok: true, value: 8 });
  });

  it("refuses a number outside them, quoting the bound rather than the prose", () => {
    expect(parseDraft(entry({}), "99")).toEqual({ ok: false, message: "Must be at most 64." });
    expect(parseDraft(entry({}), "0")).toEqual({ ok: false, message: "Must be at least 1." });
  });

  it("refuses a non-numeric or empty draft for a number key", () => {
    expect(parseDraft(entry({}), "abc").ok).toBe(false);
    expect(parseDraft(entry({}), "   ").ok).toBe(false);
  });

  it("enforces the >=18 floor generically — it is just that entry's schema.minimum", () => {
    const age = entry({
      key: "restricted.majorityAgeYears",
      valueSchema: { type: "integer", minimum: 18 },
      leaf: "majorityAgeYears",
    });
    expect(parseDraft(age, "17")).toEqual({ ok: false, message: "Must be at least 18." });
    expect(parseDraft(age, "18")).toEqual({ ok: true, value: 18 });
  });

  it("holds invalid JSON for a structured key with a message, never a value", () => {
    const rungs = entry({
      key: "transcode.ladderRungs",
      widget: "structured",
      valueSchema: { type: "array", items: { type: "object" } },
      value: [],
      defaultValue: [],
      leaf: "ladderRungs",
    });
    expect(parseDraft(rungs, "[{")).toEqual({ ok: false, message: "Invalid JSON — not saved yet." });
    expect(parseDraft(rungs, "[]")).toEqual({ ok: true, value: [] });
    expect(parseDraft(rungs, '{"a":1}')).toEqual({ ok: false, message: "Must be a list." });
  });

  it("passes a string through and still applies its schema", () => {
    const url = entry({ key: "network.publicUrl", widget: "string", valueSchema: { type: "string", minLength: 4 } });
    expect(parseDraft(url, "https://x.test")).toEqual({ ok: true, value: "https://x.test" });
    expect(parseDraft(url, "ab").ok).toBe(false);
  });
});

describe("summaryText", () => {
  it("describes a structured value by shape in the row", () => {
    const rungs = entry({ widget: "structured", value: [{ height: 720 }] });
    expect(summaryText(rungs, [{ height: 720 }])).toBe("1 entry");
    expect(summaryText(rungs, [])).toBe("empty list");
    expect(summaryText(rungs, [1, 2])).toBe("2 entries");
    expect(summaryText(rungs, { a: 1 })).toBe("object");
  });

  it("says 'not set' rather than showing an empty summary button", () => {
    const url = entry({ widget: "string", value: "" });
    expect(summaryText(url, "")).toBe('""');
    expect(summaryText(url, undefined)).toBe("—");
  });
});
