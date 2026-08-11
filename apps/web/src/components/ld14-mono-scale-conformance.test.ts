// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ld14-mono-scale-conformance.test.ts
//
// LD-14/AUD-A4v3-003 (amended design rule, design/phosphor/README.md): the
// AA-exception low-contrast text tiers --color-text-subtle (#61666E, 3.4:1)
// and --color-text-hint (#4A4E55, 2.3:1) may be used on the --text-* scale
// ONLY at --text-xs (12px) and above, and NEVER on the --mono-* scale at all
// — every --mono-* tier (--mono-lg/-md/-sm/-xs = 11/10/9.5/8.5px) sits below
// the 12px floor, so a subtle/hint color there renders at a measured
// 2.34–3.38:1, failing WCAG AA. The conforming replacement is
// --color-text-muted (#9BA0A8, 7.4:1, AA-clean at any size).
//
// SettingField.test.tsx pins this rule for ONE self-flagged pill; this file
// generalizes the SAME CSS-text technique across EVERY component stylesheet,
// so the D-3 sweep (53 declarations, 32 files) cannot silently regress: a
// future rule that sets both a --mono-* font-size and a subtle/hint text
// color in the same block fails here by construction. (jsdom never evaluates
// imported CSS, so this reads the stylesheet SOURCES directly rather than
// asserting computed styles — same posture as SettingField.test.tsx.)

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function moduleCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...moduleCssFiles(full));
    else if (entry.name.endsWith(".module.css")) out.push(full);
  }
  return out;
}

interface RuleBlock {
  selector: string;
  /** Direct declarations only — nested `{ ... }` bodies carved out, so a
   *  media-query wrapper or a nested pseudo-rule is judged on its OWN
   *  declarations, never its children's. */
  direct: string;
}

function ruleBlocks(css: string): RuleBlock[] {
  const blocks: { selector: string; start: number; end: number }[] = [];
  const stack: { selector: string; start: number }[] = [];
  let segStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      const selector = css.slice(segStart, i).trim().split(/[{}]/).pop()!.trim();
      stack.push({ selector, start: i + 1 });
      segStart = i + 1;
    } else if (c === "}") {
      const b = stack.pop();
      if (b) blocks.push({ selector: b.selector, start: b.start, end: i });
      segStart = i + 1;
    } else if (c === ";") {
      segStart = i + 1;
    }
  }
  return blocks.map((b) => {
    // Carve out any block nested strictly inside this one (its full `{...}`).
    let direct = "";
    let cursor = b.start;
    for (const child of blocks) {
      if (child.start > b.start && child.end < b.end && child.start >= cursor) {
        // back up over the child's selector to the previous declaration boundary
        let j = child.start - 1;
        while (j > cursor && css[j] !== ";" && css[j] !== "}") j--;
        direct += css.slice(cursor, j + 1);
        cursor = child.end + 1;
      }
    }
    direct += css.slice(cursor, b.end);
    return { selector: b.selector, direct };
  });
}

const SUBTLE_OR_HINT_COLOR = /var\(\s*--color-text-(?:subtle|hint)\s*\)/;
const MONO_SIZE = /var\(\s*--mono-(?:lg|md|sm|xs)\s*\)/;

describe("LD-14 conformance: no component CSS pairs a subtle/hint text color with a --mono-* font-size", () => {
  const files = moduleCssFiles(__dirname);

  it("finds component stylesheets to scan (guards against an empty walk)", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("no rule sets BOTH a --mono-* size and an AA-exception subtle/hint text color (use --color-text-muted there)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      for (const block of ruleBlocks(css)) {
        if (MONO_SIZE.test(block.direct) && SUBTLE_OR_HINT_COLOR.test(block.direct)) {
          violations.push(`${path.relative(__dirname, file)} :: { ${block.selector.split(/\r?\n/).pop()!.trim()} }`);
        }
      }
    }
    expect(violations, `LD-14 violations (subtle/hint on the --mono-* scale — sweep to --color-text-muted):\n${violations.join("\n")}`).toEqual([]);
  });
});
