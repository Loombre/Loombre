// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/player/NoticeOverlayStrip.test.tsx
//
// N3's player review checkpoint. Like BannerRegion.test.tsx, this mocks
// useSystemNotice() directly (the shared state machine has its own
// coverage in notices/SystemNoticeProvider.test.tsx) and drives it through
// the severity-specific visibility rules THIS component owns: info
// auto-hides locally after ~6s, warning gets the shared per-session
// dismiss, critical never shows a dismiss control. Also proves the strip
// mounts inside VideoPlayer's stage element (the real integration point)
// and carries a non-blocking pointer-events posture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type NoticeSeverity = "info" | "warning" | "critical";
interface MockNotice {
  id: string;
  message: string;
  severity: NoticeSeverity;
  effectiveAtMs: number | null;
  expiresAtMs: number | null;
  createdAtMs: number;
}
interface MockValue {
  notice: MockNotice | null;
  severity: NoticeSeverity | null;
  serverOffsetMs: number;
  dismissed: boolean;
  dismiss: () => void;
  bannerVisible: boolean;
}

const dismissMock = vi.fn();

function defaultMock(): MockValue {
  return { notice: null, severity: null, serverOffsetMs: 0, dismissed: false, dismiss: dismissMock, bannerVisible: false };
}

let mockValue: MockValue = defaultMock();

vi.mock("../notices/SystemNoticeProvider.js", () => ({
  useSystemNotice: () => mockValue,
}));

const { NoticeOverlayStrip } = await import("./NoticeOverlayStrip.js");

function setMock(overrides: Partial<MockValue>): void {
  mockValue = { ...mockValue, ...overrides };
}

describe("NoticeOverlayStrip", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    dismissMock.mockReset();
    mockValue = defaultMock();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  function render(): TestRender {
    view = renderIntoBody(<NoticeOverlayStrip />);
    return view;
  }

  it("renders nothing when no notice is held", () => {
    render();
    expect(view!.container.firstChild).toBeNull();
  });

  // The REAL "does this mount inside VideoPlayer's stage element" proof
  // lives in VideoPlayer.test.tsx ("mounts NoticeOverlayStrip as a
  // descendant of the stage element when a notice is active") — that's
  // the actual `ref={stageRef}` div, the one DOM position proven to
  // survive the real Fullscreen API. This file stays focused on the
  // strip's own severity/visibility rules in isolation.
  it("renders a data-severity hook consumers/CSS key off — info example", () => {
    setMock({
      notice: { id: "n1", message: "Heads up", severity: "info", effectiveAtMs: null, expiresAtMs: Date.now() + 60_000, createdAtMs: 0 },
      severity: "info",
      bannerVisible: false,
    });
    render();
    expect(view!.container.querySelector('[data-severity="info"]')).toBeTruthy();
  });

  it("INFO auto-hides after ~6s and shows no dismiss control", () => {
    vi.useFakeTimers();
    setMock({
      notice: { id: "info-1", message: "Heads up", severity: "info", effectiveAtMs: null, expiresAtMs: Date.now() + 3_600_000, createdAtMs: 0 },
      severity: "info",
      bannerVisible: false,
    });
    render();
    expect(view!.container.textContent).toContain("Heads up");
    expect(view!.container.querySelector("button")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(view!.container.firstChild).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(view!.container.firstChild).toBeNull();
  });

  it("WARNING shows a dismiss button wired to the shared dismiss(), and hides once dismissed", () => {
    setMock({
      notice: { id: "w1", message: "Maintenance soon", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 60_000, createdAtMs: 0 },
      severity: "warning",
      dismissed: false,
    });
    render();
    const dismissButton = view!.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]');
    expect(dismissButton).toBeTruthy();
    dismissButton!.click();
    expect(dismissMock).toHaveBeenCalledTimes(1);

    // The provider is the source of truth for `dismissed` — simulate its
    // update and re-render, same as the real shared-state flow.
    setMock({ dismissed: true });
    view!.rerender(<NoticeOverlayStrip />);
    expect(view!.container.firstChild).toBeNull();
  });

  it("CRITICAL always renders, with no dismiss control ever", () => {
    setMock({
      notice: { id: "c1", message: "Server going down", severity: "critical", effectiveAtMs: null, expiresAtMs: null, createdAtMs: 0 },
      severity: "critical",
    });
    render();
    expect(view!.container.textContent).toContain("Server going down");
    expect(view!.container.querySelector("button")).toBeNull();
  });

  it("carries a non-blocking pointer-events posture: the strip container opts out, only its own dismiss button opts back in (CSS hook, not real hit-testing — jsdom applies no cascade, so this pins the module CSS itself, same as Toast.test.tsx's reduced-motion check)", () => {
    setMock({
      notice: { id: "w1", message: "Maintenance soon", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 60_000, createdAtMs: 0 },
      severity: "warning",
      dismissed: false,
    });
    render();
    // The DOM hook: exactly one dismiss button, a descendant of the strip.
    const strip = view!.container.firstElementChild as HTMLElement;
    const dismissButton = view!.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]')!;
    expect(strip.contains(dismissButton)).toBe(true);

    // The CSS itself: container opts OUT, the dismiss button opts back IN.
    const css = readFileSync(path.join(__dirname, "NoticeOverlayStrip.module.css"), "utf8");
    const stripRuleMatch = /\.strip\s*\{([\s\S]*?)\}/.exec(css);
    const dismissRuleMatch = /\.dismiss\s*\{([\s\S]*?)\}/.exec(css);
    expect(stripRuleMatch, "expected a .strip rule in NoticeOverlayStrip.module.css").not.toBeNull();
    expect(dismissRuleMatch, "expected a .dismiss rule in NoticeOverlayStrip.module.css").not.toBeNull();
    expect(stripRuleMatch![1]).toContain("pointer-events: none");
    expect(dismissRuleMatch![1]).toContain("pointer-events: auto");
  });

  it("shows the same live countdown format as the shell banner when effectiveAtMs is set", () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    setMock({
      notice: { id: "restart", message: "Restarting soon", severity: "critical", effectiveAtMs: now + 4 * 60_000 + 5000, expiresAtMs: null, createdAtMs: 0 },
      severity: "critical",
      serverOffsetMs: 0,
    });
    render();
    expect(view!.container.textContent).toContain("Restarting in 4:05");
  });
});
