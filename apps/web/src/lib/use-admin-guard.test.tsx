// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/use-admin-guard.test.tsx
//
// opus-review LD wave, Finding 6: hook-level coverage for the extracted
// useAdminGuard, mirroring use-watched-state.test.tsx's Probe-component
// pattern (this repo's established convention — no @testing-library/react,
// no react-hooks testing library). The extraction is a pure refactor (SAME
// fetch/redirect behavior three call sites previously hand-copied), so this
// isn't pinning a NEW behavior — it's proving the shared implementation
// itself, independent of any one call site, covers null/true/false/reject
// exactly like each of those three inline copies did before.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const routerReplace = vi.fn();
const router = { push: vi.fn(), replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const apiGetMock = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

const { useAdminGuard } = await import("./use-admin-guard.js");

let latestIsAdmin: boolean | null = "pending" as unknown as boolean | null;

function Probe({ redirectTo }: { redirectTo: string }): null {
  latestIsAdmin = useAdminGuard(redirectTo).isAdmin;
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useAdminGuard", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    latestIsAdmin = "pending" as unknown as boolean | null;
    routerReplace.mockReset();
    apiGetMock.mockReset();
  });

  it("starts null while GET /users/me is in flight, and never redirects during that window", () => {
    apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves
    view = renderIntoBody(<Probe redirectTo="/profile" />);
    expect(latestIsAdmin).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("resolves true and does not redirect when GET /users/me reports isAdmin:true", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: true });
    view = renderIntoBody(<Probe redirectTo="/profile" />);
    await flush();
    expect(latestIsAdmin).toBe(true);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("resolves false and redirects to the given redirectTo when isAdmin:false", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: false });
    view = renderIntoBody(<Probe redirectTo="/profile" />);
    await flush();
    expect(latestIsAdmin).toBe(false);
    expect(routerReplace).toHaveBeenCalledWith("/profile");
  });

  it("fails closed (isAdmin:false, redirects) when GET /users/me rejects", async () => {
    apiGetMock.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<Probe redirectTo="/home" />);
    await flush();
    expect(latestIsAdmin).toBe(false);
    expect(routerReplace).toHaveBeenCalledWith("/home");
  });

  it("respects a different redirectTo per caller (e.g. /admin/* -> /home vs. /settings* -> /profile)", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: false });
    view = renderIntoBody(<Probe redirectTo="/home" />);
    await flush();
    expect(routerReplace).toHaveBeenCalledWith("/home");
    expect(routerReplace).not.toHaveBeenCalledWith("/profile");
  });
});
