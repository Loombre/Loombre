// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/PinModal.test.tsx
//
// Item 2 (Wave A): PinModal's desktop numeric field used to
// be a raw <input> outside components/ui/Input.tsx — its own from-scratch
// border/background/focus-ring CSS, duplicating (and needing its own
// separate fix for) the inset-ring anti-clipping recipe Input.module.css
// already carries (see that file's header for the original W4 writeup).
// Consolidated onto TextInput (ui/Input.tsx): the field now inherits the
// shared `.input`/`.input:focus-visible` rules instead of shipping a
// second, parallel copy of them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LD-17 (rc.6): `unlock` is hoisted so it keeps ONE identity across renders —
// the LD-17 mixed-entry case below asserts the 4th digit auto-submits, which
// needs a stable spy to observe.
const mocks = vi.hoisted(() => ({ unlock: vi.fn().mockResolvedValue(false) }));

vi.mock("./RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: { modalOpen: true, submitting: false, error: null },
    closeUnlockModal: vi.fn(),
    unlock: mocks.unlock,
    lock: vi.fn(),
    openUnlockModal: vi.fn(),
    applyRestrictedSettings: vi.fn(),
  }),
}));

const { PinModal } = await import("./PinModal.js");

function installMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
}

/** Phone-width variant: the shared 767.98px mobile query matches, everything
 *  else does not. Exercises the LD-17 (rc.6) focus-confinement branch — at
 *  phone widths programmatic focus must stay OFF the hidden field (a numeric
 *  field grabbing focus would raise the soft keyboard over the keypad the
 *  sheet flow is built around) while the field itself stays focusable (R3). */
function installPhoneMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767.98px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
}

describe("PinModal — desktop field, functional behavior unaffected by the ui/Input consolidation", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    mocks.unlock.mockClear();
  });

  it("still renders the labelled, 4-digit numeric PIN field", () => {
    installMatchMedia();
    view = renderIntoBody(<PinModal />);
    const field = view.container.querySelector('input[aria-label="PIN"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(field.type).toBe("password");
    expect(field.inputMode).toBe("numeric");
    expect(field.maxLength).toBe(4);
  });

  it("still keeps the phone keypad grid alongside the field", () => {
    installMatchMedia();
    view = renderIntoBody(<PinModal />);
    expect(view.container.querySelectorAll('[role="group"][aria-label="PIN keypad"] button')).toHaveLength(11);
  });
});

describe("PinModal.tsx source — no raw <input> left outside ui/Input (item 2)", () => {
  const source = readFileSync(path.join(__dirname, "PinModal.tsx"), "utf8");

  it("renders the PIN field through the shared TextInput component, not a bare <input>", () => {
    expect(source).toMatch(/import\s*\{[^}]*\bTextInput\b[^}]*\}\s*from\s*"..\/ui\/Input\.js"/);
    expect(source).toMatch(/<TextInput\b/);
    expect(source).not.toMatch(/<input\b/);
  });
});

describe("PinModal.module.css — hiddenInput consolidated onto ui/Input.module.css's .input (item 2)", () => {
  const css = readFileSync(path.join(__dirname, "PinModal.module.css"), "utf8");

  it("no longer declares its own :focus-visible ring — inherits the shared .input:focus-visible inset ring for free", () => {
    expect(css).not.toMatch(/\.hiddenInput:focus-visible/);
  });

  it("outranks the shared base via an element+class compound selector (SettingField.module.css's own input.stringInput precedent), not a redeclared base rule", () => {
    expect(css).toMatch(/input\.hiddenInput\s*\{/);
    expect(css).not.toMatch(/\.hiddenInput\s*\{[^}]*\bborder-radius\b/);
  });
});

// LD-17 (rc.6): the free-text field between the dots and the keypad becomes
// visually hidden but still FOCUSABLE (the Toggle.module.css recipe — not
// display:none, not visibility:hidden), the focus ring moves to the dots
// container, and hardware-keyboard entry keeps working. Owner ruling R3: the
// old phone-only `display: none` branch is deleted outright, so the field is
// visually-hidden-but-focusable at EVERY width.
describe("PinModal.module.css — LD-17 (rc.6) visually-hidden-but-focusable PIN field", () => {
  // Comments stripped: these assertions are about DECLARATIONS, and the
  // rationale comments in that file legitimately name the techniques LD-17
  // rejected ("not display:none, not visibility:hidden").
  const css = readFileSync(path.join(__dirname, "PinModal.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const hiddenInputBlock = /input\.hiddenInput\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("carries the Toggle.module.css visually-hidden recipe, not the old 160px visible field", () => {
    expect(hiddenInputBlock).toMatch(/position:\s*absolute/);
    expect(hiddenInputBlock).toMatch(/\bwidth:\s*1px/);
    expect(hiddenInputBlock).toMatch(/\bheight:\s*1px/);
    expect(hiddenInputBlock).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hiddenInputBlock).toMatch(/overflow:\s*hidden/);
    expect(hiddenInputBlock).toMatch(/\bborder:\s*0/);
    // The obsolete visible-field styling is gone.
    expect(hiddenInputBlock).not.toMatch(/width:\s*160px/);
    expect(hiddenInputBlock).not.toMatch(/letter-spacing/);
  });

  it("never hides the field with display:none — R3 deleted the phone-only media branch", () => {
    expect(css).not.toMatch(/display:\s*none/);
    expect(css).not.toMatch(/visibility:\s*hidden/);
    expect(css).not.toMatch(/@media[\s\S]*\.hiddenInput/);
  });

  it("paints the focus ring on the dots container via :has(), since the dots PRECEDE the input", () => {
    expect(css).toMatch(/:has\(input:focus-visible\)\s*\.dots\s*\{[^}]*box-shadow:\s*var\(--shadow-focus-ring\)/);
  });

  it("gives .dots the padding + token radius a ring needs to read as a ring", () => {
    const dotsBlock = /^\.dots\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(dotsBlock).toMatch(/padding:\s*var\(--space-/);
    expect(dotsBlock).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });
});

describe("PinModal — LD-17 (rc.6) hardware-keyboard entry survives hiding the field", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    mocks.unlock.mockClear();
  });

  function pinField(): HTMLInputElement {
    return view!.container.querySelector('input[aria-label="PIN"]') as HTMLInputElement;
  }

  function filledDots(): number {
    return view!.container.querySelectorAll('[data-filled="true"]').length;
  }

  function keypadKeys(): HTMLButtonElement[] {
    return Array.from(view!.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="PIN keypad"] button'));
  }

  /** Types one digit into whatever currently holds focus — the point of the
   *  assertion is that focus is ON the PIN field, so a hardware keystroke
   *  reaches it. Uses the native value setter + a bubbling `input` event,
   *  which is how React's controlled inputs observe real typing. */
  // The open-focus effect defers one animation frame (see PinModal.tsx —
  // dev StrictMode remounts the dialog subtree and re-runs the trap's focus
  // after the dep-effect); tests flush that frame before asserting focus.
  async function flushFocusFrame(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }

  async function typeIntoFocusedElement(digit: string): Promise<void> {
    const target = document.activeElement as HTMLInputElement | null;
    expect(target?.getAttribute("aria-label")).toBe("PIN");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(target, `${target!.value}${digit}`);
      target!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("focuses the PIN field when the dialog opens, ahead of the focus trap's first-focusable", async () => {
    installMatchMedia();
    view = renderIntoBody(<PinModal />);
    await flushFocusFrame();
    expect(document.activeElement).toBe(pinField());
  });

  it("fills the dots from hardware-keyboard digits with no click into the field first", async () => {
    installMatchMedia();
    view = renderIntoBody(<PinModal />);
    await flushFocusFrame();
    await typeIntoFocusedElement("1");
    await typeIntoFocusedElement("2");
    expect(filledDots()).toBe(2);
  });

  it("routes focus back to the field after a keypad press, so mixed entry fills all four dots", async () => {
    installMatchMedia();
    view = renderIntoBody(<PinModal />);
    await act(async () => {
      keypadKeys()[0]!.click();
    });
    expect(filledDots()).toBe(1);
    expect(document.activeElement).toBe(pinField());

    await typeIntoFocusedElement("2");
    await typeIntoFocusedElement("3");
    expect(filledDots()).toBe(3);

    await typeIntoFocusedElement("4");
    expect(mocks.unlock).toHaveBeenCalledWith("1234");
  });

  it("phone widths: programmatic focus stays off the field — open places none, a keypad tap fills a dot without moving focus there, and the field stays focusable (R3)", async () => {
    installPhoneMatchMedia();
    view = renderIntoBody(<PinModal />);
    await flushFocusFrame();
    expect(pinField()).not.toBeNull();
    expect(document.activeElement).not.toBe(pinField());

    await act(async () => {
      keypadKeys()[0]!.click();
    });
    expect(filledDots()).toBe(1);
    expect(document.activeElement).not.toBe(pinField());

    // R3's substance: hidden-but-FOCUSABLE at every width — a deliberate
    // focus still lands (only the automatic placement is desktop-confined).
    await act(async () => {
      pinField().focus();
    });
    expect(document.activeElement).toBe(pinField());
  });
});
