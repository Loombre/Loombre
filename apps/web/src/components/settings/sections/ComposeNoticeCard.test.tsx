// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ComposeNoticeCard tests — Settings -> Notices compose card
// (POST /system/notices). Mirrors ServerPowerCard.test.tsx's harness
// (vi.mock of api-client BEFORE a top-level-await import; renderIntoBody;
// act; a FakeApiError mirroring the real LoombreApiError's title-derived
// `message` so assertions on rendered text are meaningful). The
// InvitesPanel regression class applies here too: a failed publish must
// SHOW its error and return to an actionable form, never a stuck
// confirm/progress block.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `Request failed with status ${status}`;
    super(title);
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { ComposeNoticeCard } = await import("./ComposeNoticeCard.js");

let view: TestRender | undefined;
const onPublishedMock = vi.fn();

beforeEach(() => {
  apiPostMock.mockReset();
  onPublishedMock.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

interface ActiveNoticeLike {
  id: string;
  message: string;
  severity: "info" | "warning" | "critical";
  effectiveAtMs: number | null;
  expiresAtMs: number | null;
  createdAtMs: number;
  createdBy: string | null;
  cancelledAtMs: number | null;
  status: "active" | "cancelled" | "expired";
}

async function render(activeNotice: ActiveNoticeLike | null = null, activeNoticeLoaded = true): Promise<void> {
  view = renderIntoBody(
    <ComposeNoticeCard activeNotice={activeNotice} activeNoticeLoaded={activeNoticeLoaded} onPublished={onPublishedMock} />,
  );
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").trim() === label || (b.textContent ?? "").includes(label));
  if (!match) {
    throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  }
  return match;
}

function textarea(): HTMLTextAreaElement {
  const el = document.body.querySelector("textarea");
  if (!el) throw new Error("no textarea found");
  return el;
}

function selectContainingOption(optionText: string): HTMLSelectElement {
  const selects = Array.from(document.body.querySelectorAll("select"));
  const match = selects.find((s) => Array.from(s.options).some((o) => o.textContent === optionText));
  if (!match) {
    throw new Error(`no select containing option "${optionText}"`);
  }
  return match;
}

function numberInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[type="number"]'));
}

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function typeMessage(value: string): Promise<void> {
  await act(async () => {
    setNativeValue(textarea(), value);
  });
}

async function selectOption(el: HTMLSelectElement, optionText: string): Promise<void> {
  const opt = Array.from(el.options).find((o) => o.textContent === optionText);
  if (!opt) throw new Error(`no option "${optionText}" in select`);
  await act(async () => {
    setNativeValue(el, opt.value);
  });
}

describe("ComposeNoticeCard — restart presets", () => {
  it('"Restart in 5 min" prefills severity critical, message, effective=5min, expiry custom=15min', async () => {
    await render(null);
    await click("Restart in 5 min");

    expect(textarea().value).toBe(
      "The server will restart in about 5 minutes. Playback may pause briefly — it will resume on its own.",
    );
    // Severity segmented control shows Critical active.
    const criticalTab = buttonByText("Critical");
    expect(criticalTab.getAttribute("aria-checked")).toBe("true");
    // Effective select shows "In 5 minutes"; expiry select shows the custom
    // minutes input pre-filled at 15 (5 + 10, N4's self-clear window).
    expect(selectContainingOption("In 5 minutes").value).toBe("5");
    const customInputs = numberInputs();
    expect(customInputs).toHaveLength(1);
    expect(customInputs[0]?.value).toBe("15");

    await click("Publish notice");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/system/notices");
    expect(apiPostMock.mock.calls[0]?.[1]).toEqual({
      body: {
        message: "The server will restart in about 5 minutes. Playback may pause briefly — it will resume on its own.",
        severity: "critical",
        effectiveInMs: 5 * 60_000,
        expiresInMs: 15 * 60_000,
      },
    });
  });

  it('"Restart in 15 min" and "30 min" prefill the matching N+10min self-clearing expiry', async () => {
    apiPostMock.mockResolvedValue({});
    await render(null);

    await click("15 min");
    expect(selectContainingOption("In 15 minutes").value).toBe("15");
    expect(numberInputs()[0]?.value).toBe("25");
    await click("Publish notice");
    expect(apiPostMock.mock.calls[0]?.[1]).toMatchObject({
      body: { effectiveInMs: 15 * 60_000, expiresInMs: 25 * 60_000, severity: "critical" },
    });

    apiPostMock.mockClear();
    await click("Custom"); // reset to blank before the next preset
    await click("30 min");
    expect(selectContainingOption("In 30 minutes").value).toBe("30");
    expect(numberInputs()[0]?.value).toBe("40");
    await click("Publish notice");
    expect(apiPostMock.mock.calls[0]?.[1]).toMatchObject({
      body: { effectiveInMs: 30 * 60_000, expiresInMs: 40 * 60_000, severity: "critical" },
    });
  });
});

describe("ComposeNoticeCard — char counter", () => {
  it("tracks 0/500, 250/500, and blocks past 500 (501 truncated to 500)", async () => {
    await render(null);
    expect(textOf()).toContain("0/500");

    await typeMessage("a".repeat(250));
    expect(textOf()).toContain("250/500");

    await typeMessage("a".repeat(500));
    expect(textOf()).toContain("500/500");

    // 501 chars typed — the change handler hard-truncates the VALUE itself
    // (this file's own header: relying on `maxLength` alone isn't
    // deterministic against a directly-assigned `.value`).
    await typeMessage("a".repeat(501));
    expect(textarea().value).toHaveLength(500);
    expect(textOf()).toContain("500/500");
  });
});

it("R-F8: counts CODE POINTS, not UTF-16 units — 250 astral emoji read 250/500, and the truncate never splits a surrogate pair", async () => {
  await render();

  // 250 emoji = 500 UTF-16 units but 250 characters to Postgres/the
  // contract — the counter must say 250, not 500.
  await typeMessage("😀".repeat(250));
  expect(textOf()).toContain("250/500");

  // 501 emoji truncates to exactly 500 WHOLE characters (1000 UTF-16
  // units) — a naive .slice(0, 500) would cut mid-surrogate.
  await typeMessage("😀".repeat(501));
  expect([...textarea().value]).toHaveLength(500);
  expect(textarea().value.endsWith("😀")).toBe(true);
  expect(textOf()).toContain("500/500");
});

describe("ComposeNoticeCard — warning requires expiry", () => {
  it("Maintenance preset leaves expiry unset; publishing without choosing one blocks with an inline error", async () => {
    await render(null);
    await click("Maintenance");
    expect(buttonByText("Warning").getAttribute("aria-checked")).toBe("true");

    await click("Publish notice");
    expect(textOf()).toContain("Warning notices require an expiry.");
    expect(apiPostMock).not.toHaveBeenCalled();

    // Choosing an expiry unblocks it.
    await selectOption(selectContainingOption("1 hour"), "1 hour");
    await click("Publish notice");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[1]).toMatchObject({ body: { severity: "warning", expiresInMs: 60 * 60_000 } });
  });
});

describe("ComposeNoticeCard — 'Until cancelled' visibility", () => {
  it("only appears in the expiry select when severity is critical", async () => {
    await render(null);
    await typeMessage("Custom message");
    expect(selectContainingOption("1 hour").innerHTML).not.toContain("Until cancelled");

    await click("Critical");
    expect(selectContainingOption("1 hour").innerHTML).toContain("Until cancelled");

    await click("Info");
    expect(selectContainingOption("1 hour").innerHTML).not.toContain("Until cancelled");
  });
});

describe("ComposeNoticeCard — replace-confirm (N1)", () => {
  const active: ActiveNoticeLike = {
    id: "11111111-1111-1111-1111-111111111111",
    message: "Existing maintenance notice already live",
    severity: "warning",
    effectiveAtMs: null,
    expiresAtMs: Date.now() + 3_600_000,
    createdAtMs: Date.now() - 60_000,
    createdBy: "22222222-2222-2222-2222-222222222222",
    cancelledAtMs: null,
    status: "active",
  };

  it("gates the POST behind a confirm step naming the notice being replaced when one is active", async () => {
    await render(active);
    await typeMessage("A brand new notice");
    await selectOption(selectContainingOption("1 hour"), "1 hour");

    await click("Publish notice");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(textOf()).toContain("Replace the current notice?");
    expect(textOf()).toContain("Existing maintenance notice already live");

    await click("Replace");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[1]).toMatchObject({ body: { message: "A brand new notice" } });
  });

  it("Cancel on the replace-confirm returns to the form without posting", async () => {
    await render(active);
    await typeMessage("Another new notice");
    await selectOption(selectContainingOption("1 hour"), "1 hour");
    await click("Publish notice");
    expect(textOf()).toContain("Replace the current notice?");

    await click("Cancel");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(textOf()).not.toContain("Replace the current notice?");
    expect(textarea().value).toBe("Another new notice"); // form retained, not reset
  });

  it("publishes directly with no confirm step when no notice is active", async () => {
    await render(null);
    await typeMessage("First notice on a quiet server");
    await selectOption(selectContainingOption("1 hour"), "1 hour");
    await click("Publish notice");
    expect(textOf()).not.toContain("Replace the current notice?");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });
});

describe("ComposeNoticeCard — failed publish", () => {
  it("shows the error and returns the form to an actionable state (direct-publish path)", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(422, { title: "Message is required.", status: 422 }));
    await render(null);
    await typeMessage("Something");
    await selectOption(selectContainingOption("1 hour"), "1 hour");
    await click("Publish notice");
    expect(textOf()).toContain("Message is required.");
    // Actionable again — the form (not a stuck spinner) is still present.
    expect(buttonByText("Publish notice")).toBeTruthy();
    expect(textarea().value).toBe("Something");
  });

  it("shows the error and returns to the plain form (not the confirm step) on a failed replace", async () => {
    const active: ActiveNoticeLike = {
      id: "33333333-3333-3333-3333-333333333333",
      message: "Old notice",
      severity: "info",
      effectiveAtMs: null,
      expiresAtMs: Date.now() + 3_600_000,
      createdAtMs: Date.now() - 60_000,
      createdBy: null,
      cancelledAtMs: null,
      status: "active",
    };
    apiPostMock.mockRejectedValue(new FakeApiError(500, { title: "boom", status: 500 }));
    await render(active);
    await typeMessage("Replacement attempt");
    await selectOption(selectContainingOption("1 hour"), "1 hour");
    await click("Publish notice");
    await click("Replace");
    expect(textOf()).toContain("boom");
    expect(textOf()).not.toContain("Replace the current notice?");
    expect(buttonByText("Publish notice")).toBeTruthy();
  });
});

describe("ComposeNoticeCard — publish gated until the parent's active-notice fetch resolves", () => {
  it("disables Publish while activeNoticeLoaded is false", async () => {
    await render(null, false);
    expect(buttonByText("Publish notice").disabled).toBe(true);
  });
});

describe("ComposeNoticeCard — LD-4 (owner QA, 2026-08-10)", () => {
  it("no longer renders the page-level notices copy — it moved to NoticesSection, under the page title", async () => {
    await render(null);
    expect(textOf()).not.toContain("Notices are shown to every user on this server");
  });
});

// Item 2 (Wave A): the two "custom minutes" number fields
// used to borrow shared.module.css's `.textarea` class (a rectangular
// <textarea>-shaped recipe applied to an <input type="number">, not the
// canonical ui/Input primitive) — consolidated onto TextInput so there's
// ONE text-input styling system, not two independently-maintained ones
// that each need their own copy of the inset-focus-ring fix.
describe("ComposeNoticeCard — custom-minutes fields consolidated onto ui/Input (item 2)", () => {
  it("both custom-minutes fields still render as functioning number inputs with the right constraints", async () => {
    await render(null);
    await selectOption(selectContainingOption("Custom minutes…"), "Custom minutes…");
    const inputs = numberInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    for (const input of inputs) {
      expect(input.min).toBe("1");
      expect(input.step).toBe("1");
      expect(input.placeholder).toBe("Minutes");
    }
  });

  it("source no longer styles a number input with the shared .textarea recipe", () => {
    const source = readFileSync(path.join(__dirname, "ComposeNoticeCard.tsx"), "utf8");
    expect(source).not.toMatch(/\$\{sharedStyles\.textarea\}/);
    expect(source).toMatch(/import\s*\{[^}]*\bTextInput\b[^}]*\}\s*from\s*"..\/..\/ui\/Input\.js"/);
    expect((source.match(/<TextInput\b/g) ?? []).length).toBe(2);
  });
});
