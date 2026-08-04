// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ActiveNoticeCard tests — Settings -> Notices active-notice
// status card (POST /system/notices/{id}/cancel). Mirrors
// ServerPowerCard.test.tsx's harness. Covers: loading skeleton, the calm
// empty state, a real active notice's rendered fields, the danger-tinted
// cancel confirm -> 204 path, and the 404-treated-as-gone path (the
// contract's own "unknown id OR already inactive" ambiguity — never
// surfaced as an error toast).

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type SystemNoticeAdmin = components["schemas"]["SystemNoticeAdmin"];

const apiPostMock = vi.fn();

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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { ActiveNoticeCard } = await import("./ActiveNoticeCard.js");

let view: TestRender | undefined;
const onChangedMock = vi.fn();

const NOTICE: SystemNoticeAdmin = {
  id: "aaaaaaaa-1111-1111-1111-111111111111",
  message: "The server will restart in about 5 minutes.",
  severity: "critical" as const,
  effectiveAtMs: Date.now() + 5 * 60_000,
  expiresAtMs: Date.now() + 15 * 60_000,
  createdAtMs: Date.now() - 1_000,
  createdBy: "bbbbbbbb-2222-2222-2222-222222222222",
  cancelledAtMs: null,
  status: "active" as const,
};

beforeEach(() => {
  apiPostMock.mockReset();
  onChangedMock.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function render(notice: typeof NOTICE | null, loading = false): Promise<void> {
  view = renderIntoBody(<ActiveNoticeCard notice={notice} loading={loading} onChanged={onChangedMock} />);
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

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

describe("ActiveNoticeCard — states", () => {
  it("shows a skeleton while loading", async () => {
    await render(null, true);
    expect(textOf()).not.toContain("No active notice");
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("shows the calm empty state when nothing is active", async () => {
    await render(null, false);
    expect(textOf()).toContain("No active notice");
  });

  it("renders a real active notice's severity, message, and window", async () => {
    await render(NOTICE);
    expect(textOf()).toContain("Critical");
    expect(textOf()).toContain(NOTICE.message);
    expect(textOf()).toContain("Takes effect");
    expect(textOf()).toContain("Expires");
  });

  it('renders "Until cancelled" when expiresAtMs is null', async () => {
    await render({ ...NOTICE, expiresAtMs: null });
    expect(textOf()).toContain("Until cancelled");
  });
});

describe("ActiveNoticeCard — cancel", () => {
  it("shows a confirm step before cancelling; Cancel POSTs and refreshes on 204", async () => {
    apiPostMock.mockResolvedValue(undefined);
    await render(NOTICE);
    await click("Cancel notice");
    expect(textOf()).toContain("Cancel this notice?");
    expect(apiPostMock).not.toHaveBeenCalled();

    await click("Cancel notice"); // the confirm block's own "Cancel notice" button
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]).toEqual([
      "/system/notices/{id}/cancel",
      { params: { path: { id: NOTICE.id } } },
    ]);
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it('"Keep it" backs out of the confirm step without posting', async () => {
    await render(NOTICE);
    await click("Cancel notice");
    await click("Keep it");
    expect(textOf()).not.toContain("Cancel this notice?");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("treats a 404 as already-gone — refreshes silently, no error toast", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(404, { title: "Not Found", status: 404 }));
    await render(NOTICE);
    await click("Cancel notice");
    await click("Cancel notice");
    expect(onChangedMock).toHaveBeenCalledTimes(1);
    expect(textOf()).not.toContain("Failed to cancel notice");
    expect(textOf()).not.toContain("status 404");
  });

  it("a non-404 failure shows the error and returns to an actionable state", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(500, { title: "boom", status: 500 }));
    await render(NOTICE);
    await click("Cancel notice");
    await click("Cancel notice");
    expect(textOf()).toContain("status 500");
    expect(onChangedMock).not.toHaveBeenCalled();
    // Still actionable: the confirm block's own buttons are present again
    // (not stuck disabled).
    expect(buttonByText("Cancel notice")).toBeTruthy();
    expect(buttonByText("Keep it")).toBeTruthy();
  });
});
