// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteDevicesPanel tests — STATE.md "Loombre Remote ..."
// mission item 3 (lane U3). Covers the device list rendering (name, user,
// tunnel IP, enrolled/last-handshake timestamps incl. "never" when null),
// the 501 honest-unavailable fallback (WG2 hasn't landed on this base),
// the inline danger-confirm revoke flow (ActiveNoticeCard.tsx's pattern),
// a 404-during-revoke treated as already-gone, cursor pagination, the
// both-breakpoints matchMedia smoke test, and (WG3, mission item 2) the
// "Enroll a device" header action opening the shared RemoteEnrollCeremony
// end to end.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import type { components } from "@loombre/sdk";

type RemoteWireguardDevice = components["schemas"]["RemoteWireguardDevice"];
type User = components["schemas"]["User"];

const apiGetMock = vi.fn();
const apiDeleteMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `status ${status}`;
    super(title);
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { RemoteDevicesPanel } = await import("./RemoteDevicesPanel.js");

// WG3: EnrollDeviceSheet (rendered unconditionally inside RemoteDevicesPanel,
// just `open={false}` until "Enroll a device" is clicked) uses SheetOrModal,
// whose useMediaQuery hook calls window.matchMedia on EVERY render
// regardless of `open` — jsdom has no matchMedia implementation at all
// (SheetOrModal.test.tsx's own header note, InvitesPanel.test.tsx's own
// identical precedent for CreateInviteSheet) — every test below needs this
// stub even the ones that never open the enroll sheet.
type Listener = (event: { matches: boolean }) => void;
function installMatchMedia(matches = false): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
}

function device(overrides: Partial<RemoteWireguardDevice> = {}): RemoteWireguardDevice {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    userId: "22222222-2222-7222-8222-222222222222",
    name: "Alex's iPhone",
    tunnelIp: "10.82.146.2",
    createdAtMs: Date.now() - 86_400_000,
    lastHandshakeAtMs: Date.now() - 60_000,
    ...overrides,
  };
}

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  apiDeleteMock.mockReset();
  apiPostMock.mockReset();
  installMatchMedia();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  view = renderIntoBody(<RemoteDevicesPanel />);
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  return match;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

describe("RemoteDevicesPanel — list rendering", () => {
  it("renders name, userId, tunnel IP, enrolled + last-handshake timestamps", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    await render();
    expect(textOf()).toContain("Alex's iPhone");
    expect(textOf()).toContain("22222222-2222-7222-8222-222222222222");
    expect(textOf()).toContain("10.82.146.2");
    expect(textOf()).toContain("Enrolled");
    expect(textOf()).toContain("last handshake");
  });

  it('shows "never" for a device that has never completed a handshake', async () => {
    apiGetMock.mockResolvedValue({ items: [device({ lastHandshakeAtMs: null })], nextCursor: null });
    await render();
    expect(textOf()).toContain("last handshake never");
  });

  it("shows an empty state when the list is empty", async () => {
    apiGetMock.mockResolvedValue({ items: [], nextCursor: null });
    await render();
    expect(textOf()).toContain("No enrolled devices");
  });

  it("shows an honest 501 fallback when this build doesn't support Remote devices yet (WG2 not landed)", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render();
    expect(textOf()).toContain("Not available on this build yet");
  });

  it("shows an error for a non-501 failure", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(500, { title: "boom" }));
    await render();
    expect(textOf()).toContain("boom");
  });

  it('"Load more" fetches the next cursor page and appends', async () => {
    apiGetMock.mockImplementation((_path: string, options?: { params?: { query?: { cursor?: string } } }) => {
      const cursor = options?.params?.query?.cursor;
      if (!cursor) return Promise.resolve({ items: [device({ id: "d1", name: "First" })], nextCursor: "c2" });
      if (cursor === "c2") return Promise.resolve({ items: [device({ id: "d2", name: "Second" })], nextCursor: null });
      return Promise.reject(new Error(`unexpected cursor ${cursor}`));
    });
    await render();
    expect(textOf()).toContain("First");
    expect(textOf()).not.toContain("Second");

    await click("Load more");
    expect(textOf()).toContain("First");
    expect(textOf()).toContain("Second");
  });
});

describe("RemoteDevicesPanel — revoke (inline danger-confirm)", () => {
  it("shows a danger confirm block before revoking; Cancel makes no API call", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    await render();
    await click("Revoke…");
    expect(textOf()).toContain('Revoke "Alex\'s iPhone"?');
    expect(apiDeleteMock).not.toHaveBeenCalled();
    await click("Cancel");
    expect(textOf()).not.toContain('Revoke "Alex\'s iPhone"?');
  });

  it("confirming DELETEs the device and removes it from the list on success", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    apiDeleteMock.mockResolvedValue(undefined);
    await render();
    await click("Revoke…");
    await click("Revoke");
    expect(apiDeleteMock).toHaveBeenCalledWith("/admin/remote/wireguard/devices/{id}", {
      params: { path: { id: "11111111-1111-7111-8111-111111111111" } },
    });
    expect(textOf()).toContain("No enrolled devices");
  });

  it("treats a 404 during revoke as already-gone — removes it locally, no error banner", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    apiDeleteMock.mockRejectedValue(new FakeApiError(404, { title: "Not Found", status: 404 }));
    await render();
    await click("Revoke…");
    await click("Revoke");
    expect(textOf()).toContain("No enrolled devices");
    expect(textOf()).not.toContain("status 404");
  });

  it("a 501 during revoke is shown honestly inline, not as a generic error", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    apiDeleteMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render();
    await click("Revoke…");
    await click("Revoke");
    expect(textOf()).toContain("isn't available in this build yet");
    expect(textOf()).toContain("Alex's iPhone"); // still in the list — nothing was actually revoked
  });

  it("a real failure shows an error banner and returns to an actionable state", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    apiDeleteMock.mockRejectedValue(new FakeApiError(500, { title: "boom" }));
    await render();
    await click("Revoke…");
    await click("Revoke");
    expect(textOf()).toContain("boom");
  });
});

describe("RemoteDevicesPanel — Enroll a device (WG3, mission item 2: shared ceremony)", () => {
  const USERS_PAGE = {
    items: [{ id: "u1", username: "alex", displayName: "Alex", email: null, isAdmin: false, birthDate: null, maxContentRating: null, createdAtMs: 1, updatedAtMs: 1 } as User],
    nextCursor: null,
  };
  const ENROLLMENT_CONFIG_TEXT =
    "[Interface]\nPrivateKey = abc123\nAddress = 10.82.146.5/24\n\n[Peer]\nPublicKey = def456\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.82.146.1/32\nPersistentKeepalive = 25\n";
  const ENROLLMENT_RESPONSE = {
    device: { id: "d9", userId: "u1", name: "Alex's tablet", tunnelIp: "10.82.146.5", createdAtMs: 1, lastHandshakeAtMs: null },
    configText: ENROLLMENT_CONFIG_TEXT,
  };

  /** Routes apiGet by path — RemoteEnrollCeremony (rendered inside the
   *  sheet) fetches /users, while RemoteDevicesPanel itself fetches
   *  /admin/remote/wireguard/devices; both share the ONE mocked apiGet. */
  function mockGetByPath(devicesPage: { items: RemoteWireguardDevice[]; nextCursor: string | null }): void {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve(USERS_PAGE);
      if (path === "/admin/remote/wireguard/devices") return Promise.resolve(devicesPage);
      return Promise.reject(new Error(`unexpected apiGet path ${path}`));
    });
  }

  function setNativeValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it('shows an "Enroll a device" header action that opens the SAME ceremony the wizard uses', async () => {
    mockGetByPath({ items: [], nextCursor: null });
    await render();
    expect(buttonByText("Enroll a device")).toBeTruthy();

    await click("Enroll a device");
    expect(textOf()).toContain("Pick who this device belongs to");
    expect(textOf()).toContain("Alex"); // the user picker, loaded via GET /users
  });

  it("full ceremony: submit -> one-time QR/config reveal -> confirm -> Continue closes the sheet and refreshes the device list", async () => {
    mockGetByPath({ items: [], nextCursor: null });
    apiPostMock.mockResolvedValue(ENROLLMENT_RESPONSE);
    await render();
    await click("Enroll a device");

    await act(async () => {
      const nameInput = document.body.querySelector('input[placeholder*="iPhone"]') as HTMLInputElement;
      setNativeValue(nameInput, "Alex's tablet");
    });
    await click("Enroll device");

    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/wireguard/devices", { body: { userId: "u1", name: "Alex's tablet" } });
    expect(textOf()).toContain("shown once");
    expect(document.body.querySelector("svg")).not.toBeNull(); // the QR code

    // The panel's own post-enrollment refetch will hit this updated page.
    mockGetByPath({ items: [device({ id: "d9", name: "Alex's tablet" })], nextCursor: null });

    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    await click("Continue");

    // The sheet closed (desktop dialog unmounts immediately, matchMedia
    // stubbed to matches:false above) and the list refetched — the newly
    // enrolled device now appears.
    expect(textOf()).not.toContain("shown once");
    expect(textOf()).toContain("Alex's tablet");
    expect(apiGetMock).toHaveBeenCalledWith("/admin/remote/wireguard/devices", expect.anything());
  });

  it("Cancel closes the sheet without enrolling anything", async () => {
    mockGetByPath({ items: [], nextCursor: null });
    await render();
    await click("Enroll a device");
    expect(textOf()).toContain("Pick who this device belongs to");

    await click("Cancel");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(textOf()).not.toContain("Pick who this device belongs to");
  });
});

describe("RemoteDevicesPanel — both breakpoints (matchMedia stub convention)", () => {
  it("renders the same content whether the phone media query matches or not", async () => {
    apiGetMock.mockResolvedValue({ items: [device()], nextCursor: null });
    installMatchMedia(true);
    await render();
    expect(textOf()).toContain("Alex's iPhone");
    view?.unmount();
    view = undefined;

    installMatchMedia(false);
    await render();
    expect(textOf()).toContain("Alex's iPhone");
  });
});
