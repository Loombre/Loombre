// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/BootSplashLazy.test.tsx
//
// d3-s1 (P2) — the CLIENT half of the SSR-bailout fix (the server half is
// BootSplashLazy.ssr.test.tsx, which runs in a window-less environment).
// Removing `next/dynamic({ ssr: false })` from the document render path is
// only correct if the two behaviours that wrapper provided survive:
//
//   1. the boot splash still plays on a cold load (STATE.md "Blaze logo
//      rollout" D9 — AppShell/RootPage's blank first frame), and
//   2. the client's FIRST render still matches the server's empty markup,
//      i.e. hydrating a document whose <BootSplashLazy/> slot is empty
//      produces no hydration error.
//
// Both are asserted here against the real component (no next/dynamic mock:
// the wrapper is plain React now).

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootSplashLazy } from "./BootSplashLazy.js";
import { __resetBootSplashForTests } from "./BootSplash.js";
import { renderIntoBody } from "../ui/test-render.js";

/** The splash's signature line (boot-log.ts) — the same string
 *  AppShell.test.tsx keys its splash assertions on. */
const SPLASH_SIGNATURE = "LOOMBRE CLIENT";

// React only accepts act() (and therefore only stays quiet about it) when
// the environment advertises itself — same flag MusicPlayerProvider.test.tsx
// and VideoPlayer.test.tsx set. It matters here because the hydration test
// asserts that console.error stays EMPTY.
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  __resetBootSplashForTests();
  document.body.innerHTML = "";
});

describe("BootSplashLazy (d3-s1)", () => {
  it("mounts the real splash after the lazy chunk resolves", async () => {
    const view = renderIntoBody(<BootSplashLazy />);
    // The chunk import settles on a microtask in vitest; a real browser
    // takes a network round trip, which is exactly what `ssr: false` cost
    // before too.
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent ?? "").toContain(SPLASH_SIGNATURE);
    view.unmount();
  });

  it("hydrates an EMPTY server slot without a hydration error", async () => {
    const container = document.createElement("div");
    // Exactly what the server now emits for this component (asserted in
    // BootSplashLazy.ssr.test.tsx): nothing at all.
    container.innerHTML = "";
    document.body.appendChild(container);

    const errors: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    });

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, <BootSplashLazy />);
      await Promise.resolve();
    });

    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    expect(errors).toEqual([]);
    expect(container.textContent ?? "").toContain(SPLASH_SIGNATURE);

    consoleError.mockRestore();
    await act(async () => {
      root?.unmount();
    });
  });
});
