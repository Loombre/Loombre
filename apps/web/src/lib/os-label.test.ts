// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/os-label.test.ts
//
// AUD-A4v4-005: OS names are proper nouns — a CSS text-transform:
// capitalize cannot express "macOS" and rendered "Macos" on three
// diagnostic panels (Settings > About, /admin/system System card and
// Capabilities card). The label map is the fix; capitalize is dropped.

import { describe, expect, it } from "vitest";
import { formatOsLabel } from "./os-label.js";

describe("formatOsLabel", () => {
  it.each([
    ["macos", "macOS"], // Apple's own capitalization — the case CSS capitalize gets wrong
    ["linux", "Linux"],
    ["windows", "Windows"],
  ] as const)("%s -> %s", (raw, label) => {
    expect(formatOsLabel(raw)).toBe(label);
  });

  it("passes an unknown value through unchanged rather than guessing a capitalization", () => {
    expect(formatOsLabel("freebsd")).toBe("freebsd");
  });
});
