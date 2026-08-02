// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/MailCredentialsCard.test.tsx
//
// E5/M10: the ProviderKeysCard-pattern state machine (idle/replacing/
// confirming) adapted for one write-only username+password pair, incl. the
// env-pinned LOCKED state this file's task spec calls out by name ("the
// env-pin locked states working").

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { MailCredentialsCard } from "./MailCredentialsCard.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type MailCredentialsStatus = components["schemas"]["MailCredentialsStatus"];

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const NOT_CONFIGURED: MailCredentialsStatus = { configured: false, setAtMs: null, source: null };
const CONFIGURED_KEYRING: MailCredentialsStatus = { configured: true, setAtMs: 1_700_000_000_000, source: "keyring" };
const CONFIGURED_ENV: MailCredentialsStatus = { configured: true, setAtMs: null, source: "env" };

describe("MailCredentialsCard", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function buttonsByText(): Map<string, HTMLButtonElement> {
    const map = new Map<string, HTMLButtonElement>();
    view!.container.querySelectorAll("button").forEach((b) => {
      if (b.textContent) map.set(b.textContent.trim(), b as HTMLButtonElement);
    });
    return map;
  }

  it("not configured: 'Set credentials', no Clear button", () => {
    view = renderIntoBody(<MailCredentialsCard status={NOT_CONFIGURED} onChanged={() => {}} />);
    expect(view.container.textContent).toContain("NOT CONFIGURED");
    const buttons = buttonsByText();
    expect([...buttons.keys()].some((t) => t.includes("Set credentials"))).toBe(true);
    expect([...buttons.keys()].some((t) => t === "Clear")).toBe(false);
  });

  it("configured via keyring: 'Replace credentials' + 'Clear', reports source/last-set", () => {
    view = renderIntoBody(<MailCredentialsCard status={CONFIGURED_KEYRING} onChanged={() => {}} />);
    expect(view.container.textContent).toContain("CONFIGURED");
    expect(view.container.textContent).toContain("KEYRING");
    expect(view.container.textContent).toMatch(/SET/);
    const buttons = buttonsByText();
    expect([...buttons.keys()].some((t) => t.includes("Replace credentials"))).toBe(true);
    expect([...buttons.keys()].some((t) => t === "Clear")).toBe(true);
  });

  // THE env-pin locked state (task spec: "the env-pin locked states working").
  it("configured via environment: NO editor controls at all — a padlock display naming both env vars", () => {
    view = renderIntoBody(<MailCredentialsCard status={CONFIGURED_ENV} onChanged={() => {}} />);
    expect(view.container.querySelectorAll("button").length).toBe(0);
    expect(view.container.querySelector('svg[aria-label="Locked"]')).not.toBeNull();
    expect(view.container.textContent).toContain("LOOMBRE_SMTP_USERNAME");
    expect(view.container.textContent).toContain("LOOMBRE_SMTP_PASSWORD");
    expect(view.container.textContent).not.toMatch(/CONFIGURED/); // status pills don't render in the locked branch
  });

  it("idle -> replacing: two empty fields (username, password), Save disabled until both are filled", () => {
    view = renderIntoBody(<MailCredentialsCard status={NOT_CONFIGURED} onChanged={() => {}} />);
    const setButton = [...buttonsByText().values()].find((b) => b.textContent?.includes("Set credentials"))!;
    act(() => setButton.click());

    const inputs = view.container.querySelectorAll("input");
    expect(inputs.length).toBe(2);
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");

    const save = [...buttonsByText().values()].find((b) => b.textContent === "Save")!;
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("filling both fields enables Save; Cancel discards the draft with no trace", () => {
    view = renderIntoBody(<MailCredentialsCard status={NOT_CONFIGURED} onChanged={() => {}} />);
    act(() => [...buttonsByText().values()].find((b) => b.textContent?.includes("Set credentials"))!.click());

    const inputs = view.container.querySelectorAll("input");
    act(() => setNativeValue(inputs[0] as HTMLInputElement, "smtp-user"));
    act(() => setNativeValue(inputs[1] as HTMLInputElement, "smtp-pass"));

    const save = [...buttonsByText().values()].find((b) => b.textContent === "Save")!;
    expect(save.hasAttribute("disabled")).toBe(false);

    const cancel = [...buttonsByText().values()].find((b) => b.textContent === "Cancel")!;
    act(() => cancel.click());

    expect(view.container.querySelectorAll("input").length).toBe(0);
    expect(view.container.textContent).not.toContain("smtp-user");
    expect(view.container.textContent).not.toContain("smtp-pass");
  });

  it("Clear opens a danger-tinted confirm, not an immediate delete", () => {
    view = renderIntoBody(<MailCredentialsCard status={CONFIGURED_KEYRING} onChanged={() => {}} />);
    const clearButton = [...buttonsByText().values()].find((b) => b.textContent === "Clear")!;
    act(() => clearButton.click());

    expect(view.container.textContent).toContain("Clear the stored SMTP credentials?");
    const buttons = buttonsByText();
    expect([...buttons.keys()].some((t) => t === "Clear")).toBe(true);
    expect([...buttons.keys()].some((t) => t === "Cancel")).toBe(true);
  });

  it("SECURITY: never renders a plausible credential value in any state", () => {
    view = renderIntoBody(<MailCredentialsCard status={CONFIGURED_KEYRING} onChanged={() => {}} />);
    const SUSPICIOUS = ["smtp-user", "smtp-pass", "Bearer ", "•••"];
    for (const needle of SUSPICIOUS) expect(view.container.textContent).not.toContain(needle);

    act(() => [...buttonsByText().values()].find((b) => b.textContent?.includes("Replace credentials"))!.click());
    for (const needle of SUSPICIOUS) expect(view.container.textContent).not.toContain(needle);
  });
});
