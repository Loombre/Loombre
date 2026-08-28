// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/player/player-controls-mobile-block.test.ts
//
// LD-22 (rc.6) pin — PlayerControls.module.css has exactly ONE phone-width
// media block, and that block is the designated home for every future phone
// rule in this stylesheet. The player is one responsive tree at every width;
// at <= 767.98px exactly two things differ, one CSS (this block hides the
// volume slider) and one JS (PlayerControls.tsx swaps the chapter popover for
// a BottomSheet). Pinning the block keeps the CSS half discoverable: a second,
// competing `@media (width <= 767.98px)` block elsewhere in the file — the way
// phone rules usually get lost — fails here by construction.
//
// jsdom evaluates no @media and never applies imported CSS, so this reads the
// stylesheet SOURCE directly, the same posture as controls-overlay-stacking
// .test.ts / scrubber-hit-target.test.ts over this very file.
//
// Extraction is brace-matched, NOT the greedy `([\s\S]*)\}\s*$` shape used by
// admin/settings/phosphor-mobile-css.test.ts:27 — that regex is anchored to
// EOF and only works while the mobile block is the last thing in a file. Here
// it is not (`.pickerPopover`, `.capabilityRow` and `.buffering` follow it),
// so a greedy match would silently swallow the rest of the stylesheet and keep
// passing against the wrong text. ld14-mono-scale-conformance.test.ts is the
// sound skeleton this follows instead.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const playerControlsCss = readFileSync(join(here, "PlayerControls.module.css"), "utf8");

/** The shared mobile-breakpoint literal in its CSS range form (tokens.css
 *  "Mobile chrome layout"; PlayerControls.tsx:55 carries the `max-width:`
 *  spelling of the same value for matchMedia). */
const MOBILE_PRELUDE = "@media (width <= 767.98px)";

interface MediaBlock {
  /** Declarations between the block's own braces, children included. */
  body: string;
  /** The run of block comments immediately above the prelude. */
  leadComment: string;
}

/** Every `@media (width <= 767.98px) { ... }` block in `css`, matched by
 *  balanced braces so a trailing rule after the block is never absorbed. */
function mobileBlocks(css: string): MediaBlock[] {
  const found: MediaBlock[] = [];
  for (let at = css.indexOf(MOBILE_PRELUDE); at !== -1; at = css.indexOf(MOBILE_PRELUDE, at + 1)) {
    const open = css.indexOf("{", at + MOBILE_PRELUDE.length);
    if (open === -1) throw new Error(`unterminated ${MOBILE_PRELUDE} at index ${at}`);
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) throw new Error(`unbalanced braces after ${MOBILE_PRELUDE}`);
    found.push({ body: css.slice(open + 1, close), leadComment: leadCommentBefore(css, at) });
  }
  return found;
}

/** Walks back over whitespace from `at` and returns the contiguous run of
 *  block comments directly above it (empty string when there is none). */
function leadCommentBefore(css: string, at: number): string {
  let end = at;
  let comment = "";
  for (;;) {
    while (end > 0 && /\s/.test(css[end - 1]!)) end--;
    if (!css.slice(0, end).endsWith("*/")) return comment;
    const start = css.lastIndexOf("/*", end - 2);
    if (start === -1) return comment;
    comment = css.slice(start, end) + comment;
    end = start;
  }
}

/** Collapses the comment's hard-wrapped runs of whitespace so assertions can
 *  quote a sentence that the source wraps across lines. */
function squish(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The declarations of the FIRST `.name { ... }` rule inside a media body. */
function nestedRule(body: string, className: string): string {
  const match = body.match(new RegExp(String.raw`\.${className}\b[^{]*\{([^{}]*)\}`));
  if (!match) throw new Error(`no .${className} rule in the mobile block`);
  return match[1]!;
}

describe("LD-22 (rc.6): PlayerControls' designated phone-width block", () => {
  it("is the file's one and only mobile media query", () => {
    expect(mobileBlocks(playerControlsCss)).toHaveLength(1);
    // The `max-width:` spelling belongs to the TSX matchMedia copy, never here.
    expect(playerControlsCss).not.toContain("@media (max-width");
  });

  it("hides the volume slider, the one CSS difference at phone widths", () => {
    const [block] = mobileBlocks(playerControlsCss);
    expect(nestedRule(block!.body, "volumeSlider")).toMatch(/display:\s*none\s*;?/);
  });

  it("keeps the 2026-08-27 QA rationale for that one drop", () => {
    const [block] = mobileBlocks(playerControlsCss);
    expect(squish(block!.leadComment)).toContain(
      "the mute toggle stays, and phones control volume with hardware buttons",
    );
  });

  it("carries the designated-home marker, so future phone rules land here", () => {
    const [block] = mobileBlocks(playerControlsCss);
    const comment = squish(block!.leadComment);
    expect(comment).toContain("LD-22 (rc.6)");
    expect(comment).toMatch(/single designated home for phone-width rules/);
    expect(comment).toMatch(/complete axis reset/);
  });
});
