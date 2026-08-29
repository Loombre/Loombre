// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionCard.test.tsx
//
// REGRESSION GUARD (browser-items-F6, P3): the VERSIONS card must not
// assert a confident "SDR" for a file whose HDR status is genuinely
// unknown. `hdr: null` (no derivable signal — packages/db's
// deriveHdrForDisplay returns null when the stored hdr column is unset AND
// color_transfer gives no HDR evidence either) must render NO SDR/HDR
// segment at all, distinct from `hdr: "none"` (a real probed no-HDR
// verdict), which still renders "SDR". See VersionCard.tsx's hdrLabel()
// doc comment for the null-vs-"none" distinction this guards.

//
// REGRESSION GUARD (LD-18 (rc.6)): one file-path convention, desktop and
// mobile - monospace, word-break: break-all, no line clamp, no ellipsis,
// with a copy button. The filename TAIL must always be fully visible, so
// the old desktop `white-space: nowrap` + `overflow: hidden` +
// `text-overflow: ellipsis` truncation is gone from the stylesheet rather
// than merely overridden inside the mobile @media block. jsdom never
// evaluates imported CSS, so the wrap convention is pinned by reading the
// stylesheet SOURCE (same technique as ld14-mono-scale-conformance.test.ts
// and LibrariesPanel.test.ts).
//
// G3/UD-7/UD-19 (run UIFIX-2026-08-29, W2-B): the `.path` size pin below
// was --mono-sm (9.5px). The run retires --mono-sm/--mono-xs from paint —
// apps/web/.stylelintrc.json's font-size allowed-list omits both tiers, so
// painting one now fails lint — and UD-7 puts "codec/container/path facts"
// on the GLANCED tier, --mono-md (10px). The assertion is repointed there
// deliberately (authority: UD-19); what it pins is unchanged — a path
// stays on the --mono-* scale with the LD-14-conforming muted color, never
// drifting onto --text-* or onto a subtle/hint color.

import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { VersionCard } from "./VersionCard.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

function makeFile(overrides: Partial<MediaFileSummary> = {}): MediaFileSummary {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    versionLabel: null,
    container: "mkv",
    width: 3840,
    height: 2160,
    sizeBytes: 6_400_000_000,
    durationMs: 6_480_000,
    videoCodec: "hevc",
    bitDepth: 10,
    ...overrides,
  };
}

describe("VersionCard hdr display (browser-items-F6)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it('omits the HDR/SDR segment entirely when hdr is null (no derivable signal) — does NOT assert "SDR"', () => {
    const file = makeFile({ hdr: null });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).not.toContain("SDR");
    expect(view.container.textContent).toContain("HEVC");
  });

  it('renders "SDR" for a real, probed hdr: "none" verdict', () => {
    const file = makeFile({ hdr: "none" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("SDR");
  });

  it('renders "HDR10" for hdr: "hdr10" (e.g. deriveHdrForDisplay reading a PQ color_transfer back)', () => {
    const file = makeFile({ hdr: "hdr10" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("HDR10");
    expect(view.container.textContent).not.toContain("SDR");
  });

  it('renders "Dolby Vision" for hdr: "dv"', () => {
    const file = makeFile({ hdr: "dv" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("Dolby Vision");
  });
});

// ── LD-18 (rc.6): file paths wrap on BOTH platforms, with a copy button ──

/** 137 chars — comfortably past the ~120-char width at which the old
 *  desktop `text-overflow: ellipsis` ate the filename tail. */
const LONG_PATH =
  "/Volumes/Media Archive/Movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p HDR10 HEVC TrueHD Atmos 7.1 - REMUX.mkv";

/** Declarations only — `/* … *\/` comments stripped, so prose ABOUT a rule
 *  (e.g. a comment naming `@media` or `text-overflow`) can never satisfy or
 *  trip an assertion about the rule itself. */
const versionCardCss = readFileSync(
  nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "VersionCard.module.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The BASE `.path` rule (column-0 selector), not the one that used to live
 *  nested inside the mobile `@media` block. */
function basePathRule(css: string): string {
  const match = /^\.path\s*\{([^}]*)\}/m.exec(css);
  expect(match, "VersionCard.module.css must declare a top-level `.path` rule").not.toBeNull();
  return match![1]!;
}

describe("VersionCard file path wrapping (LD-18 (rc.6))", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders the COMPLETE path text, filename tail included, for a >120-char path", () => {
    expect(LONG_PATH.length).toBeGreaterThan(120);
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain(LONG_PATH);
    // The tail is the part the old desktop ellipsis destroyed.
    expect(text).toContain("REMUX.mkv");
  });

  it("the base .path rule carries the wrap convention (word-break: break-all, no clamp)", () => {
    const rule = basePathRule(versionCardCss);
    expect(rule).toMatch(/word-break:\s*break-all/);
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/font-family:\s*var\(\s*--font-mono\s*\)/);
  });

  it("the base .path rule has NO ellipsis / overflow-clip / nowrap truncation", () => {
    const rule = basePathRule(versionCardCss);
    expect(rule).not.toMatch(/text-overflow/);
    expect(rule).not.toMatch(/ellipsis/);
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).not.toMatch(/overflow:\s*hidden/);
    expect(rule).not.toMatch(/line-clamp/);
  });

  it("keeps the LD-14-conforming muted color on the --mono-* tier", () => {
    const rule = basePathRule(versionCardCss);
    expect(rule).toMatch(/font-size:\s*var\(\s*--mono-md\s*\)/);
    // UD-7's retired floors may not come back through this rule either.
    expect(rule).not.toMatch(/font-size:\s*var\(\s*--mono-(?:sm|xs)\s*\)/);
    expect(rule).toMatch(/color:\s*var\(\s*--color-text-muted\s*\)/);
  });

  it("the mobile @media block no longer re-declares .path (one convention, not a per-breakpoint override)", () => {
    const mediaAt = versionCardCss.indexOf("@media");
    expect(mediaAt).toBeGreaterThan(-1);
    expect(versionCardCss.slice(mediaAt)).not.toMatch(/\.path\s*\{/);
  });
});

describe("VersionCard file path copy button (LD-18 (rc.6))", () => {
  let view: TestRender | null = null;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText } });
    writeText.mockClear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders a copy button labelled for the action next to the path", () => {
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    expect(view.container.querySelector('button[aria-label="Copy file path"]')).not.toBeNull();
  });

  it("renders NO copy button when the file carries no path", () => {
    view = renderIntoBody(<VersionCard file={makeFile()} />);
    expect(view.container.querySelector('button[aria-label="Copy file path"]')).toBeNull();
  });

  it("copies the EXACT full path string on click", async () => {
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const button = view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(writeText).toHaveBeenCalledWith(LONG_PATH);
  });

  it('swaps to the "Copied" affordance after a successful copy', async () => {
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const button = view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
    expect(button.title).toBe("Copy");
    await act(async () => {
      button.click();
    });
    expect(
      (view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement).title,
    ).toBe("Copied");
  });

  it("does not throw when the clipboard call is denied", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const button = view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    // No assertion beyond "did not throw" — the graceful-catch contract.
  });

  // CommandBlock finding 7: `navigator.clipboard` is entirely ABSENT in a
  // non-secure context (http://<LAN-ip> is this product's normal case).
  it("falls back to selecting the path text when the clipboard API is entirely absent", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const addRange = vi.fn();
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      addRange,
      removeAllRanges,
    } as unknown as Selection);

    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const button = view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(getSelectionSpy).toHaveBeenCalled();
    expect(addRange).toHaveBeenCalled();
    // Filtered by `.title` rather than an attribute selector — the literal
    // "&" trips up jsdom's selector engine on an exact-match value.
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons.some((b) => b.title === "Select & copy")).toBe(true);
    expect(buttons.some((b) => b.title === "Copy")).toBe(false);
    // The path itself is still fully rendered under the fallback.
    expect(view.container.textContent).toContain(LONG_PATH);

    getSelectionSpy.mockRestore();
  });

  it("clears the pending reset timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    view = renderIntoBody(<VersionCard file={makeFile({ path: LONG_PATH })} />);
    const button = view.container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    clearTimeoutSpy.mockClear();

    view.unmount();
    view = null;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
