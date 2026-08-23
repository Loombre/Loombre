// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/use-is-admin.test.tsx
//
// browser-casual-F1: hook-level coverage for useIsAdmin, using the same
// Probe-component pattern as use-admin-guard.test.tsx / use-watched-state
// .test.tsx (this repo has no @testing-library/react and no react-hooks
// testing library).
//
// The behaviour that matters to the callers gating admin-only chrome:
// `null` until GET /users/me answers (so nothing renders optimistically),
// `false` on a non-admin AND on a failure (fail closed), and — unlike
// useAdminGuard — NO redirect in any of those cases.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
}));

const apiGetMock = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

const { useIsAdmin } = await import("./use-is-admin.js");

let latest: boolean | null = "pending" as unknown as boolean | null;

function Probe(): null {
  latest = useIsAdmin();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useIsAdmin", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    latest = "pending" as unknown as boolean | null;
    apiGetMock.mockReset();
    routerReplace.mockReset();
  });

  it("is null while GET /users/me is in flight (callers render no admin chrome yet)", () => {
    apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves
    view = renderIntoBody(<Probe />);
    expect(latest).toBeNull();
  });

  it("resolves true for an admin", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: true });
    view = renderIntoBody(<Probe />);
    await flush();
    expect(latest).toBe(true);
  });

  it("resolves false for a non-admin", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: false });
    view = renderIntoBody(<Probe />);
    await flush();
    expect(latest).toBe(false);
  });

  it("resolves false when isAdmin is absent from the response (never truthy by omission)", async () => {
    apiGetMock.mockResolvedValue({ username: "casual" });
    view = renderIntoBody(<Probe />);
    await flush();
    expect(latest).toBe(false);
  });

  it("fails closed (false) when GET /users/me rejects", async () => {
    apiGetMock.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<Probe />);
    await flush();
    expect(latest).toBe(false);
  });

  it("NEVER redirects — this is a content-level read, not the route guard", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: false });
    view = renderIntoBody(<Probe />);
    await flush();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("makes exactly one GET /users/me per mount", async () => {
    apiGetMock.mockResolvedValue({ isAdmin: true });
    view = renderIntoBody(<Probe />);
    await flush();
    expect(apiGetMock.mock.calls.filter((call) => call[0] === "/users/me")).toHaveLength(1);
  });
});
