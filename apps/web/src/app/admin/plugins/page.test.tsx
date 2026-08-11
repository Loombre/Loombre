// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/admin/plugins/page.test.tsx
//
// LD-8 (Settings-Plugins consolidation) pinning test: /admin/plugins is now
// a redirect-only stub into /settings/plugins (the admin Dashboard's
// former "Plugins" tab moved there — see page.tsx's own header). This is
// the "one test pinning the redirect/removal" the consolidation task
// called for — no such test existed for the page it replaces (the former
// list+register page had no dedicated spec file of its own; its
// functional coverage is RegisteredPluginsPanel.test.tsx at the new
// location instead).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const routerReplace = vi.fn();
const router = { push: vi.fn(), replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const { default: AdminPluginsRedirectPage } = await import("./page.js");

let view: TestRender | undefined;

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("AdminPluginsRedirectPage", () => {
  it("replaces to /settings/plugins and renders nothing", async () => {
    view = renderIntoBody(<AdminPluginsRedirectPage />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/settings/plugins");
    expect(view.container.textContent).toBe("");
  });
});
