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
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("./RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: { modalOpen: true, submitting: false, error: null },
    closeUnlockModal: vi.fn(),
    unlock: vi.fn().mockResolvedValue(false),
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

describe("PinModal — desktop field, functional behavior unaffected by the ui/Input consolidation", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
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
