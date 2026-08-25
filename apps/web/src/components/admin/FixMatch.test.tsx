// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/FixMatch.test.tsx
//
// d4-e1 (M/browser-items-F13-adjacent, backlog #081): the sheet's empty
// state said "No metadata provider in this item's chain returned a match for
// this title" even when the chain had ZERO ENABLED providers — i.e. when
// nothing was searched at all, which is what a keyless instance always looks
// like. The two states are opposites (one is "we looked and there is
// nothing", the other is "we cannot look yet") and only one of them is
// actionable, but metadata.match-candidates carried only candidates[], so
// the client had no way to tell them apart. The event now carries
// providersSearched — the providers this search actually ran against.
//
// apiPost and getEventsSocket are mocked (StreamsPanel.test.tsx's convention),
// matchMedia stubbed for SheetOrModal (AddLibrarySheet.test.tsx's, same
// reason).

import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { ToastProvider } from "../ui/Toast.js";

const apiPostMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { FixMatch } = await import("./FixMatch.js");

const ITEM_ID = "44444444-4444-7444-8444-444444444444";

let view: TestRender | null = null;

beforeEach(() => {
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({ jobId: "job-1" });
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

function mount(): void {
  view = renderIntoBody(
    <ToastProvider>
      <FixMatch itemId={ITEM_ID} itemTitle="Thor" open onClose={() => {}} onApplied={() => {}} />
    </ToastProvider>,
  );
}

/** Deliver one metadata.match-candidates result to the open sheet. */
async function deliver(payload: Record<string, unknown>): Promise<void> {
  const handler = subscribeMock.mock.calls.find(([type]) => type === "metadata.match-candidates")?.[1] as
    | ((event: unknown) => void)
    | undefined;
  expect(handler).toBeTypeOf("function");
  await act(async () => {
    handler!({
      id: "e1",
      type: "metadata.match-candidates",
      tsMs: 1,
      actorUserId: null,
      payload: { itemId: ITEM_ID, jobId: "job-1", searchedAtMs: 1, ...payload },
    });
  });
}

describe("FixMatch — nothing found vs nothing searched (d4-e1)", () => {
  it("says the chain has no enabled provider, and points at the keys page, when nothing was searched", async () => {
    mount();
    await act(async () => {});
    await deliver({ candidates: [], providersSearched: [] });

    expect(view!.container.textContent).toMatch(/no enabled metadata provider/i);
    // The exact regression: claiming a search happened and came back empty.
    expect(view!.container.textContent).not.toMatch(/returned a match for this title/i);
    const link = view!.container.querySelector('a[href="/settings/plugins"]');
    expect(link).not.toBeNull();
  });

  it("keeps the 'searched, found nothing' copy when a provider WAS searched", async () => {
    mount();
    await act(async () => {});
    await deliver({ candidates: [], providersSearched: ["tmdb"] });

    expect(view!.container.textContent).toMatch(/returned a match for this title/i);
    expect(view!.container.querySelector('a[href="/settings/plugins"]')).toBeNull();
  });

  it("falls back to the pre-d4-e1 copy when the field is absent (older server)", async () => {
    mount();
    await act(async () => {});
    await deliver({ candidates: [] });

    expect(view!.container.textContent).toMatch(/returned a match for this title/i);
    expect(view!.container.querySelector('a[href="/settings/plugins"]')).toBeNull();
  });

  it("still renders the ranked candidate list — the empty-state split changes nothing else", async () => {
    mount();
    await act(async () => {});
    await deliver({
      candidates: [{ provider: "tmdb", externalId: "603", title: "The Matrix", year: 1999, confidence: 97.5, isBest: true }],
      providersSearched: ["tmdb"],
    });

    expect(view!.container.textContent).toContain("The Matrix");
    expect(view!.container.textContent).toContain("BEST");
    expect(view!.container.textContent).not.toMatch(/no enabled metadata provider/i);
  });
});
