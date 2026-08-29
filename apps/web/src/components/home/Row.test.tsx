// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/home/Row.test.tsx
//
// REGRESSION GUARD (QA C/zone-row-action-raw-anchor, P2): this rail shell's
// "ALL →" action was a raw `<a href>`, i.e. a FULL DOCUMENT navigation. On
// the public home that is merely slow; from the restricted zone home
// (app/restricted/page.tsx renders its three rails with THIS component) it
// is a re-lock — RestrictedProvider re-initializes to locked=true on every
// document load and cannot rehydrate the still-live server-side unlock, so
// "ALL →" landed the viewer on the PIN gate and spent one of the 5 unlock
// attempts/min. Verified live before the fix: the pre-click window probe was
// gone and performance.timeOrigin had moved.
//
// The next/link stub mirrors PlayLink.test.tsx's (vitest resolves the bare
// "next/link" specifier to Next's PAGES build, so the shipped App Router
// Link cannot intercept a click under jsdom); it models what the real
// component does on an unmodified primary click.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

/** Records what a real next/link click would hand to the client router. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));

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

const { Row } = await import("./Row.js");

const ACTION_HREF = "/restricted/browse";

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

function renderRow(): TestRender {
  return renderIntoBody(
    <Row heading="Scenes" action={{ label: "ALL →", href: ACTION_HREF }}>
      {[<div key="a">tile</div>]}
    </Row>,
  );
}

describe("Row — the rail action is a client-side navigation (QA C/zone-row-action-raw-anchor)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("REGRESSION GUARD: 'ALL →' navigates INSIDE the document", () => {
    view = renderRow();
    const action = view.container.querySelector(`a[href="${ACTION_HREF}"]`);
    expect(action, "expected the rail action to render an anchor").not.toBeNull();

    const event = click(action as Element);

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([ACTION_HREF]);
  });

  it("keeps a real href so middle-click / open-in-new-tab / copy-link still work", () => {
    view = renderRow();
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(ACTION_HREF);
  });

  it("leaves a modified (cmd/ctrl) click to the browser", () => {
    view = renderRow();
    const event = click(view.container.querySelector("a") as Element, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });

  it("renders no action at all when the caller passes none", () => {
    view = renderIntoBody(
      <Row heading="Continue Watching">
        {[<div key="a">tile</div>]}
      </Row>,
    );
    expect(view.container.querySelector("a")).toBeNull();
  });
});
