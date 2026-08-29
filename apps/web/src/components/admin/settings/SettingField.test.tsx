// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingField.test.tsx
//
// Phosphor Wave-2 lane L6 conformance evidence (design/phosphor/README.md
// §Screens → Settings tab 7 "Advanced Server" + §Interactions → "Registry
// editing"). Renders the REAL component with REAL-shaped registry fixtures
// (schema/kind/envVar names mirror packages/shared/src/settings-registry.ts
// entries — never prototype fixture strings, per STATE.md U9) and asserts
// DOM state up to but not including the network-triggering Save/Reset
// click itself — this codebase's established convention (see
// lib/playback-session.test.ts's header) is no vi.mock and no fetch
// stubbing; clicking Save would attempt a real apiPut() network call.
// Every assertion here is about LOCAL state (dirty/validation/canSave/
// locked rendering), which never touches the network to compute.
//
// The one exception is the "Reset-to-default dirty-clearing" describe
// block below, which mocks ../../../lib/api-client.js exactly the way
// AccountSection.test.tsx already does for this same codebase — that
// interaction is specifically about what happens to local state AFTER a
// submit resolves, which is unobservable without letting one resolve.
//
// No component test harness exists beyond components/ui/test-render.tsx
// (also this codebase's established convention — no @testing-library/react
// dependency); reused here unchanged.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import type { JsonSchemaLike } from "../../../lib/settings-schema-widget.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// W8 tail (STATE.md's recorded leftover: "Deferred flag: .caution/
// .lockedValue sizes unchanged (outside the three named elements)" — the
// original W8 pass moved .description/.key/.factRow off the sub-14px mono
// micro-scale onto the shared --text-* ladder; these two were the two
// elements it deliberately left alone). Same CSS-text-reading technique
// SegmentedControl.test.tsx's own header established (jsdom never
// evaluates imported CSS — component .module.css imports are stubbed to an
// identity proxy) rather than asserting computed styles.
function ruleFor(css: string, selector: string): string {
  const re = new RegExp(`${selector.replace(/[.[\]="]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const match = re.exec(css);
  expect(match, `expected a ${selector} rule in SettingField.module.css`).not.toBeNull();
  return match![1]!;
}

describe("SettingField.module.css — W8 tail (.caution/.lockedValue onto the type scale)", () => {
  const css = readFileSync(path.join(__dirname, "SettingField.module.css"), "utf8");

  it(".caution (a body-prose caution note, same role as .description) is ONE step below body on the --text-* scale, not two — matches .factRow's own W8 rule, never the old --text-xs", () => {
    const rule = ruleFor(css, ".caution");
    expect(rule).toMatch(/font-size:\s*var\(--text-sm\);/);
    expect(rule).not.toMatch(/font-size:\s*var\(--text-xs\)/);
  });

  it(".lockedValue (the primary readable value in a locked-field display, same role as .key) is bumped onto --text-base like .key was, never left on the --mono-* micro-scale", () => {
    const rule = ruleFor(css, ".lockedValue");
    expect(rule).toMatch(/font-size:\s*var\(--text-base\);/);
    expect(rule).not.toMatch(/font-size:\s*var\(--mono-lg\)/);
  });
});

// LD-14 follow-through (amended design rule, verbatim effect: subtle/hint
// low-contrast text colors are allowed only on --text-* sizes >= 12px, and
// NEVER on --mono-* tiers — every --mono-* tier sits below --text-xs by
// construction, which is what made the OLD "never below --text-xs" wording
// self-contradictory). Self-flagged during that review: .sourcePill/
// .restartPill share ONE badge size — a --mono-* tier — and the "default"
// source variant paired that with --color-text-subtle (the 3.4:1
// accepted-exception hint tier), which the amended rule now forbids
// outright regardless of size. The "environment"/"database" variants use
// --color-warning/--color-accent (full-strength, non-exception colors) so
// they were never implicated.
//
// G3/UD-7/UD-19 (run UIFIX-2026-08-29, W2-B): that shared size WAS
// --mono-xs (8.5px). The run retires --mono-xs/--mono-sm from paint
// altogether — apps/web/.stylelintrc.json's font-size allowed-list omits
// both tiers, so painting one now fails lint — and these pills are badges,
// which UD-7 puts on the GLANCED tier: --mono-md (10px). The assertion
// below is repointed to that, deliberately (the authority is UD-19); what
// it is really pinning is unchanged — one shared badge size across all
// three source pills plus the restart pill, never a per-variant carve-out.
describe("SettingField.module.css — LD-14 sourcePill conformance", () => {
  const css = readFileSync(path.join(__dirname, "SettingField.module.css"), "utf8");

  it("the default-source pill never pairs an AA-exception subtle/hint color with the shared badge size", () => {
    const rule = ruleFor(css, '.sourcePill[data-source="default"]');
    expect(rule).not.toMatch(/color:\s*var\(--color-text-subtle\)/);
    expect(rule).not.toMatch(/color:\s*var\(--color-text-hint\)/);
  });

  it("conforms via --color-text-muted (7.4:1, already clears AA unconditionally — A5's precedent), not by resizing just this one pill off its siblings' shared badge size", () => {
    const rule = ruleFor(css, '.sourcePill[data-source="default"]');
    expect(rule).toMatch(/color:\s*var\(--color-text-muted\);/);
    // The shared badge shape (size/padding/family) stays on ALL THREE
    // source pills — conforming color, not carving out a per-variant size,
    // keeps the environment/database/default trio visually uniform.
    const sharedSizeMatch = /\.sourcePill,\s*\.restartPill\s*\{([^}]*)\}/.exec(css);
    expect(sharedSizeMatch, "expected the shared .sourcePill, .restartPill rule").not.toBeNull();
    expect(sharedSizeMatch![1]).toMatch(/font-size:\s*var\(--mono-md\);/);
    // UD-7's retired floors may not come back through this rule either.
    expect(sharedSizeMatch![1]).not.toMatch(/font-size:\s*var\(--mono-(?:xs|sm)\)/);
  });
});

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type UpdateSettingResponse = components["schemas"]["UpdateSettingResponse"];

const apiPutMock = vi.fn();

// d4-e6: the fake mirrors the real LoombreApiError's SHAPE, not just its
// identity. Every error the SDK throws carries an HTTP `status`, and the
// surfaces now read their copy through `apiErrorCopy` (lib/api-error-
// message.ts), which duck-types that status instead of the class — so a
// fake without one is not a stand-in for anything the app can receive, and
// a test built on it would prove nothing about the real path. 422 is the
// ordinary validation rejection; tests that need another Object.assign it.
class FakeApiError extends Error {
  status = 422;
}

const RESUME_THRESHOLD_DETAIL =
  "transcode.segmentAheadResumeThreshold must be below transcode.segmentAheadTarget (currently 8).";

vi.mock("../../../lib/api-client.js", () => ({
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

const { SettingField } = await import("./SettingField.js");

function noop(_result: UpdateSettingResponse): void {
  // Tests never click Save, so this is never invoked — present only to
  // satisfy SettingField's required prop.
}

// The generated SDK types AdminSettingSchemaEntry.valueSchema as
// `Record<string, never>` (openapi-typescript's projection of the
// contract's bare `type: object` — same quirk settings-schema-widget.ts's
// own asJsonSchema() casts around). Fixtures need the REAL JSON-Schema
// shape z.toJSONSchema actually emits, so this narrows the cast to one
// place rather than repeating an inline `as` at every fixture below.
function valueSchema(shape: JsonSchemaLike): AdminSettingSchemaEntry["valueSchema"] {
  return shape as AdminSettingSchemaEntry["valueSchema"];
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Fixtures mirror REAL packages/shared/src/settings-registry.ts entries
// (key names, envVar names, schema shapes) — U9: never the prototype's
// fixture strings.
const MAX_TRANSCODES_ENTRY: AdminSettingSchemaEntry = {
  key: "transcode.maxSimultaneousTranscodes",
  category: "transcode",
  description: "How many videos this server will convert at the same time.",
  caution: "Setting this too high can overload the server if several videos convert at once.",
  scope: "ui",
  requiresRestart: false,
  envVar: "LOOMBRE_MAX_TRANSCODES",
  default: 1,
  valueSchema: valueSchema({ type: "integer", minimum: 1, maximum: 64 }),
  locked: false,
};

const HEVC_ENTRY: AdminSettingSchemaEntry = {
  key: "transcode.hevcEncodePreferred",
  category: "transcode",
  description: "Prefer HEVC over H.264 when hardware supports it.",
  scope: "ui",
  requiresRestart: false,
  default: true,
  valueSchema: valueSchema({ type: "boolean" }),
  locked: false,
};

const TONE_MAP_ENTRY: AdminSettingSchemaEntry = {
  key: "transcode.allowToneMapCpu",
  category: "transcode",
  description: "Whether Loombre may tone-map HDR on the CPU.",
  scope: "ui",
  requiresRestart: false,
  default: "tier-gated",
  valueSchema: valueSchema({ type: "string", enum: ["always", "never", "tier-gated"] }),
  locked: false,
};

const DATABASE_URL_ENTRY: AdminSettingSchemaEntry = {
  key: "database.url",
  category: "database",
  description: "PostgreSQL connection string.",
  scope: "env-only",
  requiresRestart: true,
  envVar: "DATABASE_URL",
  default: "postgres://loombre:***@localhost:5442/loombre",
  valueSchema: valueSchema({ type: "string" }),
  locked: true,
  lockedBy: "DATABASE_URL",
};

const PINNED_RATE_LOGIN_ENTRY: AdminSettingSchemaEntry = {
  key: "rateLimit.login",
  category: "rateLimit",
  description: "Sign-in attempts per minute before Loombre turns a device away.",
  scope: "ui",
  requiresRestart: false,
  envVar: "LOOMBRE_RATE_LOGIN",
  default: 10,
  valueSchema: valueSchema({ type: "integer", minimum: 1 }),
  locked: true,
  lockedBy: "LOOMBRE_RATE_LOGIN",
};

describe("SettingField — Phosphor registry card fidelity", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiPutMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders the mono key name, source badge, and RESTART badge only when requiresRestart", () => {
    view = renderIntoBody(<SettingField entry={DATABASE_URL_ENTRY} value={DATABASE_URL_ENTRY.default} source="environment" onChanged={noop} />);
    expect(view.container.textContent).toContain("database.url");
    expect(view.container.textContent).toContain("environment");
    expect(view.container.textContent).toContain("RESTART REQUIRED");
  });

  it("does not render a RESTART badge for a requiresRestart:false entry", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
    expect(view.container.textContent).not.toContain("RESTART REQUIRED");
  });

  it("renders the caution text when the entry carries one", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
    expect(view.container.textContent).toContain("Setting this too high can overload the server");
  });

  it("footer shows DEFAULT and PINNABLE for a UI-scoped entry with an envVar — the env var NAME itself no longer sits in this visible row (W13a/D-7: it moved into the info tooltip)", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={2} source="database" onChanged={noop} />);
    expect(view.container.textContent).toContain("DEFAULT");
    expect(view.container.textContent).toContain("1"); // the default value itself
    expect(view.container.textContent).toContain("PINNABLE");
    expect(view.container.textContent).not.toContain("LOOMBRE_MAX_TRANSCODES");
  });

  it("footer omits PINNABLE for an entry with no envVar at all", () => {
    view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
    expect(view.container.textContent).not.toContain("PINNABLE");
  });

  it("footer omits PINNABLE for an env-only entry (it names its env var in the locked caption instead)", () => {
    view = renderIntoBody(<SettingField entry={DATABASE_URL_ENTRY} value={DATABASE_URL_ENTRY.default} source="environment" onChanged={noop} />);
    expect(view.container.textContent).not.toContain("PINNABLE");
    expect(view.container.textContent).toContain("DATABASE_URL");
  });

  describe("env-locked rendering (A8) — padlock, current value, explanation, NO editor", () => {
    it("env-only entry: padlock icon, current (masked) value, and env-only explanation; no Save/Reset controls", () => {
      view = renderIntoBody(<SettingField entry={DATABASE_URL_ENTRY} value="postgres://loombre:***@localhost:5442/loombre" source="environment" onChanged={noop} />);
      const svg = view.container.querySelector('svg[aria-label="Locked"]');
      expect(svg).not.toBeNull();
      expect(view.container.textContent).toContain("postgres://loombre:***@localhost:5442/loombre");
      expect(view.container.textContent).toContain("Env-only setting — never editable here.");
      expect(view.container.querySelectorAll("button").length).toBe(0);
      expect(view.container.querySelectorAll('input[type="number"]').length).toBe(0);
      expect(view.container.querySelectorAll("textarea").length).toBe(0);
    });

    it("ui-scoped entry with an ACTIVE env pin: padlock icon, current pinned value, names the pinning var; no editor", () => {
      view = renderIntoBody(<SettingField entry={PINNED_RATE_LOGIN_ENTRY} value={999} source="environment" onChanged={noop} />);
      expect(view.container.querySelector('svg[aria-label="Locked"]')).not.toBeNull();
      expect(view.container.textContent).toContain("999");
      expect(view.container.textContent).toContain("LOOMBRE_RATE_LOGIN");
      expect(view.container.textContent).toContain("Remove it from the environment and restart to edit here.");
      expect(view.container.querySelectorAll('input[type="number"]').length).toBe(0);
    });

    it("an ordinary editable ui entry renders NO padlock and DOES render an editor", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      expect(view.container.querySelector('svg[aria-label="Locked"]')).toBeNull();
      expect(view.container.querySelectorAll('input[type="number"]').length).toBe(1);
    });
  });

  describe("Registry editing interaction spec (README §Interactions → Registry editing)", () => {
    it("an untouched field at its default: Save disabled, no Reset button rendered", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const buttons = Array.from(view.container.querySelectorAll("button"));
      const save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(true);
      expect(buttons.some((b) => b.textContent?.includes("Reset"))).toBe(false);
    });

    it("a field NOT at its default (e.g. a stored override) shows Reset, even before any edit", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={4} source="database" onChanged={noop} />);
      const buttons = Array.from(view.container.querySelectorAll("button"));
      expect(buttons.some((b) => b.textContent?.includes("Reset"))).toBe(true);
    });

    it("typing marks the field dirty and enables Save; an in-range number enables it, an out-of-range one shows an inline mono error and disables Save", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;

      act(() => setNativeValue(input, "4"));
      let buttons = Array.from(view.container.querySelectorAll("button"));
      let save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(false);
      expect(view.container.textContent).not.toContain("Must be at most");

      act(() => setNativeValue(input, "9999"));
      buttons = Array.from(view.container.querySelectorAll("button"));
      save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(true);
      expect(view.container.textContent).toContain("Must be at most 64");
    });

    it("the number stepper's increment/decrement buttons move the value and mark the field dirty", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const increment = view.container.querySelector('button[aria-label="Increase"]') as HTMLButtonElement;
      act(() => increment.click());
      const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;
      expect(input.value).toBe("2");
      const buttons = Array.from(view.container.querySelectorAll("button"));
      const save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(false);
    });

    it("the stepper never decrements below the schema minimum", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const decrement = view.container.querySelector('button[aria-label="Decrease"]') as HTMLButtonElement;
      act(() => decrement.click());
      const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;
      expect(input.value).toBe("1"); // schema minimum is 1 — clamped, not 0
    });

    it("boolean widget: clicking the row toggles ON/OFF and marks the field dirty", () => {
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      expect(view.container.textContent).toContain("ON");
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      act(() => checkbox.click());
      expect(view.container.textContent).toContain("OFF");
      const buttons = Array.from(view.container.querySelectorAll("button"));
      const save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(false);
    });

    // browser-restricted-settings-F8 (P3, QA sweep 2026-08-20/21): unlike
    // the untouched-at-default case above (Save starts disabled), toggling
    // OFF then back ON set `dirty` unconditionally on every click and never
    // re-checked it against the loaded value — so Save/Reset stayed
    // enabled at value PARITY (boolDraft === value), inviting a no-op
    // write that would flip the setting's source pill from "default" to
    // "database" for zero actual change.
    it("boolean widget: toggling back to the loaded value re-disables Save (no no-op write at value parity)", () => {
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const save = (): HTMLButtonElement => Array.from(view!.container.querySelectorAll("button")).find((b) => b.textContent === "Save")!;

      act(() => checkbox.click()); // true -> false
      expect(save().hasAttribute("disabled")).toBe(false);

      act(() => checkbox.click()); // false -> true, back to the loaded value
      expect(checkbox.checked).toBe(true);
      expect(save().hasAttribute("disabled")).toBe(true);
    });

    it("boolean widget: clicking the ON/OFF label text also toggles, via its OWN onClick — not a row-level handler it bubbles up to", () => {
      // LD-13 hardening: the ON/OFF <span> now carries its own onClick
      // directly (SettingField.tsx) rather than relying on the wrapping
      // row to catch a bubbled click — exactly one handler per interactive
      // target, never a redundant duplicate. This still proves the label
      // itself is clickable and toggles cleanly.
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      const label = Array.from(view.container.querySelectorAll("span")).find((s) => s.textContent === "ON")!;
      act(() => label.click());
      expect(view.container.textContent).toContain("OFF");
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("boolean widget: clicking the switch itself fires exactly one net toggle (LD-13 — no redundant row-level handler duplicating Toggle's own onChange)", () => {
      // opus-review LD wave, Finding 2 — the REAL mechanism (reproduced and
      // confirmed by the review; this replaces an earlier version of this
      // test/comment that could not reproduce a dead switch and wrongly
      // concluded the double invocation was harmless):
      //
      // A real click landing on the switch (its track/thumb, a descendant
      // of Toggle's own <label>, not the row's ON/OFF text) actually
      // reaches the app in TWO separate native click dispatches, not one:
      // the user's own click, AND — synthesized by the browser's native
      // label-to-<input> click-forwarding (HTML spec activation behavior)
      // — a SECOND click on the <input> itself. React 18 flushes discrete
      // click updates at the end of EACH native dispatch, so whatever ran
      // from the first dispatch is already committed by the time the
      // second dispatch's handlers read state. Before the LD-13 hardening
      // fix, the wrapping row ALSO carried onClick={handleBoolToggle},
      // duplicating Toggle's own onChange — so:
      //   - dispatch A (the user's own click, bubbling through the row):
      //     row onClick reads the PRE-click value and commits its flip.
      //   - dispatch B (the label-forwarded click on the <input>): Toggle
      //     onChange AND row onClick (bubbled from this SAME forwarded
      //     click) both read dispatch A's COMMITTED value and each flip it
      //     back.
      // Net effect: false -> true -> false — a SILENT DEAD SWITCH on every
      // click of the switch itself. (Clicking the ON/OFF text worked fine:
      // it fires only ONE dispatch, with no label-forwarding involved.)
      //
      // This test drives that exact two-dispatch/two-flush shape directly,
      // as two SEPARATE act() blocks, rather than dispatching a single
      // click on the track and letting jsdom synthesize the forwarded
      // click as a nested call within that SAME act(): jsdom performs that
      // forwarding synchronously with no yield point, so a single act()
      // around it lets React's batching collapse everything sharing one
      // stale closure — which happens to net the SAME single flip the
      // fixed code produces, passing against BOTH the old buggy wiring and
      // the new correct wiring alike (verified empirically), pinning
      // nothing. Dispatch A below targets the ROW itself directly (outside
      // Toggle's <label> subtree, so no jsdom-native forwarding is
      // triggered as a side effect of this call) — modeling "whatever the
      // user's own click's bubble reaches" in isolation. Dispatch B is
      // `checkbox.click()` — a direct, spec-correct simulation of the
      // label-forwarded click landing on the <input>, as its own separate
      // flush. Verified by temporarily reverting SettingField.tsx's
      // handler split back to the old row-onClick-plus-Toggle-onChange
      // duplication and confirming this exact test goes red (net stays
      // true — the dead switch), then restoring the fix and confirming
      // green (net false — one clean toggle).
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      const boolRow = checkbox.closest("label")!.parentElement!; // Toggle's <label> parent is the row div

      // Dispatch A: the user's own click, landing somewhere in the row
      // outside Toggle's <label> subtree (no native label-forwarding side
      // effect from this call) — its own discrete React flush, committed
      // before dispatch B begins.
      act(() => {
        boolRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      // Dispatch B: the browser's native label-forwarded click, landing
      // directly on the <input> — a SEPARATE discrete dispatch/flush.
      act(() => {
        checkbox.click();
      });

      expect(checkbox.checked).toBe(false); // net ONE toggle, not a self-cancel back to true
      expect(view.container.textContent).toContain("OFF");
    });

    it("boolean widget: clicking empty space in the row (neither the label nor the switch) does NOT toggle — the row itself carries no click handler anymore", () => {
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const boolRow = checkbox.closest("label")!.parentElement!; // Toggle's <label> parent is the row div
      act(() => {
        boolRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(checkbox.checked).toBe(true);
      expect(view.container.textContent).toContain("ON");
    });

    // LD-13 discovery: audited every boolean-typed key actually defined in
    // packages/shared/src/settings-registry.ts (five total, verified via
    // `grep -n "z\\.boolean" settings-registry.ts` at the time of this
    // fix). Fixtures below mirror each entry's real key/scope/envVar shape
    // (U9: never invented fixture strings). Two of the five carry an envVar
    // (restricted.enabled, tls.acmeTosAgreed) and can be legitimately
    // env-pinned; the other three never carry one and must ALWAYS be
    // editable. This sweep is the "genuinely broken vs correctly disabled"
    // discovery this ticket asked for, pinned as a test: every unlocked
    // boolean renders and responds to a click; every actively-locked one
    // renders NO switch at all (the A8 read-only display), which is
    // correct-by-design, not a dead control.
    describe("LD-13 sweep — every real boolean registry key", () => {
      const REAL_BOOLEAN_ENTRIES: AdminSettingSchemaEntry[] = [
        {
          key: "transcode.hevcEncodePreferred",
          category: "transcode",
          description: "Prefer HEVC over H.264 when hardware supports it.",
          scope: "ui",
          requiresRestart: false,
          default: true,
          valueSchema: valueSchema({ type: "boolean" }),
          locked: false,
        },
        {
          key: "images.avifEnabled",
          category: "images",
          description: "Also save each poster/thumbnail as AVIF when this server can create it.",
          scope: "ui",
          requiresRestart: false,
          default: true,
          valueSchema: valueSchema({ type: "boolean" }),
          locked: false,
        },
        {
          key: "security.loginAnomalyLogEnabled",
          category: "security",
          description: "Record suspicious sign-in activity to a local log file.",
          scope: "ui",
          requiresRestart: false,
          default: true,
          valueSchema: valueSchema({ type: "boolean" }),
          locked: false,
        },
        {
          key: "restricted.enabled",
          category: "restricted",
          description: "Turns the restricted-content feature on for this server.",
          scope: "ui",
          requiresRestart: false,
          envVar: "LOOMBRE_RESTRICTED_ENABLED",
          default: false,
          valueSchema: valueSchema({ type: "boolean" }),
          locked: false, // env var unset in this fixture — must be editable
        },
        {
          key: "tls.acmeTosAgreed",
          category: "tls",
          description: "Confirms acceptance of the certificate authority's Terms of Service.",
          scope: "ui",
          requiresRestart: true,
          envVar: "LOOMBRE_ACME_TOS_AGREED",
          default: false,
          valueSchema: valueSchema({ type: "boolean" }),
          locked: false, // env var unset in this fixture — must be editable
        },
      ];

      it.each(REAL_BOOLEAN_ENTRIES)("$key: unlocked renders an interactive switch that responds to a click and enables Save", (entry) => {
        view = renderIntoBody(<SettingField entry={entry} value={entry.default} source="default" onChanged={noop} />);
        const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).not.toBeNull();
        const before = checkbox.checked;
        act(() => checkbox.click());
        expect(checkbox.checked).toBe(!before);
        const buttons = Array.from(view.container.querySelectorAll("button"));
        const save = buttons.find((b) => b.textContent === "Save")!;
        expect(save.hasAttribute("disabled")).toBe(false);
      });

      const PINNABLE_ENTRIES = REAL_BOOLEAN_ENTRIES.filter((e) => e.envVar !== undefined);

      it.each(PINNABLE_ENTRIES)(
        "$key: actively env-pinned renders NO switch at all — the A8 read-only display, correctly non-interactive by design (not a dead control)",
        (entry) => {
          // exactOptionalPropertyTypes forbids `lockedBy: entry.envVar` here
          // even though PINNABLE_ENTRIES is filtered to envVar !== undefined
          // — the filter doesn't narrow the type inside this closure — so
          // spread conditionally rather than assign a `string | undefined`.
          const lockedEntry: AdminSettingSchemaEntry = { ...entry, locked: true, ...(entry.envVar !== undefined ? { lockedBy: entry.envVar } : {}) };
          view = renderIntoBody(<SettingField entry={lockedEntry} value={true} source="environment" onChanged={noop} />);
          expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
          expect(view.container.querySelector('svg[aria-label="Locked"]')).not.toBeNull();
          expect(view.container.textContent).toContain(`Set by environment (${entry.envVar})`);
        },
      );
    });

    // W3-R adjudicated D-3 exception (recorded in STATE.md): registry enum
    // VALUES ("always"/"never"/"tier-gated", "starttls", "http-01", …) ARE
    // the canonical technical config tokens that descriptions, tooltips,
    // env pins, and docs reference verbatim — title-casing them would
    // corrupt the vocabulary ("Http-01"). They render as-is by design;
    // the D-3 title-case rule applies to user-domain enums (media kind,
    // roles — see lib/enum-labels.ts). The old test title falsely claimed
    // an "uppercased" transform that never existed anywhere.
    it("enum widget: renders one segment per schema enum value, VERBATIM (adjudicated D-3 exception for technical config tokens)", () => {
      view = renderIntoBody(<SettingField entry={TONE_MAP_ENTRY} value="tier-gated" source="default" onChanged={noop} />);
      expect(view.container.textContent).toContain("always");
      expect(view.container.textContent).toContain("never");
      expect(view.container.textContent).toContain("tier-gated");
    });

    it("JSON (structured) widget: invalid JSON shows 'Invalid JSON.' and disables Save", () => {
      const ladderEntry: AdminSettingSchemaEntry = {
        key: "transcode.ladderRungs",
        category: "transcode",
        description: "Quality ladder rungs.",
        scope: "ui",
        requiresRestart: false,
        default: [{ heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" }],
        valueSchema: valueSchema({ type: "array", minItems: 1 }),
        locked: false,
      };
      view = renderIntoBody(
        <SettingField entry={ladderEntry} value={ladderEntry.default} source="default" onChanged={noop} />,
      );
      const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
      act(() => setNativeValue(textarea, "{ not valid json"));
      expect(view.container.textContent).toContain("Invalid JSON.");
      const buttons = Array.from(view.container.querySelectorAll("button"));
      const save = buttons.find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(true);
    });
  });

  describe("Readable typography (W8) — the shared classes still carry the expected text, unbroken by the size bump", () => {
    it("key name, description, and the metadata fact row all still render their text content", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      expect(view.container.textContent).toContain("transcode.maxSimultaneousTranscodes");
      expect(view.container.textContent).toContain("How many videos this server will convert at the same time.");
      expect(view.container.textContent).toContain("DEFAULT");
      expect(view.container.textContent).toContain("CURRENT");
      expect(view.container.textContent).toContain("PINNABLE");
    });
  });

  describe("Technical-details info tooltip (W13a, decision D-7 — two-layer copy)", () => {
    it("renders no info trigger at all when the entry has neither an env pin nor caller-supplied technicalDetails", () => {
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      expect(view.container.querySelector('button[aria-label^="Technical details"]')).toBeNull();
    });

    it("a pinnable entry gets an info trigger; the tooltip itself renders on demand only — absent from the DOM until opened, present with the env-pin name once it is", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const trigger = view.container.querySelector('button[aria-label="Technical details for transcode.maxSimultaneousTranscodes"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      expect(view.container.querySelector('[role="tooltip"]')).toBeNull();
      expect(trigger.hasAttribute("aria-describedby")).toBe(false);

      act(() => trigger.focus());
      const tooltip = view.container.querySelector('[role="tooltip"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip!.textContent).toContain("LOOMBRE_MAX_TRANSCODES");
      // a11y wiring: aria-describedby only appears once the described node
      // actually exists, and points at that exact node's id.
      expect(trigger.getAttribute("aria-describedby")).toBe(tooltip!.id);

      act(() => trigger.blur());
      expect(view.container.querySelector('[role="tooltip"]')).toBeNull();
      expect(trigger.hasAttribute("aria-describedby")).toBe(false);
    });

    it("click toggles the tooltip open, then closed again (the touch path, independent of hover/focus)", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const trigger = view.container.querySelector('button[aria-label^="Technical details"]') as HTMLButtonElement;

      act(() => trigger.click());
      expect(view.container.querySelector('[role="tooltip"]')).not.toBeNull();

      act(() => trigger.click());
      expect(view.container.querySelector('[role="tooltip"]')).toBeNull();
    });

    it("Escape dismisses an open tooltip", () => {
      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
      const trigger = view.container.querySelector('button[aria-label^="Technical details"]') as HTMLButtonElement;

      act(() => trigger.click());
      expect(view.container.querySelector('[role="tooltip"]')).not.toBeNull();

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(view.container.querySelector('[role="tooltip"]')).toBeNull();
    });

    it("a caller-supplied technicalDetails prop renders its own trigger even with no env pin at all, and both notes combine when an entry has both", () => {
      view = renderIntoBody(
        <SettingField
          entry={HEVC_ENTRY}
          value={true}
          source="default"
          onChanged={noop}
          technicalDetails="Backed by ffmpeg's hevc_* encoders when the host GPU exposes one."
        />,
      );
      const trigger = view.container.querySelector('button[aria-label^="Technical details"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      act(() => trigger.click());
      expect(view.container.textContent).toContain("Backed by ffmpeg's hevc_* encoders");

      view.unmount();
      view = renderIntoBody(
        <SettingField
          entry={MAX_TRANSCODES_ENTRY}
          value={1}
          source="default"
          onChanged={noop}
          technicalDetails="Applies per transcode session, not per stream."
        />,
      );
      const combinedTrigger = view.container.querySelector('button[aria-label^="Technical details"]') as HTMLButtonElement;
      act(() => combinedTrigger.click());
      expect(view.container.textContent).toContain("Applies per transcode session, not per stream.");
      expect(view.container.textContent).toContain("LOOMBRE_MAX_TRANSCODES");
    });

    it("env-only and actively-locked entries with no envVar of their own still get no trigger by default (locked's own caption already names its pin)", () => {
      view = renderIntoBody(<SettingField entry={DATABASE_URL_ENTRY} value={DATABASE_URL_ENTRY.default} source="environment" onChanged={noop} />);
      expect(view.container.querySelector('button[aria-label^="Technical details"]')).toBeNull();
    });
  });

  describe("Reset-to-default clears dirty (confirmed[31] regression)", () => {
    it("editing a field then clicking Reset clears dirty, so a later external value update is applied instead of frozen", async () => {
      apiPutMock.mockResolvedValue({
        key: MAX_TRANSCODES_ENTRY.key,
        value: MAX_TRANSCODES_ENTRY.default,
        source: "default",
        requiresRestart: false,
        restartPending: false,
      } satisfies UpdateSettingResponse);

      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={4} source="database" onChanged={noop} />);
      const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;

      // Dirty the field mid-edit — README: Reset must be able to discard an
      // in-progress draft, not just revert a stored override.
      act(() => setNativeValue(input, "10"));
      expect(input.value).toBe("10");

      const reset = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Reset"))!;
      await act(async () => {
        reset.click();
      });
      await act(async () => {}); // flush the .then() chained onto submit()'s promise

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      expect(input.value).toBe(String(MAX_TRANSCODES_ENTRY.default));

      // The regression: with `dirty` stuck true, the resync effect's
      // `if (dirty) return;` guard drops every subsequent external value —
      // a live settings.updated refetch, another admin's write, a "reset
      // category" bulk action — and the field is frozen on this local
      // snapshot forever. Once Reset correctly clears dirty, a new `value`
      // prop (standing in for that refetch) must reach the control again.
      view.rerender(<SettingField entry={MAX_TRANSCODES_ENTRY} value={7} source="database" onChanged={noop} />);
      expect((view.container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("7");
    });
  });

  // browser-admin-F5: a rejected save rendered `err.message`, built by the
  // SDK from the RFC 9457 problem TITLE alone, so the cross-field
  // explanation settings.service.ts writes into `detail` never reached the
  // admin — the field just said "Unprocessable Entity".
  describe("browser-admin-F5 — the server's problem detail reaches the field error", () => {
    it("renders the 422 detail sentence, never the bare status title", async () => {
      apiPutMock.mockRejectedValue(
        Object.assign(new FakeApiError("Unprocessable Entity"), {
          problem: {
            type: "about:blank",
            title: "Unprocessable Entity",
            status: 422,
            detail: RESUME_THRESHOLD_DETAIL,
          },
        }),
      );

      view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={4} source="database" onChanged={noop} />);
      const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;
      act(() => setNativeValue(input, "10"));

      const save = Array.from(view.container.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("Save"),
      )!;
      await act(async () => {
        save.click();
      });
      await act(async () => {});

      const text = view.container.textContent ?? "";
      expect(text).toContain(RESUME_THRESHOLD_DETAIL);
      expect(text).not.toContain("Unprocessable Entity");
    });
  });
});

// ---------------------------------------------------------------------------
// d3-e7 (G/settingfield-dirty-nonbool, P3): browser-restricted-settings-F8
// fixed the BOOLEAN editor only — every other kind still latched
// `dirty = true` on each keystroke/segment click and never re-checked the
// draft against the loaded value, so typing away and back left Save and
// Reset enabled with nothing to write. Its own comment named the reason
// ("back to the original text is rare and ambiguous to detect losslessly —
// e.g. re-typing the same number with different formatting"); the parity
// rules now live in lib/setting-draft-parity.ts, one per kind, and that
// exact formatting case is the third test below.
// ---------------------------------------------------------------------------
describe("SettingField — dirty parity across every editable kind (d3-e7)", () => {
  let view: TestRender | null = null;

  const LADDER_ENTRY: AdminSettingSchemaEntry = {
    key: "transcode.ladderRungs",
    category: "transcode",
    description: "Quality ladder rungs.",
    scope: "ui",
    requiresRestart: false,
    default: [{ heightPx: 1080, codec: "h264" }],
    valueSchema: valueSchema({ type: "array", minItems: 1 }),
    locked: false,
  };

  const STAGING_ROOT_ENTRY: AdminSettingSchemaEntry = {
    key: "transcode.stagingRoot",
    category: "transcode",
    description: "Where in-progress transcode segments are staged.",
    scope: "ui",
    requiresRestart: true,
    default: "/var/lib/loombre/transcode",
    valueSchema: valueSchema({ type: "string" }),
    locked: false,
  };

  beforeEach(() => {
    apiPutMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function save(): HTMLButtonElement {
    return Array.from(view!.container.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
  }
  function resetButton(): HTMLButtonElement | undefined {
    return Array.from(view!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Reset"));
  }

  it("number widget: editing away and back to the loaded value re-disables Save", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
    const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;

    act(() => setNativeValue(input, "4"));
    expect(save().hasAttribute("disabled")).toBe(false);

    act(() => setNativeValue(input, "1"));
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("number widget: the same number re-typed with different formatting is not a change (numeric compare, not string compare)", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={4} source="database" onChanged={noop} />);
    const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;

    act(() => setNativeValue(input, "4.0"));
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("number widget: a clamped stepper press that cannot move the value leaves Save disabled", () => {
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
    const decrement = view.container.querySelector('button[aria-label="Decrease"]') as HTMLButtonElement;

    act(() => decrement.click()); // clamped at the schema minimum of 1
    expect((view.container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("1");
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("string widget: typing extra characters and deleting them again re-disables Save", () => {
    view = renderIntoBody(
      <SettingField entry={STAGING_ROOT_ENTRY} value="/var/lib/loombre/transcode" source="default" onChanged={noop} />,
    );
    const input = view.container.querySelector('input[type="text"], input:not([type])') as HTMLInputElement;

    act(() => setNativeValue(input, "/var/lib/loombre/transcode2"));
    expect(save().hasAttribute("disabled")).toBe(false);

    act(() => setNativeValue(input, "/var/lib/loombre/transcode"));
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("enum widget: selecting another token and returning to the loaded one re-disables Save", () => {
    view = renderIntoBody(<SettingField entry={TONE_MAP_ENTRY} value="tier-gated" source="default" onChanged={noop} />);
    const segment = (label: string): HTMLButtonElement =>
      Array.from(view!.container.querySelectorAll('button[role="radio"]')).find((b) => b.textContent === label) as HTMLButtonElement;

    act(() => segment("always").click());
    expect(save().hasAttribute("disabled")).toBe(false);

    act(() => segment("tier-gated").click());
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("JSON widget: reformatting the same document (whitespace, key order) is not a change", () => {
    view = renderIntoBody(<SettingField entry={LADDER_ENTRY} value={LADDER_ENTRY.default} source="default" onChanged={noop} />);
    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;

    act(() => setNativeValue(textarea, '[{"heightPx":720,"codec":"h264"}]'));
    expect(save().hasAttribute("disabled")).toBe(false);

    act(() => setNativeValue(textarea, '[ { "codec" : "h264" , "heightPx" : 1080 } ]'));
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("a real edit still enables Save on every kind — parity must not swallow genuine changes", () => {
    view = renderIntoBody(<SettingField entry={LADDER_ENTRY} value={LADDER_ENTRY.default} source="default" onChanged={noop} />);
    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setNativeValue(textarea, '[{"heightPx":1080,"codec":"hevc"}]'));
    expect(save().hasAttribute("disabled")).toBe(false);
  });

  it("Reset withdraws itself again when a draft returns to a loaded value that is already the default", () => {
    // canReset = !atDefault || dirty — with the loaded value AT its default,
    // Reset is offered only because of the dirty draft, so clearing dirty
    // must take the button away again (it did not, before this fix).
    view = renderIntoBody(<SettingField entry={MAX_TRANSCODES_ENTRY} value={1} source="default" onChanged={noop} />);
    const input = view.container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(resetButton()).toBeUndefined();

    act(() => setNativeValue(input, "6"));
    expect(resetButton()).toBeDefined();

    act(() => setNativeValue(input, "1"));
    expect(resetButton()).toBeUndefined();
  });
});
