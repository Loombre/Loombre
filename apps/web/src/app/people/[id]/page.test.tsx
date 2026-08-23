// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/people/[id]/page.test.tsx
//
// REGRESSION GUARD (browser-shell-browse-F7, P3): GET /people/{id}'s own
// .catch handled ONLY the 404 case (`personNotFound`) — any other failure
// (a transient 5xx, a network error) left `person` null forever with
// `personNotFound` also false, so the render fell into the `!person`
// skeleton branch permanently: no error message, no retry, indistinguish-
// able from "still loading". Same error+retry-key shape as
// HomeContent.tsx's own fix for the identical class of bug (confirmed[16]).

import { Suspense, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const apiGetMock = vi.hoisted(() => vi.fn());

class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

vi.mock("../../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://loombre.local" }),
    getAccessToken: () => Promise.resolve("tok"),
  }),
}));

// Irrelevant to this fetch-error path — reduced to a passthrough (same
// convention as app/restricted/scenes/[id]/page.test.tsx).
vi.mock("../../../components/shell/AppShell.js", () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => <>{children}</>,
}));

const { default: PersonPage } = await import("./page.js");

const PERSON_ID = "person-1";

/** React's `use()` reads the thenable protocol directly: a thenable already
 *  tagged `status: "fulfilled"` resolves synchronously instead of
 *  suspending (page.tsx calls `use(params)` at the top of the route
 *  component) — same helper as
 *  app/restricted/scenes/[id]/page.test.tsx's. */
function fulfilled<T>(value: T): Promise<T> {
  const thenable = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  thenable.status = "fulfilled";
  thenable.value = value;
  return thenable;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPerson(): Promise<TestRender> {
  const view = renderIntoBody(
    <Suspense fallback={null}>
      <PersonPage params={fulfilled({ id: PERSON_ID })} />
    </Suspense>,
  );
  await flush();
  await flush();
  return view;
}

function findRetryButton(view: TestRender): HTMLButtonElement | undefined {
  return Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
}

describe("PersonPage — browser-shell-browse-F7: a non-404 fetch failure shows an error with Retry, not an infinite skeleton", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("REGRESSION GUARD: a 500 renders an error + Retry instead of the skeleton, and a successful retry recovers", async () => {
    let succeed = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/people/{id}") {
        return succeed
          ? Promise.resolve({ id: PERSON_ID, name: "Ada Query", contentClass: "general", creditCount: 0 })
          : Promise.reject(new FakeLoombreApiError(500, "Server error"));
      }
      if (path === "/people/{id}/items") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });

    view = await renderPerson();

    const retryButton = findRetryButton(view);
    expect(retryButton, "expected a Retry control instead of a stuck skeleton").toBeDefined();
    expect(view.container.textContent).toContain("Server error");
    expect(view.container.textContent).not.toContain("Person not found.");

    succeed = true;
    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Ada Query");
    expect(findRetryButton(view)).toBeUndefined();
  });

  it("still distinguishes a real 404 (Person not found, no Retry)", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/people/{id}") return Promise.reject(new FakeLoombreApiError(404, "Not found"));
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });

    view = await renderPerson();

    expect(view.container.textContent).toContain("Person not found.");
    expect(findRetryButton(view)).toBeUndefined();
  });
});
