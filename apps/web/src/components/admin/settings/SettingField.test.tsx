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

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import type { JsonSchemaLike } from "../../../lib/settings-schema-widget.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type UpdateSettingResponse = components["schemas"]["UpdateSettingResponse"];

const apiPutMock = vi.fn();

class FakeApiError extends Error {}

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

    it("boolean widget: clicking the ON/OFF label text (outside the switch itself, but inside the clickable row) also toggles exactly once — not zero, not twice", () => {
      // The row wraps its own onClick AROUND the shared Toggle (whose own
      // internal <label> already makes the switch itself clickable) so the
      // text label is clickable too. A click on the switch bubbles through
      // BOTH handlers (Toggle's onChange AND the row's onClick) in the same
      // tick — this asserts that doesn't produce a double-toggle-back-to-
      // start, which the previous test's "click the switch" case already
      // covers; this one drives the OTHER path (a click that never reaches
      // the switch at all) to confirm the row-level handler alone is
      // sufficient and idempotent-safe either way.
      view = renderIntoBody(<SettingField entry={HEVC_ENTRY} value={true} source="default" onChanged={noop} />);
      const label = Array.from(view.container.querySelectorAll("span")).find((s) => s.textContent === "ON")!;
      act(() => label.click());
      expect(view.container.textContent).toContain("OFF");
      const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("enum widget: renders one option per schema enum value, uppercased via the shared SegmentedControl", () => {
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
});
