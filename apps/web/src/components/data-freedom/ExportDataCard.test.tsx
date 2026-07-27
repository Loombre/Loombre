// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/data-freedom/ExportDataCard.test.tsx
//
// Covers the defect this component fixes (77-agent review finding
// "GET /export (data-freedom archive download) has zero UI anywhere in
// apps/web" — see ExportDataCard.tsx's own header):
//   1. Clicking the button hits GET /export and actually materializes a
//      downloadable file (not just a fetch nobody does anything with).
//   2. A 429 (packages/shared/src/settings-registry.ts's rateLimit.export,
//      default 5/hour) surfaces an explicit, actionable message rather than
//      the generic RFC 9457 title, and never fires a download.
//   3. Any other failure still surfaces the server's message.
//
// apiGet is mocked and the module under test imported afterwards — the
// established convention here (AccountSection.test.tsx). jsdom implements
// neither URL.createObjectURL/revokeObjectURL nor a real anchor click, so
// both are stubbed per-test.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

const { ExportDataCard } = await import("./ExportDataCard.js");

const ARCHIVE = {
  exportedAtMs: 1_700_000_000_000,
  users: [],
  libraries: [],
  items: [],
  progress: [],
  playlists: [],
};

describe("ExportDataCard", () => {
  let view: TestRender | null = null;
  // The clicked anchor is handed to the spy as an ARGUMENT rather than aliased
  // out of `this` into a local (@typescript-eslint/no-this-alias), so
  // `clickSpy.mock.calls[n][0]` is the element each download materialized.
  let clickSpy: Mock<(anchor: HTMLAnchorElement) => void>;
  let createObjectURLSpy: ReturnType<typeof vi.fn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiGetMock.mockReset();
    clickSpy = vi.fn<(anchor: HTMLAnchorElement) => void>();
    createObjectURLSpy = vi.fn(() => "blob:mock-url");
    revokeObjectURLSpy = vi.fn();
    URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLSpy as unknown as typeof URL.revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickSpy(this);
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<ExportDataCard />);
    await act(async () => {});
  }

  function button(): HTMLButtonElement {
    return view!.container.querySelector("button")!;
  }

  async function click(): Promise<void> {
    await act(async () => {
      button().click();
    });
  }

  it("downloads the archive returned by GET /export", async () => {
    apiGetMock.mockResolvedValueOnce(ARCHIVE);
    await render();
    await click();

    expect(apiGetMock).toHaveBeenCalledWith("/export");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy.mock.calls[0]?.[0].download).toMatch(/^loombre-export-.*\.json$/);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");
  });

  it("a 429 (the 5/hour export limit) surfaces an explicit retry message and never downloads", async () => {
    apiGetMock.mockRejectedValueOnce(new FakeApiError(429, "Too Many Requests"));
    await render();
    await click();

    expect(view!.container.textContent ?? "").toMatch(/5 per hour/i);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("any other failure surfaces the server's message", async () => {
    apiGetMock.mockRejectedValueOnce(new FakeApiError(401, "Session expired."));
    await render();
    await click();

    expect(view!.container.textContent ?? "").toMatch(/Session expired\./);
  });
});
