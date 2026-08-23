// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/RowMenu.test.tsx
//
// browser-admin-F10 (P3, QA sweep 2026-08-20/21): RowMenu closed on an
// outside click but NOT on Escape — only a mousedown-outside listener
// existed, no keydown handling at all. Standard menu a11y (and this
// codebase's own convention: components/shell/UserMenu.tsx's menu closes
// on Escape and returns focus to its trigger) says Escape should close an
// open popover menu. Fixed by wiring the existing shared
// components/ui/overlay-hooks.ts `useEscapeKey` hook (already used by
// BottomSheet/SheetOrModal) instead of hand-rolling a second listener.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { RowMenu } from "./RowMenu.js";

describe("RowMenu", () => {
  let view: TestRender | null = null;
  const onSelect = vi.fn();

  beforeEach(() => {
    onSelect.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<RowMenu label="Row actions" actions={[{ label: "Edit", onSelect }]} />);
    await act(async () => {});
  }

  function trigger(): HTMLButtonElement {
    return view!.container.querySelector('button[aria-label="Row actions"]')!;
  }

  async function open(): Promise<void> {
    await act(async () => {
      trigger().click();
    });
  }

  it("opens on trigger click, exposing role=menu", async () => {
    await render();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view!.container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("closes on an outside click (pre-existing behavior, pinned)", async () => {
    await render();
    await open();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(view!.container.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Escape", async () => {
    await render();
    await open();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view!.container.querySelector('[role="menu"]')).toBeNull();
  });
});
