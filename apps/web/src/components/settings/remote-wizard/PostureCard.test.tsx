// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: PostureCard tests — R7's exposure-aware posture card (mission
// item 1, lane U3). Mirrors StreamsPanel.test.tsx's apiGet + events-socket
// mocking convention plus RemoteWizard.test.tsx's both-breakpoints
// matchMedia smoke test (SheetOrModal.test.tsx's stub convention).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import type { components } from "@loombre/sdk";
import type { PathId } from "@loombre/shared/remote";

type RemotePostureCard = components["schemas"]["RemotePostureCard"];

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `status ${status}`;
    super(title);
    this.status = status;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { PostureCard } = await import("./PostureCard.js");

function fixtureCard(overrides: Partial<RemotePostureCard> = {}): RemotePostureCard {
  return {
    checks: [
      {
        key: "tlsValidity",
        grade: "pass",
        detail: "The certificate is valid.",
        fixAction: { label: "Review the Direct path's certificate", href: "/settings/remote-access?path=direct&step=direct-enable" },
      },
      {
        key: "rateLimitersActive",
        grade: "warn",
        detail: "Some limiters are relaxed.",
        fixAction: { label: "Review rate-limit settings", href: "/settings/server?category=rateLimit" },
      },
      {
        key: "staleAccounts",
        grade: "fail",
        detail: "2 accounts have never logged in.",
        fixAction: { label: "Review user accounts", href: "/settings/users" },
      },
      {
        key: "wgPortSilence",
        grade: "info",
        detail: "A server can never confirm its own external silence.",
        fixAction: { label: "Review the Remote (WireGuard) listener", href: "/settings/remote-access?path=remote" },
      },
    ],
    overallGrade: "fail",
    evaluatedAtMs: Date.now(),
    ...overrides,
  };
}

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

async function render(path: PathId = "remote"): Promise<void> {
  view = renderIntoBody(<PostureCard activePath={path} />);
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

describe("PostureCard — fetch + per-grade rendering", () => {
  it("fetches GET /admin/remote/posture on mount", async () => {
    apiGetMock.mockResolvedValue(fixtureCard());
    await render();
    expect(apiGetMock).toHaveBeenCalledWith("/admin/remote/posture");
  });

  it("renders all four grade tones (pass/warn/fail/info) with the correct StatusPill tone + evaluatedAt", async () => {
    apiGetMock.mockResolvedValue(fixtureCard());
    await render();
    const tones = Array.from(document.body.querySelectorAll("[data-tone]")).map((p) => p.getAttribute("data-tone"));
    expect(tones).toContain("success"); // pass
    expect(tones).toContain("warning"); // warn
    expect(tones).toContain("danger"); // fail
    expect(tones).toContain("info"); // info
    expect(textOf()).toContain("TLS certificate");
    expect(textOf()).toContain("The certificate is valid.");
    expect(textOf()).toContain("Checked ");
  });

  it("fix-action hrefs point exactly where posture-model.ts's frozen POSTURE_CHECK_FIX_ACTIONS says", async () => {
    apiGetMock.mockResolvedValue(fixtureCard());
    await render();
    const rateLimitLink = document.body.querySelector('a[href="/settings/server?category=rateLimit"]');
    expect(rateLimitLink).not.toBeNull();
    expect(rateLimitLink?.textContent).toContain("Review rate-limit settings");
    const wgLink = document.body.querySelector('a[href="/settings/remote-access?path=remote"]');
    expect(wgLink).not.toBeNull();
  });

  it("shows an honest inapplicable empty state when checks is empty, naming the caller's own active path", async () => {
    apiGetMock.mockResolvedValue(fixtureCard({ checks: [], overallGrade: "pass" }));
    await render("tunnel");
    expect(textOf()).toContain("No checks apply right now");
    expect(textOf()).toContain("Tunnel");
  });

  it("shows an error message on fetch failure", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(500, { title: "boom" }));
    await render();
    expect(textOf()).toContain("boom");
  });
});

describe("PostureCard — live refresh", () => {
  it("subscribes to posture.regressed/posture.recovered and refetches when either fires", async () => {
    apiGetMock.mockResolvedValue(fixtureCard());
    await render();
    const subscribedTypes = subscribeMock.mock.calls.map(([type]) => type);
    expect(subscribedTypes).toContain("posture.regressed");
    expect(subscribedTypes).toContain("posture.recovered");

    apiGetMock.mockClear();
    const regressedHandler = subscribeMock.mock.calls.find(([type]) => type === "posture.regressed")?.[1] as
      | (() => void)
      | undefined;
    await act(async () => {
      regressedHandler?.();
    });
    expect(apiGetMock).toHaveBeenCalledWith("/admin/remote/posture");
  });

  it("polls on a modest interval as a fallback while mounted", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue(fixtureCard());
    view = renderIntoBody(<PostureCard activePath="remote" />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});

describe("PostureCard — both breakpoints (matchMedia stub convention)", () => {
  // jsdom has no window.matchMedia at all (SheetOrModal.test.tsx's own
  // header); this card never calls useMediaQuery itself (every reflow is
  // plain CSS), so this is a smoke test proving the same content renders
  // at both matchMedia answers, same posture as RemoteWizard.test.tsx's
  // own both-breakpoints test.
  function installMatchMedia(matches: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the same content whether the phone media query matches or not", async () => {
    apiGetMock.mockResolvedValue(fixtureCard());
    installMatchMedia(true);
    await render();
    expect(textOf()).toContain("Security posture");
    view?.unmount();
    view = undefined;

    installMatchMedia(false);
    await render();
    expect(textOf()).toContain("Security posture");
  });
});
