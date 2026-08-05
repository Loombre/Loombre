// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/devices/DevicesSection.test.tsx
//
// GET/DELETE /devices have been live since Phase 1 (STATE.md P2.12) but had
// zero UI — a user with a lost/stolen device had no way to see or revoke it
// without direct DB access (77-agent review finding, feature-no-ui). Covers
// the behaviours that make the surface actually useful as a security
// control, not just a list:
//   1. Every device GET /devices returns renders.
//   2. The caller's OWN device (auth-store's persisted deviceId) is labelled
//      and can't be "signed out" from here — revoking your own live session
//      belongs to Account's existing sign-out flow, not this list.
//   3. Sign out on another device calls DELETE /devices/{id} and removes it.
//   4. Empty and error states are real, not silently blank.
//
// apiGet/apiDelete and getAuthStore are mocked and the module under test
// imported afterwards — the established convention here
// (AccountSection.test.tsx, use-watched-state.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const apiDeleteMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({ getSnapshot: () => ({ deviceId: "device-1" }) }),
}));

const { DevicesSection } = await import("./DevicesSection.js");

const DEVICES = [
  {
    id: "device-1",
    userId: "11111111-1111-7111-8111-111111111111",
    name: "This laptop",
    kind: "app",
    profileId: "web-chrome",
    capabilityProfile: null,
    lastSeenAtMs: 1_000,
    createdAtMs: 500,
  },
  {
    id: "device-2",
    userId: "11111111-1111-7111-8111-111111111111",
    name: "Phone",
    kind: "app",
    profileId: "web-safari",
    capabilityProfile: null,
    lastSeenAtMs: 2_000,
    createdAtMs: 800,
  },
];

// WG3 (R2 "enrolled devices appear in the existing devices list (kind:
// remote)"): a device row enrolled through Loombre Remote — same Device
// schema, kind='remote', no capabilityProfile (WG peers never log in
// through the app's own DeviceProfile negotiation).
const REMOTE_DEVICE = {
  id: "device-3",
  userId: "11111111-1111-7111-8111-111111111111",
  name: "Alex's iPhone (Remote)",
  kind: "remote",
  profileId: "remote-wireguard",
  capabilityProfile: null,
  lastSeenAtMs: 3_000,
  createdAtMs: 900,
};

// Module-scoped (not nested inside a single `describe`) so every describe
// block below — including the WG3 kind:'remote' badge coverage, added
// after the original suite — shares the same render/view/buttonFor
// helpers rather than each hand-rolling its own copy.
let view: TestRender | null = null;

async function render(): Promise<void> {
  view = renderIntoBody(<DevicesSection heading={null} />);
  await act(async () => {});
}

function buttonFor(text: string): HTMLButtonElement {
  const button = Array.from(view!.container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`no button labelled "${text}"`);
  return button as HTMLButtonElement;
}

describe("DevicesSection", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiDeleteMock.mockReset();
    apiGetMock.mockImplementation(() => Promise.resolve({ items: DEVICES, nextCursor: null }));
    apiDeleteMock.mockImplementation(() => Promise.resolve(undefined));
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  it("lists every device GET /devices returns", async () => {
    await render();
    expect(apiGetMock).toHaveBeenCalledWith("/devices", expect.anything());
    const text = view!.container.textContent ?? "";
    expect(text).toMatch(/This laptop/);
    expect(text).toMatch(/Phone/);
  });

  it("labels the caller's own device and gives it no sign-out control", async () => {
    await render();
    expect(view!.container.textContent ?? "").toMatch(/This device/);
    const signOutButtons = Array.from(view!.container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "Sign out",
    );
    expect(signOutButtons).toHaveLength(1); // only device-2, never device-1
  });

  it("signing out another device DELETEs /devices/{id} and drops it from the list", async () => {
    await render();
    await act(async () => {
      buttonFor("Sign out").click();
    });
    expect(apiDeleteMock).toHaveBeenCalledWith("/devices/{id}", { params: { path: { id: "device-2" } } });
    expect(view!.container.textContent ?? "").not.toMatch(/Phone/);
  });

  it("shows a real empty state with no devices, not a blank list", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve({ items: [], nextCursor: null }));
    await render();
    expect(view!.container.textContent ?? "").toMatch(/No devices/);
  });

  it("surfaces a server error instead of showing nothing", async () => {
    apiGetMock.mockImplementation(() => Promise.reject(new FakeApiError("Failed to load devices.")));
    await render();
    expect(view!.container.textContent ?? "").toMatch(/Failed to load devices\./);
  });
});

describe("DevicesSection — kind:'remote' badge (WG3, R2)", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiDeleteMock.mockReset();
    apiDeleteMock.mockImplementation(() => Promise.resolve(undefined));
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  it('renders a "Remote" badge with a plain-language tooltip on a kind=\'remote\' row, and none on kind=\'app\' rows', async () => {
    apiGetMock.mockImplementation(() => Promise.resolve({ items: [...DEVICES, REMOTE_DEVICE], nextCursor: null }));
    await render();
    const text = view!.container.textContent ?? "";
    expect(text).toMatch(/Alex's iPhone \(Remote\)/);

    const badges = Array.from(view!.container.querySelectorAll("span")).filter((el) => el.textContent === "Remote");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.getAttribute("title")).toMatch(/WireGuard/);

    // device-1 is "This device" here too (mocked auth-store deviceId) —
    // only device-2 (kind='app') and device-3/REMOTE_DEVICE (kind='remote')
    // are revocable; the badge doesn't change that.
    const rows = Array.from(view!.container.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Sign out");
    expect(rows).toHaveLength(2);
  });

  it("revoke works identically for a kind='remote' row — same DELETE /devices/{id} call as any other device", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve({ items: [REMOTE_DEVICE], nextCursor: null }));
    await render();
    await act(async () => {
      buttonFor("Sign out").click();
    });
    expect(apiDeleteMock).toHaveBeenCalledWith("/devices/{id}", { params: { path: { id: "device-3" } } });
    expect(view!.container.textContent ?? "").toMatch(/No devices/);
  });
});

describe("DevicesSection — both breakpoints (matchMedia stub convention)", () => {
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

  it("renders the same device list, including the Remote badge, whether the phone media query matches or not", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve({ items: [...DEVICES, REMOTE_DEVICE], nextCursor: null }));

    installMatchMedia(true);
    await render();
    expect(view!.container.textContent ?? "").toMatch(/Alex's iPhone \(Remote\)/);
    expect(Array.from(view!.container.querySelectorAll("span")).some((el) => el.textContent === "Remote")).toBe(true);
    view?.unmount();
    view = null;

    installMatchMedia(false);
    await render();
    expect(view!.container.textContent ?? "").toMatch(/Alex's iPhone \(Remote\)/);
    expect(Array.from(view!.container.querySelectorAll("span")).some((el) => el.textContent === "Remote")).toBe(true);
  });
});
