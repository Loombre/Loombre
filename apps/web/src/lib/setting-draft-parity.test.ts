// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/setting-draft-parity.test.ts
//
// d3-e7 (G/settingfield-dirty-nonbool): kind-specific "is this draft still
// the loaded value?" — see setting-draft-parity.ts's header for why each
// kind needs its own comparison and why the safe answer is always `false`.

import { describe, expect, it } from "vitest";
import { isSettingDraftAtValue } from "./setting-draft-parity.js";

describe("isSettingDraftAtValue — boolean", () => {
  it("compares the checkbox against the loaded truthiness", () => {
    expect(isSettingDraftAtValue({ kind: "boolean", checked: true }, true)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "boolean", checked: false }, true)).toBe(false);
    // Boolean(value) is what the widget itself seeds from.
    expect(isSettingDraftAtValue({ kind: "boolean", checked: false }, undefined)).toBe(true);
  });
});

describe("isSettingDraftAtValue — enum", () => {
  it("is identity on the selected token", () => {
    expect(isSettingDraftAtValue({ kind: "enum", selected: "tier-gated" }, "tier-gated")).toBe(true);
    expect(isSettingDraftAtValue({ kind: "enum", selected: "always" }, "tier-gated")).toBe(false);
  });

  it("mirrors the widget's own seed for a non-string loaded value (empty selection)", () => {
    expect(isSettingDraftAtValue({ kind: "enum", selected: "" }, null)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "enum", selected: "always" }, null)).toBe(false);
  });
});

describe("isSettingDraftAtValue — number", () => {
  it("compares numerically, not textually — re-typed formatting is still the same number", () => {
    expect(isSettingDraftAtValue({ kind: "number", text: "1" }, 1)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "number", text: "1.0" }, 1)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "number", text: " 1 " }, 1)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "number", text: "1e3" }, 1000)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "number", text: "2" }, 1)).toBe(false);
  });

  it("an empty, blank, or unparseable draft is never parity — Save must stay reachable", () => {
    expect(isSettingDraftAtValue({ kind: "number", text: "" }, 0)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "number", text: "   " }, 0)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "number", text: "abc" }, 0)).toBe(false);
  });

  it("refuses to claim parity against a loaded value that is not a number at all", () => {
    expect(isSettingDraftAtValue({ kind: "number", text: "5" }, "5")).toBe(false);
    expect(isSettingDraftAtValue({ kind: "number", text: "5" }, null)).toBe(false);
  });
});

describe("isSettingDraftAtValue — string", () => {
  it("is exact string comparison, using the widget's own String(value ?? '') seed", () => {
    expect(isSettingDraftAtValue({ kind: "string", text: "hls" }, "hls")).toBe(true);
    expect(isSettingDraftAtValue({ kind: "string", text: "hls " }, "hls")).toBe(false);
    expect(isSettingDraftAtValue({ kind: "string", text: "" }, null)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "string", text: "" }, undefined)).toBe(true);
  });
});

describe("isSettingDraftAtValue — structured (JSON)", () => {
  const loaded = [{ heightPx: 1080, codec: "h264" }];

  it("ignores whitespace and indentation — the same document reformatted is not a change", () => {
    expect(isSettingDraftAtValue({ kind: "structured", text: JSON.stringify(loaded) }, loaded)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "structured", text: JSON.stringify(loaded, null, 2) }, loaded)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "structured", text: '[ {  "heightPx" : 1080 , "codec" : "h264" } ]' }, loaded)).toBe(true);
  });

  it("ignores object key ORDER but not array order — deep equality, not string equality", () => {
    expect(isSettingDraftAtValue({ kind: "structured", text: '[{"codec":"h264","heightPx":1080}]' }, loaded)).toBe(true);
    expect(isSettingDraftAtValue({ kind: "structured", text: '[{"heightPx":1080,"codec":"h264"},{"heightPx":720,"codec":"h264"}]' }, loaded)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: "[1,2]" }, [2, 1])).toBe(false);
  });

  it("sees a real edit anywhere in the tree", () => {
    expect(isSettingDraftAtValue({ kind: "structured", text: '[{"heightPx":720,"codec":"h264"}]' }, loaded)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: '[{"heightPx":1080}]' }, loaded)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: '[{"heightPx":1080,"codec":"h264","extra":null}]' }, loaded)).toBe(false);
  });

  it("distinguishes null from a missing key, and 1 from '1'", () => {
    expect(isSettingDraftAtValue({ kind: "structured", text: '{"a":null}' }, {})).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: '{"a":1}' }, { a: "1" })).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: "null" }, null)).toBe(true);
  });

  it("unparseable JSON is never parity", () => {
    expect(isSettingDraftAtValue({ kind: "structured", text: "{ not json" }, loaded)).toBe(false);
    expect(isSettingDraftAtValue({ kind: "structured", text: "" }, loaded)).toBe(false);
  });
});
