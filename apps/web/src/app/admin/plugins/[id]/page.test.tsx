// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/admin/plugins/[id]/page.test.tsx
//
// LD-8 (Settings-Plugins consolidation) pinning test: /admin/plugins/<id>
// is now a redirect-only stub into /settings/plugins/<id>, preserving the
// id segment — the admin Dashboard's former plugin detail page moved
// there. Exercises AdminPluginDetailRedirect.tsx directly (plain `id`
// prop) rather than driving page.tsx's `use(params)` Suspense unwrapping —
// same split app/claim/[token]/page.tsx + ClaimScreen.tsx already use for
// testability.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../../components/ui/test-render.js";

const routerReplace = vi.fn();
const router = { push: vi.fn(), replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const { AdminPluginDetailRedirect } = await import("./AdminPluginDetailRedirect.js");

let view: TestRender | undefined;

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("AdminPluginDetailRedirect", () => {
  it("replaces to /settings/plugins/<id>, preserving the id, and renders nothing", async () => {
    view = renderIntoBody(<AdminPluginDetailRedirect id="abc-123" />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/settings/plugins/abc-123");
    expect(view.container.textContent).toBe("");
  });
});
