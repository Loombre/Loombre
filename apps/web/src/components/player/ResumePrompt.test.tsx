// SPDX-License-Identifier: AGPL-3.0-only

// jsdom does not implement window.matchMedia (verified against this repo's
// jsdom 29.1.1 — see components/ui/SheetOrModal.test.tsx's identical note,
// which this file mirrors: ResumePrompt composes SheetOrModal, so its own
// tests need the same fake).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumePrompt } from "./ResumePrompt.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: initialMatches,
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );
}

describe("ResumePrompt", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it("renders nothing when closed", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <ResumePrompt
        open={false}
        positionMs={125_000}
        durationMs={600_000}
        deviceLabel={null}
        onResume={vi.fn()}
        onStartOver={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows where playback stopped, a real progress percent, and both explicit choices — never auto-resumes", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <ResumePrompt
        open
        positionMs={125_000}
        durationMs={600_000}
        deviceLabel={null}
        onResume={vi.fn()}
        onStartOver={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.container.textContent).toContain("You stopped at 2:05");

    const bar = view.container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(Number(bar?.getAttribute("aria-valuenow"))).toBeCloseTo((125_000 / 600_000) * 100, 5);

    const buttons = Array.from(view.container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes("Start over"))).toBe(true);
    expect(buttons.some((t) => t?.includes("Resume from 2:05"))).toBe(true);
  });

  it("never renders a device line when no real device fact is known (deviceLabel: null)", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <ResumePrompt
        open
        positionMs={10_000}
        durationMs={100_000}
        deviceLabel={null}
        onResume={vi.fn()}
        onStartOver={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.container.textContent).not.toContain(" on ");
  });

  it("renders the device line when one is supplied", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <ResumePrompt
        open
        positionMs={10_000}
        durationMs={100_000}
        deviceLabel="Living Room TV"
        onResume={vi.fn()}
        onStartOver={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.container.textContent).toContain("on Living Room TV");
  });

  it("Resume calls onResume, Start over calls onStartOver — neither fires without an explicit tap", () => {
    installMatchMedia(false);
    const onResume = vi.fn();
    const onStartOver = vi.fn();
    view = renderIntoBody(
      <ResumePrompt
        open
        positionMs={10_000}
        durationMs={100_000}
        deviceLabel={null}
        onResume={onResume}
        onStartOver={onStartOver}
        onDismiss={vi.fn()}
      />,
    );
    const buttons = Array.from(view.container.querySelectorAll("button"));
    buttons.find((b) => b.textContent?.includes("Start over"))?.click();
    expect(onStartOver).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();

    buttons.find((b) => b.textContent?.includes("Resume from"))?.click();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses without choosing Resume or Start Over", () => {
    installMatchMedia(false);
    const onResume = vi.fn();
    const onStartOver = vi.fn();
    const onDismiss = vi.fn();
    view = renderIntoBody(
      <ResumePrompt
        open
        positionMs={10_000}
        durationMs={100_000}
        deviceLabel={null}
        onResume={onResume}
        onStartOver={onStartOver}
        onDismiss={onDismiss}
      />,
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(onStartOver).not.toHaveBeenCalled();
  });
});
