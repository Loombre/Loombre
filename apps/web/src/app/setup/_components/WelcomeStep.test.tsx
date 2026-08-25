// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/_components/WelcomeStep.test.tsx
//
// d3-d3 (2026-08-24 remediation): the wizard's first step used to write the
// typed address straight into the AUTH STORE — the browser-shell-browse-F2
// shape, one screen earlier. `loombre.auth.v1`'s serverUrl means "the
// server this device's tokens are valid against" (auth-store.ts's
// setServerUrl comment, lib/server-url-preference.ts's header), and a value
// nobody has proven answers ANY Loombre request does not belong in it: a
// typo there survives reloads, and the wizard's own self-guard reads it —
// GET /setup/state against the mistyped host fails closed, so /setup
// bounces to /login forever and the only escape is clearing localStorage.
//
// Harness: the real AuthStore singleton (this component reads and writes it
// exactly like production) plus a spy on LoombreClient.prototype.get —
// login/page.test.tsx's posture, for the same reason: the assertion IS what
// was persisted and which server was probed.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { SERVER_URL_PREFERENCE_KEY } from "../../../lib/server-url-preference.js";

const { WelcomeStep } = await import("./WelcomeStep.js");

describe("WelcomeStep — the typed server address", () => {
  let view: TestRender | null = null;
  let getSpy: ReturnType<typeof vi.spyOn>;
  const onNext = vi.fn();

  beforeEach(() => {
    onNext.mockReset();
    window.localStorage.clear();
    getAuthStore().clear();
    getAuthStore().setServerUrl("");
    getSpy = vi.spyOn(LoombreClient.prototype, "get");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    getSpy.mockRestore();
    getAuthStore().setServerUrl("");
    window.localStorage.clear();
  });

  function setNativeValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function renderAndType(serverUrl: string): Promise<void> {
    view = renderIntoBody(<WelcomeStep onNext={onNext} />);
    await act(async () => {});
    const field = view.container.querySelector<HTMLInputElement>("#setup-server-url")!;
    setNativeValue(field, serverUrl);
    await act(async () => {});
  }

  async function submit(): Promise<void> {
    const form = view!.container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("an address nothing answers never reaches the auth store, and the wizard stays put", async () => {
    getSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderAndType("http://localhost:9");
    await submit();

    expect(getAuthStore().getSnapshot().serverUrl).toBe("");
    expect(onNext).not.toHaveBeenCalled();
    expect(view!.container.textContent).toMatch(/could not reach/i);
    // The CHOICE is still remembered — the field (and /login's pill) show it
    // next time, which is how a typo stays correctable.
    expect(window.localStorage.getItem(SERVER_URL_PREFERENCE_KEY)).toBe("http://localhost:9");
  });

  it("probes GET /setup/state on the typed server, then promotes it and advances", async () => {
    getSpy.mockResolvedValue({ needsSetup: true });
    await renderAndType("http://otherhost:3001");
    await submit();

    expect(getSpy).toHaveBeenCalledWith("/setup/state");
    expect(getAuthStore().getSnapshot().serverUrl).toBe("http://otherhost:3001");
    expect(window.localStorage.getItem(SERVER_URL_PREFERENCE_KEY)).toBe("http://otherhost:3001");
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("a server that is already set up is not adopted (the wizard cannot provision it)", async () => {
    getSpy.mockResolvedValue({ needsSetup: false });
    await renderAndType("http://already-configured:3001");
    await submit();

    expect(getAuthStore().getSnapshot().serverUrl).toBe("");
    expect(onNext).not.toHaveBeenCalled();
    expect(view!.container.textContent).toMatch(/already set up/i);
  });

  it("pre-fills the address the viewer last committed, ahead of the same-origin guess", async () => {
    window.localStorage.setItem(SERVER_URL_PREFERENCE_KEY, "http://remembered:3001");
    view = renderIntoBody(<WelcomeStep onNext={onNext} />);
    await act(async () => {});
    const field = view.container.querySelector<HTMLInputElement>("#setup-server-url")!;
    expect(field.value).toBe("http://remembered:3001");
  });
});
