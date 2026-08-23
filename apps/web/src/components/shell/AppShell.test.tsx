// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/AppShell.test.tsx
//
// browser-shell-browse-F1 (2026-08-20/21 QA, P2 — "auth loss leaves the app
// on a dead screen"): when the stored refresh chain dies (a rotated/revoked
// refresh token 401ing at boot) or the user signs out mid-session, AppShell
// flipped `ready` back to false and rendered <BootSplash/>. BootSplash owns
// a ONE-SHOT module flag (`booted`, BootSplash.tsx) — it plays for the
// first mount in a tab's lifetime and renders `null` for every mount after
// that. So the user got one of exactly two dead screens:
//
//   A) boot path — the splash had not been claimed yet, so it renders and
//      then FREEZES on screen for as long as the auth-lost state lasts
//      (QA saw >60s; screenshot ...-07-stale-refresh-splash-stuck.png);
//   B) sign-out path — AppShell's own first (pending) frame already claimed
//      the one-shot, so the post-sign-out render is `null`: a completely
//      blank document, `document.body.innerText.length === 0`, no <main>
//      (screenshot ...-23-signout-blank-page.png).
//
// In both cases the ONLY affordance left was a manual reload: no text, no
// link, no retry — and the intermittent Next-dev navigation stall that
// triggered it in QA is exactly the condition under which the app must
// still be recoverable. Owner's fix direction: any TERMINAL auth failure
// routes to /login (carrying a return path) and TEARS THE SPLASH DOWN.
//
// This file is that regression check, asserted at the level QA saw the bug
// (rendered DOM + the router call), not on component internals. The REAL
// BootSplash is wired in behind the lazy wrapper (its one-shot gate is half
// the mechanism, so a mocked splash would prove nothing); everything else
// AppShell pulls in — nav chrome, topbar, banners, the /users/me fetch — is
// mocked to keep this file about the auth-phase state machine.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { __resetBootSplashForTests } from "../brand/BootSplash.js";

const routerReplace = vi.fn();
const routerPush = vi.fn();
// Stable reference — AppShell's auth effect depends on [router]; a fresh
// literal per call would re-run it on every render (login/page.test.tsx
// documents the same trap).
const router = { replace: routerReplace, push: routerPush };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

let authenticated = true;
const authListeners = new Set<() => void>();
const logoutMock = vi.fn(async () => {
  // The real AuthStore.logout() clears the persisted chain and notifies
  // every subscriber — that notification IS how AppShell learns.
  authenticated = false;
  for (const listener of [...authListeners]) listener();
});

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    subscribe: (listener: () => void) => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
    logout: logoutMock,
    getSnapshot: () => ({
      serverUrl: "http://localhost:3001",
      refreshToken: authenticated ? "refresh-1" : null,
      deviceId: authenticated ? "device-1" : null,
      accessToken: null,
      accessTokenExpiresAtMs: null,
    }),
  }),
}));

const apiGetMock = vi.fn();
vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

vi.mock("../notices/SystemNoticeProvider.js", () => ({
  useSystemNotice: () => ({ bannerVisible: false }),
}));

// Nav chrome: ShellNav reads usePathname/useSearchParams and fetches
// libraries; only its onSignOut seam matters here.
vi.mock("./ShellNav.js", () => ({
  ShellNav: ({ onSignOut }: { onSignOut: () => void }) => (
    <button type="button" data-testid="signout" onClick={onSignOut}>
      Sign out
    </button>
  ),
}));
vi.mock("./Topbar.js", () => ({ Topbar: () => null }));
vi.mock("./BannerRegion.js", () => ({ BannerRegion: () => null }));

// Only the one genuinely un-runnable helper is replaced: jsdom throws on
// window.location.assign. Every string rule stays REAL, so the hrefs
// asserted below are the ones production builds.
const hardRedirectMock = vi.fn();
vi.mock("../../lib/auth-return-path.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/auth-return-path.js")>(
    "../../lib/auth-return-path.js",
  );
  return { ...actual, hardRedirect: (href: string) => hardRedirectMock(href) };
});

// The REAL BootSplash behind the lazy wrapper (next/dynamic's async chunk
// boundary is not what this test is about; its one-shot `booted` gate is).
vi.mock("../brand/BootSplashLazy.js", async () => {
  const actual = await vi.importActual<typeof import("../brand/BootSplash.js")>("../brand/BootSplash.js");
  return { BootSplashLazy: actual.BootSplash };
});

const { AppShell } = await import("./AppShell.js");
const { AUTH_REDIRECT_FALLBACK_MS } = await import("../../lib/auth-return-path.js");

function loginLink(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>('a[href^="/login"]');
}

/** The splash's boot log is its signature — "LOOMBRE CLIENT / SERVER /
 *  SESSION NEW" is exactly what QA's frozen-splash screenshot shows
 *  (boot-log.ts). Keyed on that rather than on the BlazeMark <svg>, which
 *  the brand lockup of any auth screen also renders. */
function splashVisible(container: HTMLElement): boolean {
  return (container.textContent ?? "").includes("LOOMBRE CLIENT");
}

describe("AppShell — terminal auth loss (browser-shell-browse-F1)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    routerReplace.mockReset();
    routerPush.mockReset();
    logoutMock.mockClear();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ username: "casual", displayName: "Casual", isAdmin: false });
    authListeners.clear();
    authenticated = true;
    __resetBootSplashForTests();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("B: signing out mid-session leaves a real screen with a way back to /login, not a blank page", async () => {
    window.history.replaceState({}, "", "/profile");
    view = renderIntoBody(
      <AppShell>
        <div data-testid="content">CONTENT</div>
      </AppShell>,
    );
    await act(async () => {});
    expect(view.container.querySelector('[data-testid="content"]'), "signed-in content should render").not.toBeNull();

    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="signout"]')!;
    await act(async () => {
      button.click();
    });

    expect(view.container.textContent, "auth loss must never render an empty document").not.toBe("");
    expect(loginLink(view.container), "expected a visible /login affordance after sign-out").not.toBeNull();
    expect(splashVisible(view.container), "the boot splash must be torn down on auth loss").toBe(false);
  });

  it("A: a dead session at boot tears the splash down instead of freezing on it", async () => {
    authenticated = false;
    window.history.replaceState({}, "", "/browse?library=abc");
    view = renderIntoBody(
      <AppShell>
        <div data-testid="content">CONTENT</div>
      </AppShell>,
    );
    await act(async () => {});

    expect(splashVisible(view.container), "the boot splash must not stay on screen while auth is lost").toBe(false);
    expect(view.container.textContent).not.toContain("LOOMBRE CLIENT");
    expect(loginLink(view.container), "expected a visible /login affordance at a dead boot").not.toBeNull();
  });

  it("A: the /login redirect and the on-screen link both carry the return path", async () => {
    authenticated = false;
    window.history.replaceState({}, "", "/browse?library=abc");
    view = renderIntoBody(
      <AppShell>
        <div data-testid="content">CONTENT</div>
      </AppShell>,
    );
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/login?next=%2Fbrowse%3Flibrary%3Dabc");
    expect(loginLink(view.container)?.getAttribute("href")).toBe("/login?next=%2Fbrowse%3Flibrary%3Dabc");
  });

  it("B: an intentional sign-out goes to a bare /login (no return path back into the app)", async () => {
    window.history.replaceState({}, "", "/profile");
    view = renderIntoBody(
      <AppShell>
        <div data-testid="content">CONTENT</div>
      </AppShell>,
    );
    await act(async () => {});
    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="signout"]')!;
    await act(async () => {
      button.click();
    });

    expect(logoutMock).toHaveBeenCalledTimes(1);
    for (const call of routerReplace.mock.calls) expect(call[0]).toBe("/login");
    expect(loginLink(view.container)?.getAttribute("href")).toBe("/login");
  });

  describe("when router.replace never commits (QA's actual trigger)", () => {
    beforeEach(() => {
      hardRedirectMock.mockReset();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("falls back to a full document load, carrying the same return path", async () => {
      authenticated = false;
      window.history.replaceState({}, "", "/browse?library=abc");
      view = renderIntoBody(
        <AppShell>
          <div data-testid="content">CONTENT</div>
        </AppShell>,
      );
      await act(async () => {});
      // The stall: the route never changes, so AppShell stays mounted.
      expect(hardRedirectMock).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(AUTH_REDIRECT_FALLBACK_MS + 1);
      });

      expect(hardRedirectMock).toHaveBeenCalledWith("/login?next=%2Fbrowse%3Flibrary%3Dabc");
    });

    it("does not hard-navigate when the router did commit (AppShell unmounted)", async () => {
      authenticated = false;
      window.history.replaceState({}, "", "/browse?library=abc");
      const local = renderIntoBody(
        <AppShell>
          <div data-testid="content">CONTENT</div>
        </AppShell>,
      );
      await act(async () => {});
      // A committed navigation renders a different route: this tree goes away.
      local.unmount();

      await act(async () => {
        vi.advanceTimersByTime(AUTH_REDIRECT_FALLBACK_MS * 4);
      });

      expect(hardRedirectMock).not.toHaveBeenCalled();
    });
  });
});
