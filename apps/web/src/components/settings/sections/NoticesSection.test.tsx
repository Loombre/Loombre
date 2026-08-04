// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: NoticesSection tests — composition-level coverage. Per-card
// behavior (presets/validation/replace-confirm, cancel/404-handling) is
// covered in ComposeNoticeCard.test.tsx / ActiveNoticeCard.test.tsx; this
// file proves NoticesSection wires the shared GET /system/notices fetch
// correctly into all three children (MailSection.test.tsx's own
// composition-vs-per-card split, applied here), the cursor "Load more"
// path, and the live notice.published/notice.cancelled refresh
// subscription (MailSection.test.tsx shows the events-socket mock
// pattern; admin-dashboard-live.ts shows the subscribe shape).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    super(`status ${status}`);
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { NoticesSection } = await import("./NoticesSection.js");

const now = Date.now();

const ACTIVE_NOTICE = {
  id: "n1",
  message: "Currently active notice",
  severity: "warning",
  effectiveAtMs: null,
  expiresAtMs: now + 3_600_000,
  createdAtMs: now - 1_000,
  createdBy: "aaaaaaaa-0000-0000-0000-000000000000",
  cancelledAtMs: null,
  status: "active",
};
const CANCELLED_NOTICE = {
  id: "n0",
  message: "Older cancelled notice",
  severity: "info",
  effectiveAtMs: null,
  expiresAtMs: now - 1_000,
  createdAtMs: now - 100_000,
  createdBy: null,
  cancelledAtMs: now - 50_000,
  status: "cancelled",
};
const EXPIRED_NOTICE = {
  id: "n-2",
  message: "Even older, long since expired",
  severity: "info",
  effectiveAtMs: null,
  expiresAtMs: now - 500_000,
  createdAtMs: now - 900_000,
  createdBy: null,
  cancelledAtMs: null,
  status: "expired",
};

const PAGE1 = { items: [ACTIVE_NOTICE, CANCELLED_NOTICE], nextCursor: "cursor-abc" };
const PAGE2 = { items: [EXPIRED_NOTICE], nextCursor: null };

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
  apiGetMock.mockImplementation((path: string, options?: { params?: { query?: { cursor?: string } } }) => {
    if (path !== "/system/notices") return Promise.reject(new Error(`unexpected path ${path}`));
    const cursor = options?.params?.query?.cursor;
    if (!cursor) return Promise.resolve(PAGE1);
    if (cursor === "cursor-abc") return Promise.resolve(PAGE2);
    return Promise.reject(new Error(`unexpected cursor ${String(cursor)}`));
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function render(): Promise<void> {
  view = renderIntoBody(<NoticesSection heading="Notices" />);
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) {
    throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  }
  return match;
}

describe("NoticesSection — composition", () => {
  it("fetches the first page and wires the active row into ActiveNoticeCard + ComposeNoticeCard + history", async () => {
    await render();
    expect(apiGetMock).toHaveBeenCalledWith("/system/notices", { params: { query: { limit: 20 } } });

    // Active card rendered its real-notice branch (not the empty state) —
    // "Cancel notice…" only exists once a real active notice was passed in.
    expect(textOf()).not.toContain("No active notice");
    expect(buttonByText("Cancel notice")).toBeTruthy();
    expect(textOf()).toContain("Currently active notice");
    // Compose card mounted.
    expect(textOf()).toContain("Compose notice");
    // History panel — both rows, newest-first order preserved from the page.
    expect(textOf()).toContain("Older cancelled notice");
    expect(textOf()).toContain("· 2");
  });

  it('gates the compose card\'s Publish behind a replace-confirm naming the active notice', async () => {
    await render();
    const textarea = document.body.querySelector("textarea");
    if (!textarea) throw new Error("no textarea");
    const proto = Object.getPrototypeOf(textarea);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    await act(async () => {
      setter?.call(textarea, "A brand new notice");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const expirySelect = Array.from(document.body.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.textContent === "1 hour"),
    );
    if (!expirySelect) throw new Error("no expiry select");
    const selectProto = Object.getPrototypeOf(expirySelect);
    const selectSetter = Object.getOwnPropertyDescriptor(selectProto, "value")?.set;
    await act(async () => {
      selectSetter?.call(expirySelect, "1h");
      expirySelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      buttonByText("Publish notice").click();
    });
    expect(textOf()).toContain("Replace the current notice?");
    expect(textOf()).toContain("Currently active notice");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('"Load more" fetches the next cursor page and appends to the history list', async () => {
    await render();
    expect(textOf()).not.toContain(EXPIRED_NOTICE.message);

    await act(async () => {
      buttonByText("Load more").click();
    });

    expect(apiGetMock).toHaveBeenCalledWith("/system/notices", { params: { query: { cursor: "cursor-abc", limit: 20 } } });
    expect(textOf()).toContain(EXPIRED_NOTICE.message);
    expect(textOf()).toContain("· 3");
    // nextCursor is now null — the button disappears.
    const stillThere = Array.from(document.body.querySelectorAll("button")).some((b) =>
      (b.textContent ?? "").includes("Load more"),
    );
    expect(stillThere).toBe(false);
  });

  it("subscribes to notice.published/notice.cancelled and refetches when either fires", async () => {
    await render();
    const publishedCall = subscribeMock.mock.calls.find((c) => c[0] === "notice.published");
    const cancelledCall = subscribeMock.mock.calls.find((c) => c[0] === "notice.cancelled");
    expect(publishedCall).toBeTruthy();
    expect(cancelledCall).toBeTruthy();

    apiGetMock.mockClear();
    const publishedHandler = publishedCall?.[1] as (() => void) | undefined;
    await act(async () => {
      publishedHandler?.();
    });
    expect(apiGetMock).toHaveBeenCalledWith("/system/notices", { params: { query: { limit: 20 } } });
  });
});
