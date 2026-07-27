// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/_components/RestrictedStep.test.tsx
//
// Covers the set/unlock PIN-length agreement: the ONLY unlock UI
// (components/restricted/PinModal.tsx, via lib/pin-entry.ts) hard-requires
// exactly PIN_LENGTH digits and can never submit anything else. Before this
// test existed, this step's PIN field accepted (and PUT /users/me/restricted
// would persist) any digit count, which strands a user who sets e.g. a
// 6-digit PIN here — every later unlock attempt is unrepresentable in
// PinModal's buffer and 401s forever. Asserts this form now routes through
// the same lib/pin-entry.ts rule PinModal itself uses, so the two sides
// cannot drift apart again.
//
// apiGet/apiPut are mocked and the module under test imported afterwards —
// the established convention here (AccountSection.test.tsx,
// AlbumDetailScreen.test.tsx, use-watched-state.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";
import { PIN_LENGTH } from "../../../lib/pin-entry.js";

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
}));

const { RestrictedStep } = await import("./RestrictedStep.js");

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("RestrictedStep", () => {
  let view: TestRender | null = null;
  const onNext = vi.fn();

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    onNext.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/system/capabilities") {
        return Promise.resolve({ details: { "restricted-content": { enabled: true } } });
      }
      return Promise.reject(new Error(`unexpected apiGet ${path}`));
    });
    apiPutMock.mockImplementation(() => Promise.resolve({}));
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<RestrictedStep onNext={onNext} />);
    await act(async () => {});
  }

  function tabFor(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll('[role="tab"]')).find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    if (!button) throw new Error(`no tab labelled "${text}"`);
    return button as HTMLButtonElement;
  }

  function buttonFor(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    if (!button) throw new Error(`no button labelled "${text}"`);
    return button as HTMLButtonElement;
  }

  function pinInput(): HTMLInputElement {
    const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith("PIN"),
    );
    if (!label) throw new Error("PIN field not rendered");
    return label.querySelector("input")!;
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  async function enableOptIn(): Promise<void> {
    await render();
    await click(tabFor("On"));
  }

  it("labels the PIN field with the exact digit count the unlock modal requires", async () => {
    await enableOptIn();
    const label = pinInput().closest("label")!;
    expect(label.textContent).toContain(`${PIN_LENGTH} digits`);
  });

  it("clamps typed input to PIN_LENGTH digits — matches PinModal's unlock buffer exactly", async () => {
    await enableOptIn();
    setNativeValue(pinInput(), "123456789");
    expect(pinInput().value).toBe("1234");
    expect(pinInput().value.length).toBe(PIN_LENGTH);
  });

  it("refuses to submit a PIN shorter than PIN_LENGTH and never calls PUT /users/me/restricted", async () => {
    await enableOptIn();
    setNativeValue(pinInput(), "12");
    await click(buttonFor("Continue"));

    expect(apiPutMock).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(view!.container.textContent ?? "").toMatch(new RegExp(`${PIN_LENGTH}-digit PIN`));
  });

  it("submits a PIN of exactly PIN_LENGTH digits — the only value PinModal can ever send back", async () => {
    await enableOptIn();
    setNativeValue(pinInput(), "1234");
    await click(buttonFor("Continue"));

    expect(apiPutMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me/restricted");
    expect(options.body).toEqual({ optIn: true, pin: "1234" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
