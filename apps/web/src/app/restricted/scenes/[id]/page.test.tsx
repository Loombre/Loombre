// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/restricted/scenes/[id]/page.test.tsx
//
// REGRESSION GUARD (QA browser-restricted-settings-F1, P1 — "every click
// in the unlocked zone dumps the user back at the PIN gate"): the scene
// detail's studio link and performer chips were raw `<a href>`s, i.e. FULL
// DOCUMENT navigations. That matters here in a way it doesn't on a public
// page: RestrictedProvider re-initializes to locked=true on every document
// load (it has no GET that returns {optIn,hasPin,unlockedUntilMs}, so it
// cannot rehydrate the still-live server-side unlock window), which means
// the destination page renders <RestrictedGate/> — "This zone is locked" —
// while the server still honours the unlock. Each re-unlock also spends one
// of the 5 attempts/min the unlock rate limiter allows, so ordinary
// browsing could run a user into a 429. Client-side navigation keeps the
// whole flow inside one document, so the provider — and the unlock — lives.
//
// The next/link stub mirrors PlayLink.test.tsx's (same reason: vitest
// resolves the bare "next/link" specifier to Next's PAGES build, so the
// shipped App Router Link cannot intercept clicks under jsdom). It models
// what the real component does on an unmodified primary click:
// preventDefault() then a client-side router navigation.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Suspense, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../../../components/ui/test-render.js";

/** Records what a real next/link click would hand to the client router. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));
const apiGetMock = vi.hoisted(() => vi.fn());

class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// The shell mounts the sidebar/websocket/providers; this route's links are
// what's under test, so it is reduced to a passthrough.
vi.mock("../../../../components/shell/AppShell.js", () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => <>{children}</>,
}));

// The unlocked zone: exactly the state the QA repro was in when the click
// happened (Cluster D owns the provider itself and its rehydration gap —
// browser-items-F3).
vi.mock("../../../../components/restricted/RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: {
      loading: false,
      optIn: true,
      hasPin: true,
      unlockedUntilMs: Date.now() + 1_800_000,
      locked: false,
      modalOpen: false,
      submitting: false,
      error: null,
    },
    openUnlockModal: vi.fn(),
    closeUnlockModal: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(),
    applyRestrictedSettings: vi.fn(),
  }),
}));

vi.mock("../../../../lib/restricted-zone-count.js", () => ({
  hasRestrictedZoneEntitlement: () => true,
  useRestrictedZoneCount: () => ({ count: 12, loading: false, error: null }),
}));

vi.mock("../../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

vi.mock("../../../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://loombre.local" }),
    getAccessToken: () => Promise.resolve("tok"),
  }),
}));

const RestrictedScenePage = (await import("./page.js")).default;

const SCENE_ID = "01a02170-1111-7000-8000-00000000aaaa";
const STUDIO_ID = "01a02170-2222-7000-8000-00000000bbbb";
const PERFORMER_ID = "01a02170-3333-7000-8000-00000000cccc";

const SCENE: components["schemas"]["RestrictedScene"] = {
  id: SCENE_ID,
  libraryId: "01a02170-4444-7000-8000-00000000dddd",
  itemType: "movie",
  title: "Night Shift",
  sortTitle: "Night Shift",
  year: 2024,
  communityRating: null,
  contentClass: "restricted",
  addedAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
  premiereAtMs: null,
  contentRating: "XXX",
  runtimeMs: null,
  durationMs: 1_800_000,
  overview: "A scene.",
  tags: [],
  studio: { id: STUDIO_ID, name: "Blue Room" },
  performers: [{ id: PERFORMER_ID, name: "Ada Vance" }],
  images: [],
  markers: [],
  progress: null,
  quality: { is4k: false, hdr: "none", resolution: "FHD" },
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

/** React's `use()` reads the thenable protocol directly: a thenable already
 *  tagged `status: "fulfilled"` resolves synchronously instead of suspending
 *  (page.tsx calls `use(params)` at the top of the route component). Without
 *  the tag the very first render suspends inside the synchronous act() scope
 *  of renderIntoBody and React warns rather than committing. */
function fulfilled<T>(value: T): Promise<T> {
  const thenable = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  thenable.status = "fulfilled";
  thenable.value = value;
  return thenable;
}

async function renderScene(): Promise<TestRender> {
  const view = renderIntoBody(
    <Suspense fallback={null}>
      <RestrictedScenePage params={fulfilled({ id: SCENE_ID })} />
    </Suspense>,
  );
  await flush();
  await flush();
  return view;
}

describe("restricted scene detail — client-side navigation (QA browser-restricted-settings-F1)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) =>
      path === "/restricted/scenes/{id}" ? Promise.resolve(SCENE) : Promise.reject(new Error(`unexpected ${path}`)),
    );
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("REGRESSION GUARD: the studio link navigates INSIDE the document, so the zone stays unlocked", async () => {
    view = await renderScene();
    const link = view.container.querySelector(`a[href="/restricted/studios/${STUDIO_ID}"]`);
    expect(link, "expected a studio link on the scene detail").not.toBeNull();

    const event = click(link as Element);

    // A raw <a href> reloads the document; RestrictedProvider then starts
    // over at locked=true and the studio page shows the PIN gate.
    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([`/restricted/studios/${STUDIO_ID}`]);
  });

  it("REGRESSION GUARD: a performer chip navigates INSIDE the document too", async () => {
    view = await renderScene();
    const chip = view.container.querySelector(`a[href="/restricted/performers/${PERFORMER_ID}"]`);
    expect(chip, "expected a performer chip on the scene detail").not.toBeNull();

    const event = click(chip as Element);

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([`/restricted/performers/${PERFORMER_ID}`]);
  });

  it("keeps real hrefs so middle-click / open-in-new-tab / copy-link still work", async () => {
    view = await renderScene();
    expect(view.container.querySelector(`a[href="/restricted/studios/${STUDIO_ID}"]`)).not.toBeNull();
    expect(view.container.querySelector(`a[href="/restricted/performers/${PERFORMER_ID}"]`)).not.toBeNull();
  });

  it("leaves a modified (cmd/ctrl) click to the browser", async () => {
    view = await renderScene();
    const event = click(view.container.querySelector(`a[href="/restricted/studios/${STUDIO_ID}"]`) as Element, {
      metaKey: true,
    });
    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });
});

// Whole-zone guard for the same defect class: inside the restricted zone a
// raw <a> is never just a style choice — it is a re-lock. This walks the
// zone's own two directories (the route tree and its components) and fails
// on any anchor with an href that isn't already a known, tracked exception.
describe("restricted zone — no raw <a href> navigation (QA browser-restricted-settings-F1)", () => {
  // Follow-up worklist for the same defect in files this finding did not
  // own. C/zone-sibling-tiles (d3-c1) emptied it: ZoneStudioTile,
  // ZonePerformerTile and ZoneDetailedRow are next/link now. Kept as an
  // (empty) seam so the next offender that cannot be fixed in the same
  // pass is TRACKED here rather than silently skipped.
  const KNOWN_REMAINING = new Set<string>([]);

  it("every in-zone link is a next/link, not a document navigation", () => {
    // fileURLToPath on the STRING form: under the jsdom environment the
    // global URL is jsdom's, and node:url rejects its instances.
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const rawAnchorWithHref = /<a\s[^>]*href=/;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (rawAnchorWithHref.test(readFileSync(full, "utf8"))) {
          offenders.push(full.slice(srcRoot.length + 1));
        }
      }
    };
    walk(`${srcRoot}/app/restricted`);
    walk(`${srcRoot}/components/restricted`);

    expect(offenders.filter((f) => !KNOWN_REMAINING.has(f))).toEqual([]);
  });
});
