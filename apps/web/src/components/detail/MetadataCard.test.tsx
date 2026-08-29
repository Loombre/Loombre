// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/MetadataCard.test.tsx
//
// Regression guard (QA 2026-08-21, browser-casual-F1, P2): the METADATA
// card rendered FIX MATCH for EVERY viewer — the component took no
// isAdmin prop at all — and opening it fired
// POST /admin/items/{id}/match-search, which the server's requireAdmin
// correctly 403s. A non-admin therefore got a sheet that opened and
// immediately dead-ended on a bare "Forbidden" paragraph. Server
// enforcement was never the bug (no privilege escalation); the AFFORDANCE
// leaked. FIX MATCH is now admin-gated and simply isn't rendered for a
// non-admin — the same posture as the sidebar's SYSTEM group and the
// command palette's admin entries.
//
// The gate is UX, not a security boundary (that stays server-side), so
// these cases also pin the fail-closed default: while GET /users/me is
// still in flight the caller has no verdict yet and passes `false`, so no
// admin-only chrome ever flashes.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

// FixMatch renders SheetOrModal -> useMediaQuery -> window.matchMedia,
// which jsdom doesn't implement (same stub as MovieDetailScreen.test.tsx).
function installMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  );
}

const apiPostMock = vi.fn();

class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

const subscribeMock = vi.fn(() => () => undefined);

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

// Imported AFTER the mocks so the component picks them up (same
// convention as MovieDetailScreen.test.tsx / AlbumDetailScreen.test.tsx).
const { MetadataCard } = await import("./MetadataCard.js");

function buttonsIn(view: TestRender): HTMLButtonElement[] {
  return Array.from(view.container.querySelectorAll("button"));
}

function fixMatchButton(view: TestRender): HTMLButtonElement | undefined {
  return buttonsIn(view).find((b) => b.textContent === "Fix match");
}

function renderCard(isAdmin: boolean): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <MetadataCard itemId="item-1" itemTitle="Harbor Lights" isAdmin={isAdmin} people={[]} defaultFile={undefined} addedAtMs={0} />
    </ToastProvider>,
  );
}

describe("MetadataCard FIX MATCH admin gate", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiPostMock.mockReset();
    subscribeMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("REGRESSION GUARD: does not render FIX MATCH for a non-admin viewer", () => {
    installMatchMedia();
    view = renderCard(false);

    expect(fixMatchButton(view)).toBeUndefined();
    expect(view.container.textContent).not.toContain("Fix match");
  });

  it("REGRESSION GUARD: mounts no FixMatch sheet for a non-admin, so no admin request can ever fire", () => {
    installMatchMedia();
    view = renderCard(false);

    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("still renders the card's own rows for a non-admin (only the admin action is gated)", () => {
    installMatchMedia();
    view = renderCard(false);

    expect(view.container.textContent).toContain("METADATA");
    expect(view.container.textContent).toContain("Director");
    expect(view.container.textContent).toContain("Added");
  });

  it("renders FIX MATCH for an admin, and opening it starts the match search", () => {
    installMatchMedia();
    apiPostMock.mockReturnValue(new Promise(() => {}));
    view = renderCard(true);

    const button = fixMatchButton(view);
    expect(button).toBeDefined();

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(apiPostMock).toHaveBeenCalledWith("/admin/items/{id}/match-search", { params: { path: { id: "item-1" } } });
  });
});
