// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/advanced/AdvancedWorkbench.test.tsx
//
// UIFIX-2026-08-29 Lane K: behavioural coverage for the rebuilt Settings ›
// Advanced surface. UD-12 removed @playwright/test from this run, so
// computed-style and screenshot proof happens post-merge against live
// Chrome; everything provable without a real layout engine is pinned here.
//
// jsdom applies no CSS (vitest stubs .module.css), so nothing below queries
// a class name — every assertion goes through a role, an ARIA state, or
// visible text, which is also what makes them accessibility evidence.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
const apiPostMock = vi.fn();
let socketHandler: (() => void) | null = null;

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: class extends Error {},
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({
    subscribe: (_event: string, handler: () => void) => {
      socketHandler = handler;
      return () => {
        socketHandler = null;
      };
    },
  }),
}));

const { AdvancedWorkbench } = await import("./AdvancedWorkbench.js");

// ── ResizeObserver + width stubs ──────────────────────────────────────────
// jsdom has neither, and the work-area measurement is the whole basis of the
// inline-vs-drawer switch (UD-20d), so both are faked explicitly rather than
// left to a fallback.
let resizeCallback: (() => void) | null = null;
let stubbedWidth = 1400;

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    resizeCallback = null;
  }
}

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(): number {
    return stubbedWidth;
  },
});

function schemaEntry(
  key: string,
  category: string,
  valueSchema: Record<string, unknown>,
  defaultValue: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    category,
    description: `What ${key} does.`,
    scope: "ui",
    requiresRestart: false,
    default: defaultValue,
    valueSchema,
    locked: false,
    ...extra,
  };
}

const SCHEMA = {
  entries: [
    schemaEntry("database.url", "database", { type: "string" }, "postgres://loombre:***@localhost:5442/loombre", {
      scope: "env-only",
      locked: true,
      lockedBy: "DATABASE_URL",
      envVar: "DATABASE_URL",
      requiresRestart: true,
    }),
    schemaEntry("network.publicUrl", "network", { type: "string" }, ""),
    schemaEntry("network.trustProxy", "network", { type: "boolean" }, false, {
      requiresRestart: true,
      caution: "Only enable this behind a proxy you control.",
      technicalDetails: "Trusts X-Forwarded-For.",
      envVar: "LOOMBRE_TRUST_PROXY",
    }),
    schemaEntry("transcode.maxSimultaneousTranscodes", "transcode", { type: "integer", minimum: 1, maximum: 64 }, 2),
    schemaEntry("transcode.ladderRungs", "transcode", { type: "array", items: { type: "object" } }, []),
    schemaEntry("scanner.concurrency", "scanner", { type: "integer", minimum: 1, maximum: 64 }, 4),
    schemaEntry("updateCheck.mode", "updateCheck", { type: "string", enum: ["off", "manual", "daily"] }, "manual"),
    schemaEntry("stash.sync.scheduleIntervalMs", "stash", { type: "integer", minimum: 1000 }, 3_600_000),
  ],
};

function settingValue(key: string, value: unknown, source: string, locked = false): Record<string, unknown> {
  return { key, value, source, requiresRestart: false, locked, ...(locked ? { lockedBy: "DATABASE_URL" } : {}) };
}

function settingsResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: [
      settingValue("database.url", "postgres://loombre:***@localhost:5442/loombre", "environment", true),
      settingValue("network.publicUrl", "", "default"),
      settingValue("network.trustProxy", true, "database"),
      settingValue("transcode.maxSimultaneousTranscodes", 8, "database"),
      settingValue("transcode.ladderRungs", [{ height: 720 }], "database"),
      settingValue("scanner.concurrency", 4, "default"),
      settingValue("updateCheck.mode", "manual", "default"),
      settingValue("stash.sync.scheduleIntervalMs", 3_600_000, "default"),
    ],
    restartPendingKeys: [],
    providerKeys: [],
    ...overrides,
  };
}

let currentSettings: Record<string, unknown> = settingsResponse();

function dataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="row"][aria-selected]'));
}

function keyLineOf(row: HTMLElement): HTMLElement {
  return row.querySelector('[role="gridcell"]')!.firstElementChild as HTMLElement;
}

function keyOfRow(row: HTMLElement): string {
  return keyLineOf(row).textContent!;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
}

function railItem(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) =>
    (b.textContent ?? "").startsWith(label),
  );
  if (!found) throw new Error(`no rail item labelled ${label}`);
  return found;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => setNativeValue(element, value));
}

/** React maps onBlur to the native focusout event. */
function blur(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

describe("AdvancedWorkbench", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    stubbedWidth = 1400;
    resizeCallback = null;
    socketHandler = null;
    currentSettings = settingsResponse();
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    apiPostMock.mockReset();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/settings/schema") return Promise.resolve(SCHEMA);
      if (path === "/admin/settings") return Promise.resolve(currentSettings);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    apiPutMock.mockResolvedValue({});
    apiPostMock.mockResolvedValue({ accepted: true, action: "restart" });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<HTMLElement> {
    view = renderIntoBody(
      <ToastProvider>
        <AdvancedWorkbench />
      </ToastProvider>,
    );
    await flush();
    return view.container;
  }

  it("merges GET schema + GET settings into one row per key, in wire order, with live values", async () => {
    const container = await render();
    const rows = dataRows(container);
    // Default scope is "All settings": the seven editable keys, env-only out.
    expect(rows).toHaveLength(7);
    expect(keyOfRow(rows[0]!)).toBe("network.publicUrl");
    const concurrency = container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]');
    expect(concurrency?.value).toBe("4");
  });

  it("derives every rail count live and renders 'env' for a category with no editable key", async () => {
    const container = await render();
    expect(railItem(container, "All settings").textContent).toContain("7");
    expect(railItem(container, "Changed by me").textContent).toContain("3");
    expect(railItem(container, "Env-locked").textContent).toContain("1");
    expect(railItem(container, "Database").textContent).toContain("env");
    expect(railItem(container, "Network").textContent).toContain("2");
  });

  it("searches key, description AND category label, keeps the dotted prefix, and clears on a scope pick", async () => {
    const container = await render();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.placeholder).toBe("Search all 8 settings…");

    type(search, "publicUrl"); // key leg
    expect(dataRows(container)).toHaveLength(1);

    type(search, "What scanner"); // description leg
    expect(dataRows(container)).toHaveLength(1);

    type(search, "Update check"); // category-label leg — not in the key at all
    const rows = dataRows(container);
    expect(rows).toHaveLength(1);
    // Results span categories again, so the dimmed prefix comes back — two
    // separately-coloured spans, prefix then leaf.
    const keyLine = keyLineOf(rows[0]!);
    expect(Array.from(keyLine.children).map((c) => c.textContent)).toEqual(["updateCheck.", "mode"]);

    act(() => railItem(container, "Network").click());
    expect(search.value).toBe("");
    expect(dataRows(container)).toHaveLength(2);
  });

  it("hides the dotted prefix inside a single category and renders the full key as one bright run", async () => {
    const container = await render();
    act(() => railItem(container, "Network").click());
    const rows = dataRows(container);
    expect(rows.map(keyOfRow)).toEqual(["network.publicUrl", "network.trustProxy"]);
    // One span, not prefix+leaf: inside a category every row would repeat
    // the same dimmed prefix, so the device earns nothing.
    expect(keyLineOf(rows[0]!).children).toHaveLength(1);
  });

  it("autosaves a number field on change with a per-key PUT and offers a single-key Undo", async () => {
    const container = await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!;
    type(input, "6");
    expect(apiPutMock).not.toHaveBeenCalled(); // never one PUT per keystroke
    blur(input);
    await flush();

    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock).toHaveBeenCalledWith("/admin/settings/{key}", {
      params: { path: { key: "scanner.concurrency" } },
      body: { value: 6 },
    });
    expect(container.textContent).toContain("concurrency set to 6");

    const undo = buttonWithText(container, "Undo")!;
    expect(undo).toBeTruthy();
    apiPutMock.mockClear();
    act(() => undo.click());
    await flush();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock).toHaveBeenCalledWith("/admin/settings/{key}", {
      params: { path: { key: "scanner.concurrency" } },
      body: { value: 4 },
    });
  });

  it("writes nothing when an edit returns the field to the value it already had", async () => {
    const container = await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!;
    type(input, "9");
    type(input, "4");
    blur(input);
    await flush();
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("refuses a draft the schema rejects: no PUT, an inline message, and the last valid value retained", async () => {
    const container = await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!;
    type(input, "999");
    blur(input);
    await flush();
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Must be at most 64.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("a category reset PUTs every changed key, and its Undo restores ALL of them", async () => {
    const container = await render();
    act(() => railItem(container, "Transcode").click());
    const reset = buttonWithText(container, "Reset 2 changed")!;
    expect(reset).toBeTruthy();

    act(() => reset.click());
    await flush();
    expect(apiPutMock.mock.calls.map((c) => (c[1] as { params: { path: { key: string } } }).params.path.key)).toEqual([
      "transcode.maxSimultaneousTranscodes",
      "transcode.ladderRungs",
    ]);
    expect(container.textContent).toContain("2 settings reset to default");

    apiPutMock.mockClear();
    act(() => buttonWithText(container, "Undo")!.click());
    await flush();
    // BOTH keys come back — the prototype restored only the first (D-5 D4).
    expect(apiPutMock).toHaveBeenCalledTimes(2);
    expect(apiPutMock.mock.calls.map((c) => (c[1] as { body: { value: unknown } }).body.value)).toEqual([
      8,
      [{ height: 720 }],
    ]);
  });

  it("holds invalid JSON in the structured editor: flagged inline, nothing sent, last valid value kept", async () => {
    const container = await render();
    act(() => railItem(container, "Transcode").click());
    const summary = container.querySelector<HTMLButtonElement>('button[aria-label^="transcode.ladderRungs"]')!;
    act(() => summary.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="transcode.ladderRungs"]')!;
    expect(textarea.value).toContain('"height": 720');

    type(textarea, "[{");
    blur(textarea);
    await flush();
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Invalid JSON — not saved yet.");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps a dirty draft across a category switch and across a live settings.updated refresh", async () => {
    const container = await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!;
    type(input, "12");

    act(() => railItem(container, "Network").click());
    act(() => railItem(container, "Scanner").click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!.value).toBe("12");

    // A second admin's write lands while this one is mid-edit.
    currentSettings = settingsResponse({
      settings: (settingsResponse().settings as Record<string, unknown>[]).map((s) =>
        s["key"] === "scanner.concurrency" ? { ...s, value: 32, source: "database" } : s,
      ),
    });
    expect(socketHandler).not.toBeNull();
    await act(async () => {
      socketHandler!();
    });
    await flush();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="scanner.concurrency"]')!.value).toBe("12");
  });

  it("renders the SERVER's restartPendingKeys, and Show key selects that key in its own category", async () => {
    currentSettings = settingsResponse({ restartPendingKeys: ["network.trustProxy"] });
    const container = await render();
    expect(container.textContent).toContain("Restart required to fully apply");
    expect(container.textContent).toContain("network.trustProxy");

    act(() => buttonWithText(container, "Show key")!.click());
    const rows = dataRows(container);
    expect(rows.map(keyOfRow)).toEqual(["network.publicUrl", "network.trustProxy"]);
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    // …and the panel is describing that key, not just the table.
    const panel = container.querySelector("aside")!;
    expect(panel.textContent).toContain("network.trustProxy");
    expect(panel.textContent).toContain("Only enable this behind a proxy you control.");
  });

  it("the detail panel renders the wire default, the wire source, the caution and the env var — nothing invented", async () => {
    const container = await render();
    act(() => railItem(container, "Network").click());
    act(() => dataRows(container)[1]!.click());
    const panel = container.querySelector("aside")!;

    // UD-20b: the Default row is the wire `default` for every key.
    expect(panel.textContent).toContain("Default");
    expect(panel.textContent).toContain("false");
    // UD-20b again: no "chosen from your OS" — that flag is not on the wire.
    expect(panel.textContent).not.toContain("chosen from your OS");
    // Source comes from AdminSettingValue.source, not a re-derivation.
    expect(panel.textContent).toContain("changed from default");
    expect(panel.textContent).toContain("after restart");
    expect(panel.textContent).toContain("Trusts X-Forwarded-For.");
    expect(panel.textContent).toContain("Environment variable: LOOMBRE_TRUST_PROXY");
    // UD-20a: no invented unit suffix anywhere on the page.
    expect(container.textContent).not.toContain("/min");

    // A boolean gets a real two-state control here, not a "type true" field.
    const off = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Off")!;
    act(() => off.click());
    await flush();
    expect(apiPutMock).toHaveBeenCalledWith("/admin/settings/{key}", {
      params: { path: { key: "network.trustProxy" } },
      body: { value: false },
    });
  });

  it("offers Reset to default only for a changed key, and it PUTs the schema default", async () => {
    const container = await render();
    act(() => railItem(container, "Scanner").click());
    act(() => dataRows(container)[0]!.click());
    expect(buttonWithText(container.querySelector("aside")!, "Reset to default")).toBeUndefined();

    act(() => railItem(container, "Transcode").click());
    act(() => dataRows(container)[0]!.click());
    act(() => buttonWithText(container.querySelector("aside")!, "Reset to default")!.click());
    await flush();
    expect(apiPutMock).toHaveBeenCalledWith("/admin/settings/{key}", {
      params: { path: { key: "transcode.maxSimultaneousTranscodes" } },
      body: { value: 2 },
    });
  });

  it("sends Show key to the Env-locked view when the pending key is read-only — a category scope would not list it", async () => {
    currentSettings = settingsResponse({ restartPendingKeys: ["database.url"] });
    const container = await render();
    act(() => buttonWithText(container, "Show key")!.click());
    expect(railItem(container, "Env-locked").getAttribute("aria-checked")).toBe("true");
    const rows = dataRows(container);
    expect(rows.map(keyOfRow)).toEqual(["database.url"]);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the selected key's panel open across a scope change (D-5 D7, decided: selection persists)", async () => {
    const container = await render();
    act(() => railItem(container, "Scanner").click());
    act(() => dataRows(container)[0]!.click());
    expect(container.querySelector("aside")!.textContent).toContain("scanner.concurrency");
    act(() => railItem(container, "Network").click());
    expect(container.querySelector("aside")!.textContent).toContain("scanner.concurrency");
  });

  it("Restart now asks for confirmation first, then POSTs the existing /system/restart operation", async () => {
    currentSettings = settingsResponse({ restartPendingKeys: ["network.trustProxy"] });
    const container = await render();
    act(() => buttonWithText(container, "Restart now")!.click());
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(buttonWithText(container, "Cancel")).toBeTruthy();

    act(() => buttonWithText(container, "Confirm restart")!.click());
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/system/restart", {});
  });

  it("renders an env-locked key read-only — no editor, a labelled lock, and describeLocked's copy in the panel", async () => {
    const container = await render();
    act(() => railItem(container, "Env-locked").click());
    const rows = dataRows(container);
    expect(rows).toHaveLength(1);
    expect(container.querySelector('input[aria-label="database.url"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector('[role="img"][aria-label*="Env-only"]')).not.toBeNull();

    act(() => rows[0]!.click());
    expect(container.textContent).toContain("Env-only setting — never editable here.");
    expect(container.textContent).toContain("DATABASE_URL");
  });

  it("renders a server-masked secret exactly as served — the page never masks anything itself", async () => {
    const container = await render();
    act(() => railItem(container, "Env-locked").click());
    act(() => dataRows(container)[0]!.click());
    expect(container.textContent).toContain("postgres://loombre:***@localhost:5442/loombre");
    expect(container.textContent).not.toContain("••••");
  });

  it("lists every registry section in the switcher, marks the current one, and closes on select / outside / Escape", async () => {
    const container = await render();
    const trigger = container.querySelector<HTMLButtonElement>("h1 button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Advanced Server");

    act(() => trigger.click());
    const menu = container.querySelector('[role="menu"]')!;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items).toHaveLength(10);
    // Not the prototype's transcription: real labels, real hrefs.
    expect(items.map((i) => i.getAttribute("href"))).toContain("/settings/remote-access");
    expect(items.map((i) => i.getAttribute("href"))).not.toContain("/settings/restricted");
    expect(items.find((i) => i.getAttribute("aria-current") === "page")!.textContent).toContain("Advanced Server");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => trigger.click());
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => trigger.click());
    const preventNavigation = (event: Event): void => event.preventDefault();
    document.addEventListener("click", preventNavigation);
    act(() => (container.querySelector<HTMLElement>('[role="menuitem"]') as HTMLElement).click());
    document.removeEventListener("click", preventNavigation);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows the detail pane inline at/above the observed 1150px threshold — no scrim, no dialog", async () => {
    stubbedWidth = 1200;
    const container = await render();
    act(() => dataRows(container)[0]!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("aside")).not.toBeNull();
  });

  it("switches to a modal drawer below it, and follows a ResizeObserver report rather than the viewport", async () => {
    stubbedWidth = 900;
    const container = await render();
    act(() => dataRows(container)[0]!.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // Grow the work area through the threshold via the observer alone.
    expect(resizeCallback).not.toBeNull();
    stubbedWidth = 1300;
    await act(async () => {
      resizeCallback!();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the drawer takes focus on open, closes on Escape, and hands focus back to the row that opened it", async () => {
    stubbedWidth = 900;
    const container = await render();
    const row = dataRows(container)[0]!;
    act(() => {
      row.focus();
      row.click();
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("makes rows genuinely selectable — by click and from the keyboard", async () => {
    const container = await render();
    const rows = dataRows(container);
    act(() => rows[2]!.click());
    expect(rows[2]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[2]!.getAttribute("tabindex")).toBe("0");

    act(() => {
      rows[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(dataRows(container)[3]!.getAttribute("aria-selected")).toBe("true");
  });

  it("moves the rail selection with the arrow keys as a radiogroup", async () => {
    const container = await render();
    const all = railItem(container, "All settings");
    expect(all.getAttribute("aria-checked")).toBe("true");
    act(() => {
      all.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(railItem(container, "Changed by me").getAttribute("aria-checked")).toBe("true");
  });
});
