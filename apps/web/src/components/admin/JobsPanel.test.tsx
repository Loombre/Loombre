// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/JobsPanel.test.tsx
//
// browser-admin-F13 regression coverage. JobRow renders an "N attempts"
// chip straight off `job.attempts`, so every row GET /admin/jobs returned
// showed it — but a row that arrived (or changed) over the live
// `job.updated` socket could not, because the event payload carried no
// attempts at all: mergeJobUpdate (lib/admin-jobs-live.ts) had nothing to
// merge and hardcoded 0 for a synthesized row. The chip therefore appeared
// only after a full refetch, and the live row's anatomy differed from its
// fetched neighbours'. This file pins the WHOLE path — socket payload ->
// mergeJobUpdate -> rendered chip — rather than only the pure merge, which
// is what the report actually observed.
//
// apiGet and getEventsSocket are mocked, same convention as
// app/admin/sessions/page.test.tsx. jsdom implements neither
// ResizeObserver nor real layout, both of which VirtualList's viewport
// effect needs — stubbed exactly as VirtualPosterGrid.test.tsx does (with
// clientHeight 0 the windowing math still renders the first rows through
// its overscan band, but a real height keeps the intent obvious).

import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import type { Job, JobUpdatedPayload } from "../../lib/admin-jobs-live.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { JobsPanel } = await import("./JobsPanel.js");

let originalClientHeight: PropertyDescriptor | undefined;

beforeAll(() => {
  originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, value: 900 });
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterAll(() => {
  if (originalClientHeight) Object.defineProperty(Element.prototype, "clientHeight", originalClientHeight);
  vi.unstubAllGlobals();
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    type: "scan",
    status: "completed",
    priority: 0,
    attempts: 1,
    lastError: null,
    subjectItemId: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    startedAtMs: null,
    finishedAtMs: null,
    ...overrides,
  };
}

/** Hands the subscribed `job.updated` handler the envelope it would have
 *  received off the websocket. */
function emit(payload: JobUpdatedPayload): void {
  const call = subscribeMock.mock.calls.find(([type]) => type === "job.updated");
  if (!call) throw new Error("JobsPanel never subscribed to job.updated");
  const handler = call[1] as (event: { type: string; payload: JobUpdatedPayload }) => void;
  act(() => {
    handler({ type: "job.updated", payload });
  });
}

let view: TestRender | null = null;

/** The rendered rows' own text, one entry per VirtualList row. */
function rowTexts(): string[] {
  if (!view) throw new Error("nothing rendered");
  return Array.from(view.container.querySelectorAll('[role="listitem"]')).map((el) => el.textContent ?? "");
}

describe("JobsPanel — the attempts chip on live rows (browser-admin-F13)", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders the chip for a fetched row (the baseline the live row must match)", async () => {
    apiGetMock.mockResolvedValue({ items: [job({ attempts: 1 })], nextCursor: null });
    view = renderIntoBody(<JobsPanel />);
    await act(async () => {});

    expect(view!.container.textContent).toContain("1 attempt");
  });

  it("a job first seen over the socket renders the chip immediately — no GET /admin/jobs refetch needed", async () => {
    apiGetMock.mockResolvedValue({ items: [job({ id: "22222222-2222-7222-8222-222222222222" })], nextCursor: null });
    view = renderIntoBody(<JobsPanel />);
    await act(async () => {});

    emit({
      jobId: "33333333-3333-7333-8333-333333333333",
      jobType: "scan",
      status: "active",
      attempts: 1,
      updatedAtMs: 5_000,
    });

    // Two rows now: the fetched one (1 attempt) and the live one, which
    // must read the same way rather than silently dropping its chip.
    // Counted PER ROW, not by scanning the container's flattened
    // textContent: adjacent rows concatenate with no separator there
    // ("…1 attempt" + "scan…" reads as "1 attemptscan"), which silently
    // swallows every chip but the last one.
    expect(rowTexts()).toHaveLength(2);
    for (const text of rowTexts()) expect(text).toContain("1 attempt");
  });

  it("a live transition on an already-listed row updates the chip in place (0 -> 1 attempt)", async () => {
    const id = "44444444-4444-7444-8444-444444444444";
    apiGetMock.mockResolvedValue({ items: [job({ id, status: "queued", attempts: 0 })], nextCursor: null });
    view = renderIntoBody(<JobsPanel />);
    await act(async () => {});
    expect(view!.container.textContent).not.toContain("attempt");

    emit({ jobId: id, jobType: "scan", status: "active", attempts: 1, updatedAtMs: 6_000 });

    expect(view!.container.textContent).toContain("1 attempt");
  });

  it("a retry's second attempt shows as '2 attempts' (plural) on the live row", async () => {
    const id = "55555555-5555-7555-8555-555555555555";
    apiGetMock.mockResolvedValue({ items: [job({ id, status: "active", attempts: 1 })], nextCursor: null });
    view = renderIntoBody(<JobsPanel />);
    await act(async () => {});

    emit({
      jobId: id,
      jobType: "scan",
      status: "queued",
      attempts: 2,
      errorMessage: "transient failure",
      updatedAtMs: 7_000,
    });

    expect(view!.container.textContent).toContain("2 attempts");
  });

  it("a transition carrying no attempts (the abandoned-job reconciliation sweep) leaves the chip alone", async () => {
    const id = "66666666-6666-7666-8666-666666666666";
    apiGetMock.mockResolvedValue({ items: [job({ id, status: "active", attempts: 3 })], nextCursor: null });
    view = renderIntoBody(<JobsPanel />);
    await act(async () => {});

    emit({ jobId: id, jobType: "scan", status: "failed", errorMessage: "abandoned", updatedAtMs: 8_000 });

    expect(view!.container.textContent).toContain("3 attempts");
  });
});
