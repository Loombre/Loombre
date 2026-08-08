// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ui/CommandBlock.test.tsx
//
// Renders every command, and copies them joined with "\n" (the whole point
// — pasting the copied text into a terminal must run each line in order).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "./test-render.js";
import { CommandBlock } from "./CommandBlock.js";

describe("CommandBlock", () => {
  let view: TestRender | null = null;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText } });
    writeText.mockClear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders every command", () => {
    view = renderIntoBody(
      <CommandBlock commands={['chmod +a "user:_loombre allow search" /Users/ozzy', "sudo -u _loombre ls /Users/ozzy/Media"]} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain('chmod +a "user:_loombre allow search" /Users/ozzy');
    expect(text).toContain("sudo -u _loombre ls /Users/ozzy/Media");
  });

  it("copies every command joined with a newline, in order", async () => {
    view = renderIntoBody(<CommandBlock commands={["one", "two", "three"]} />);

    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
    });

    expect(writeText).toHaveBeenCalledWith("one\ntwo\nthree");
  });

  it("accepts a custom aria-label for the copy button", () => {
    view = renderIntoBody(<CommandBlock commands={["one"]} ariaLabel="Copy ACL grant commands" />);
    expect(view.container.querySelector('svg[aria-label="Copy ACL grant commands"]')).not.toBeNull();
  });

  it("does not throw when the clipboard is unavailable/denied", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    view = renderIntoBody(<CommandBlock commands={["one"]} />);
    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
    });
    // No assertion beyond "did not throw" — the graceful-catch contract.
  });

  // ── finding 7: navigator.clipboard is undefined in a non-secure context
  //    (http://LAN-ip is this product's normal admin case) — Copy silently
  //    did nothing there. The fallback selects the command text instead, so
  //    the click visibly does something and the operator is one Cmd/Ctrl-C
  //    away from the same result. ──
  it("falls back to selecting the command text when the clipboard API is entirely absent", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const addRange = vi.fn();
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      addRange,
      removeAllRanges,
    } as unknown as Selection);

    view = renderIntoBody(<CommandBlock commands={["one"]} />);
    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
    });

    // Selection was attempted...
    expect(getSelectionSpy).toHaveBeenCalled();
    expect(addRange).toHaveBeenCalled();
    // ...and the button flips to a distinct failed/fallback-state
    // indicator, so the click visibly did something. Filtered by `.title`
    // rather than a `[title="..."]` attribute selector — the literal "&"
    // trips up jsdom's selector engine on an exact-match attribute value.
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons.some((b) => b.title === "Select & copy")).toBe(true);
    expect(buttons.some((b) => b.title === "Copy")).toBe(false);

    getSelectionSpy.mockRestore();
  });

  // ── finding 16: the copied/selected-state reset ran on a bare setTimeout
  //    with no cleanup — unmounting within the reset window left a pending
  //    state update on a dead component. ──
  it("clears the pending reset timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    view = renderIntoBody(<CommandBlock commands={["one"]} />);
    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
    });
    clearTimeoutSpy.mockClear();

    view.unmount();
    view = null;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
