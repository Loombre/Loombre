// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/RestrictedLockControl.test.tsx
//
// browser-items-F3 (2026-08-21 QA, P2 — "state honesty"): after a full-page
// reload inside a live server-side unlock window, the header lock indicator
// read `data-unlocked=false` / "Restricted content locked — tap to unlock"
// while the same page rendered a restricted movie's detail in full — the
// server was still honouring the unlock (gate 5 is re-verified per request
// from user_settings.restricted_unlocked_until_ms, a row a reload does not
// touch). Mixed signal: the user believes the zone is locked while
// restricted content is being served to them. The control was also
// FUNCTIONALLY inverted in that state — tapping the "locked" indicator
// opened the PIN keypad (a pointless re-unlock, burning the 5/min unlock
// budget) instead of offering the lock action the zone actually needed.
//
// This is the header-level regression check for that user-visible symptom.
// It renders the REAL RestrictedLockControl inside the REAL
// RestrictedProvider (no mocked useRestricted — the whole defect lived in
// the provider→indicator seam, so a mocked context would have proved
// nothing) and asserts the rendered indicator, not provider internals;
// RestrictedProvider.test.tsx covers the bootstrap state machine itself.
//
// Harness: api-client / auth-store / events-socket / catalog-invalidation
// mocked and the modules under test imported afterwards (this directory's
// convention — QuickSearch.test.tsx, UserMenu.test.tsx). The api-client
// mock is PATH-AWARE, so a regression back to the old
// GET /users/me/settings-only bootstrap shows up as a locked indicator,
// not as a mock explosion. `hasRestrictedZoneEntitlement` stays the REAL
// predicate; only the network-backed count hook is faked (UserMenu's
// posture).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status = 0;
}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

let authenticated = true;
const authListeners = new Set<() => void>();

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    subscribe: (listener: () => void) => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  }),
}));

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: () => () => {}, setRestrictedZoneSubscribed: () => {} }),
}));

vi.mock("../../lib/catalog-invalidation.js", () => ({
  emitCatalogInvalidation: () => {},
}));

let restrictedCount: number | null = 3;
vi.mock("../../lib/restricted-zone-count.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/restricted-zone-count.js")>(
    "../../lib/restricted-zone-count.js",
  );
  return {
    hasRestrictedZoneEntitlement: actual.hasRestrictedZoneEntitlement,
    useRestrictedZoneCount: () => ({ count: restrictedCount, loading: false }),
  };
});

const { RestrictedProvider, useRestricted } = await import("../restricted/RestrictedProvider.js");
const { RestrictedLockControl } = await import("./RestrictedLockControl.js");

const NOW = 1_700_000_000_000;

/** What GET /users/me/restricted (RestrictedSettings) returns for this load. */
let restrictedGetResponse: { optIn: boolean; hasPin: boolean; unlockedUntilMs: number | null } = {
  optIn: false,
  hasPin: false,
  unlockedUntilMs: null,
};

/** The PIN keypad is driven purely by RestrictedProvider's `modalOpen`
 *  (PinModal.tsx renders nothing when it is false), so this stands in for
 *  "tapping the indicator opened the keypad" without dragging the modal's
 *  own harness in. */
function ModalProbe(): React.JSX.Element {
  const { state } = useRestricted();
  return <span data-testid="modalOpen">{String(state.modalOpen)}</span>;
}

describe("RestrictedLockControl (header lock indicator)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({});
    authenticated = true;
    authListeners.clear();
    restrictedCount = 3;
    restrictedGetResponse = { optIn: false, hasPin: false, unlockedUntilMs: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me/restricted") return Promise.resolve({ ...restrictedGetResponse });
      if (path === "/users/me/settings") return Promise.resolve({ restrictedOptIn: restrictedGetResponse.optIn });
      throw new Error(`unexpected apiGet(${path})`);
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  /** One fresh page load (mount) with whatever the server currently says. */
  async function reload(): Promise<void> {
    view = renderIntoBody(
      <RestrictedProvider>
        <RestrictedLockControl />
        <ModalProbe />
      </RestrictedProvider>,
    );
    await act(async () => {});
  }

  function indicator(): HTMLButtonElement | null {
    return view!.container.querySelector("button");
  }

  function modalOpen(): string {
    return view!.container.querySelector('[data-testid="modalOpen"]')?.textContent ?? "";
  }

  async function tapIndicator(): Promise<void> {
    await act(async () => {
      indicator()!.click();
    });
  }

  it("reads UNLOCKED after a reload inside a live server-side unlock window", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW + 25 * 60_000 };

    await reload();

    const button = indicator()!;
    expect(button.getAttribute("data-unlocked")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Restricted content unlocked — tap to lock");
  });

  it("offers the LOCK action (not the PIN keypad) after that reload", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW + 25 * 60_000 };

    await reload();
    await tapIndicator();

    expect(apiPostMock).toHaveBeenCalledWith("/restricted/lock");
    expect(apiPostMock).not.toHaveBeenCalledWith("/restricted/unlock", expect.anything());
    expect(modalOpen()).toBe("false");
    expect(indicator()!.getAttribute("data-unlocked")).toBe("false");
  });

  it("reads LOCKED and opens the PIN keypad when the server reports no live window", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: null };

    await reload();

    const button = indicator()!;
    expect(button.getAttribute("data-unlocked")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Restricted content locked — tap to unlock");

    await tapIndicator();
    expect(modalOpen()).toBe("true");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("fails closed: an already-elapsed window reads LOCKED", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW - 1 };

    await reload();

    expect(indicator()!.getAttribute("data-unlocked")).toBe("false");
  });

  it("fails closed: a failed bootstrap reads LOCKED", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError("network down"));
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW + 25 * 60_000 };

    await reload();

    expect(indicator()!.getAttribute("data-unlocked")).toBe("false");
  });

  it("renders no indicator at all for a viewer with no zone entitlement, even inside a window", async () => {
    restrictedCount = null;
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW + 25 * 60_000 };

    await reload();

    expect(indicator()).toBeNull();
  });
});
