// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/Topbar.test.tsx
//
// A1 (run UIFIX-2026-08-29, HIGH — "the topbar is 658px of nothing"): the
// bar grew a LEFT FLANK (route label + live scan status) so the search
// field could sit centred between two equal flanks instead of pinned to the
// right edge of an otherwise empty 64px bar. This file pins the parts of
// that a stylesheet cannot hold on its own:
//
//   1. the three-zone DOM order (left flank, field, right flank) — the flex
//      arithmetic in AppShell.module.css centres the middle child, so the
//      field being the middle child is load-bearing structure, not markup
//      taste;
//   2. the route label resolving through the shell's EXISTING route ->
//      label source (mobile-header.ts's resolveMobileHeader), including an
//      unmapped route rendering NOTHING rather than an invented label (U9);
//   3. the scan status, and — the reason the subscription was lifted out of
//      Sidebar.tsx into use-scan-status.ts at all — that N mounted
//      consumers share ONE pair of events-socket subscriptions, the same
//      contract lib/watchlist-sync.test.tsx asserts for its own shared
//      store (browser-items-F9), whose mock shape this file mirrors.
//
// The three children (QuickSearch, RestrictedLockControl, UserMenu) are
// stubbed: each owns its own fetches/providers and its own test file, and
// this one is about the bar's structure and the two facts it now shows.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const pathnameState = vi.hoisted(() => ({ value: "/home" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.value,
}));

vi.mock("./QuickSearch.js", () => ({
  QuickSearch: () => <div data-testid="quick-search" />,
}));
vi.mock("./RestrictedLockControl.js", () => ({
  RestrictedLockControl: () => <button type="button" data-testid="lock" />,
}));
vi.mock("./UserMenu.js", () => ({
  UserMenu: () => <button type="button" data-testid="user-menu" />,
}));

type ScanListener = (event: { payload: { jobId: string } }) => void;
const socketListeners = new Map<string, Set<ScanListener>>();
let socketSubscribeCalls = 0;

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({
    subscribe: (type: string, listener: ScanListener) => {
      socketSubscribeCalls += 1;
      let set = socketListeners.get(type);
      if (!set) {
        set = new Set();
        socketListeners.set(type, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
  }),
}));

// Imported AFTER the mocks so the modules under test pick them up (the
// convention every sibling test file in this directory follows).
const { Topbar } = await import("./Topbar.js");
const { __resetScanStatusForTests } = await import("./use-scan-status.js");

function emitScan(type: "scan.started" | "scan.completed", jobId: string): void {
  act(() => {
    for (const listener of socketListeners.get(type) ?? []) listener({ payload: { jobId } });
  });
}

function header(view: TestRender): HTMLElement {
  return view.container.querySelector("header")!;
}

/** The left flank is the header's FIRST child — see zone-order test below. */
function leftFlank(view: TestRender): HTMLElement {
  return header(view).children[0] as HTMLElement;
}

describe("Topbar — A1 three-zone shell chrome", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    pathnameState.value = "/home";
    socketListeners.clear();
    socketSubscribeCalls = 0;
    __resetScanStatusForTests();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    __resetScanStatusForTests();
  });

  it("renders three zones in order: left flank, the search field, right flank", () => {
    view = renderIntoBody(<Topbar username="admin" isAdmin={false} />);
    const children = Array.from(header(view).children);

    expect(children).toHaveLength(3);
    expect(children[1]?.getAttribute("data-testid"), "the search field must be the MIDDLE child").toBe("quick-search");
    expect(children[2]?.querySelector('[data-testid="lock"]')).not.toBeNull();
    expect(children[2]?.querySelector('[data-testid="user-menu"]')).not.toBeNull();
  });

  it("names the current route in the left flank, via the shell's existing route -> label resolver", () => {
    view = renderIntoBody(<Topbar username="admin" isAdmin={false} />);
    expect(leftFlank(view).textContent).toBe("Home");

    for (const [pathname, label] of [
      ["/watchlist", "Watchlist"],
      ["/settings", "System Settings"],
      ["/settings/advanced", "Advanced Server"],
      ["/items/movie/019-abc", "Movie"],
      ["/admin", "Dashboard"],
    ] as const) {
      pathnameState.value = pathname;
      view.rerender(<Topbar username="admin" isAdmin={false} />);
      expect(leftFlank(view).textContent, `${pathname} should read "${label}"`).toBe(label);
    }
  });

  it("renders NO label for an unmapped route rather than inventing one (U9)", () => {
    pathnameState.value = "/some/route/with/no/mapping";
    view = renderIntoBody(<Topbar username="admin" isAdmin={false} />);

    expect(leftFlank(view).textContent).toBe("");
    expect(leftFlank(view).children).toHaveLength(0);
  });

  it("shows the live scan status for an admin, and clears it only when the LAST job completes", () => {
    view = renderIntoBody(<Topbar username="admin" isAdmin />);
    expect(leftFlank(view).textContent).toBe("Home");

    emitScan("scan.started", "job-1");
    emitScan("scan.started", "job-2");
    expect(leftFlank(view).textContent).toContain("Scan");

    // Overlapping scans across libraries: one finishing must not clear it.
    emitScan("scan.completed", "job-1");
    expect(leftFlank(view).textContent).toContain("Scan");

    emitScan("scan.completed", "job-2");
    expect(leftFlank(view).textContent).toBe("Home");
  });

  it("never subscribes at all for a non-admin, and shows no scan status", () => {
    view = renderIntoBody(<Topbar username="casual" isAdmin={false} />);

    expect(socketSubscribeCalls).toBe(0);
    emitScan("scan.started", "job-1");
    expect(leftFlank(view).textContent).not.toContain("Scan");
  });

  it("shares ONE pair of events-socket subscriptions across every mounted consumer", () => {
    // Two mounted consumers stands in for the real pair (this topbar + the
    // sidebar's Dashboard pill), both reading use-scan-status.ts.
    view = renderIntoBody(
      <>
        <Topbar username="admin" isAdmin />
        <Topbar username="admin" isAdmin />
      </>,
    );

    expect(socketSubscribeCalls).toBe(2); // scan.started + scan.completed, once

    // ...and both see the same state from that one subscription pair.
    emitScan("scan.started", "job-1");
    const headers = view.container.querySelectorAll("header");
    expect(headers).toHaveLength(2);
    for (const el of headers) expect(el.children[0]?.textContent).toContain("Scan");
  });
});
