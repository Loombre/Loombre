// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/BannerRegion.test.tsx
//
// BannerRegion is a pure render of SystemNoticeProvider's shared state
// (that state machine gets its own coverage in
// notices/SystemNoticeProvider.test.tsx) — so this file mocks
// useSystemNotice() directly and drives it through the shapes BannerRegion
// itself must react to correctly: severity accent/role/dismiss-affordance,
// and the live countdown (useNoticeCountdown is REAL here, not mocked —
// that's the interesting logic this file exists to pin, including the
// exit-gate SKEWED CLOCK case).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

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

let mockPathname = "/home";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

const { BannerRegion } = await import("./BannerRegion.js");

function setMock(overrides: Partial<MockValue>): void {
  mockValue = { ...mockValue, ...overrides };
}

describe("BannerRegion", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    dismissMock.mockReset();
    mockValue = defaultMock();
    mockPathname = "/home";
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  function render(): TestRender {
    view = renderIntoBody(<BannerRegion />);
    return view;
  }

  it("renders nothing when bannerVisible is false (info severity, or nothing active)", () => {
    render();
    expect(view!.container.firstChild).toBeNull();
  });

  it("R-F7: sets data-compact-header on back-mode routes (66px chrome) and omits it on title-mode tab roots (112px)", () => {
    setMock({
      notice: { id: "w1", message: "Maintenance", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 60_000, createdAtMs: 0 },
      severity: "warning",
      bannerVisible: true,
    });

    mockPathname = "/settings/notices"; // a settings section = back mode
    render();
    expect(view!.container.querySelector('[data-compact-header="true"]')).toBeTruthy();
    view!.unmount();

    mockPathname = "/home"; // a tab root = title mode
    render();
    expect(view!.container.querySelector("[data-compact-header]")).toBeNull();
  });

  it("renders a warning notice: role=status, message as text, and a dismiss button", () => {
    setMock({
      notice: { id: "n1", message: "Planned maintenance window", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 3_600_000, createdAtMs: 0 },
      severity: "warning",
      bannerVisible: true,
    });
    render();
    expect(view!.container.querySelector('[role="status"]')).toBeTruthy();
    expect(view!.container.querySelector('[role="alert"]')).toBeNull();
    expect(view!.container.textContent).toContain("Planned maintenance window");
    expect(view!.container.querySelector('button[aria-label="Dismiss notice"]')).toBeTruthy();
  });

  it("clicking the dismiss button calls the shared dismiss()", () => {
    setMock({
      notice: { id: "n1", message: "Planned maintenance window", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 3_600_000, createdAtMs: 0 },
      severity: "warning",
      bannerVisible: true,
    });
    render();
    view!.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]')!.click();
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("renders a critical notice: role=alert and NO dismiss affordance while active (N3)", () => {
    setMock({
      notice: { id: "c1", message: "Server going down", severity: "critical", effectiveAtMs: null, expiresAtMs: null, createdAtMs: 0 },
      severity: "critical",
      bannerVisible: true,
    });
    render();
    expect(view!.container.querySelector('[role="alert"]')).toBeTruthy();
    expect(view!.container.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();
  });

  it("renders no countdown UI when effectiveAtMs is null (N1: not every notice has a scheduled moment)", () => {
    setMock({
      notice: { id: "n1", message: "Just an FYI", severity: "warning", effectiveAtMs: null, expiresAtMs: Date.now() + 1000, createdAtMs: 0 },
      severity: "warning",
      bannerVisible: true,
    });
    render();
    expect(view!.container.textContent).not.toMatch(/Restarting/);
  });

  it("SKEWED CLOCK: countdown renders from server truth, not this client's own wall clock", () => {
    vi.useFakeTimers();
    const localNow = 1_700_000_000_000;
    vi.setSystemTime(localNow);
    // The server's clock runs 10 minutes AHEAD of this client's local
    // clock. effectiveAtMs is 5 minutes from the server's own now. A
    // client that computed from Date.now() alone (ignoring the offset)
    // would show 15:00 remaining — wrong.
    const serverNow = localNow + 10 * 60_000;
    const offset = serverNow - localNow;
    const effectiveAtMs = serverNow + 5 * 60_000;
    setMock({
      notice: { id: "restart", message: "Restarting for an update", severity: "critical", effectiveAtMs, expiresAtMs: null, createdAtMs: 0 },
      severity: "critical",
      serverOffsetMs: offset,
      bannerVisible: true,
    });
    render();
    expect(view!.container.textContent).toContain("Restarting in 5:00");
    expect(view!.container.textContent).not.toContain("15:00");
  });

  it("ZERO-STATE: the countdown crosses zero into a static 'Restarting now', never a negative time", () => {
    vi.useFakeTimers();
    const localNow = 1_700_000_000_000;
    vi.setSystemTime(localNow);
    setMock({
      notice: { id: "restart2", message: "Restarting for an update", severity: "warning", effectiveAtMs: localNow + 2000, expiresAtMs: localNow + 600_000, createdAtMs: 0 },
      severity: "warning",
      serverOffsetMs: 0,
      bannerVisible: true,
    });
    render();
    expect(view!.container.textContent).toContain("Restarting in 0:02");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(view!.container.textContent).toContain("Restarting now");
    expect(view!.container.textContent).not.toMatch(/-\d/);
  });
});
