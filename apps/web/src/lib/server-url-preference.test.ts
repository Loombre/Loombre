// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/server-url-preference.test.ts
//
// The resolution table behind browser-shell-browse-F2. The page-level
// checks (app/login/page.test.tsx, app/forgot/page.test.tsx) prove the
// wiring — which page writes when, and which URL the request actually goes
// to; this file owns the precedence rules and the storage edge cases so
// those don't have to re-derive them through a DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_URL_PREFERENCE_KEY,
  readPreferredServerUrl,
  rememberPreferredServerUrl,
  resolvePublicServerUrl,
} from "./server-url-preference.js";

describe("server-url-preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("keeps using the onboarding-lite key that is already on real devices", () => {
    expect(SERVER_URL_PREFERENCE_KEY).toBe("loombre.onboarding.serverUrl");
  });

  describe("readPreferredServerUrl", () => {
    it("returns nothing when the viewer has never committed a server", () => {
      expect(readPreferredServerUrl()).toBeNull();
    });

    it("returns the committed value, trimmed", () => {
      window.localStorage.setItem(SERVER_URL_PREFERENCE_KEY, "  http://localhost:3001  ");
      expect(readPreferredServerUrl()).toBe("http://localhost:3001");
    });

    it("treats a blank remembered value as nothing remembered", () => {
      window.localStorage.setItem(SERVER_URL_PREFERENCE_KEY, "   ");
      expect(readPreferredServerUrl()).toBeNull();
    });
  });

  describe("rememberPreferredServerUrl", () => {
    it("stores a committed choice", () => {
      rememberPreferredServerUrl("http://localhost:3001");
      expect(window.localStorage.getItem(SERVER_URL_PREFERENCE_KEY)).toBe("http://localhost:3001");
    });

    it("overwrites a previous choice — correcting the pill is the whole point", () => {
      rememberPreferredServerUrl("http://localhost:9");
      rememberPreferredServerUrl("http://localhost:3001");
      expect(readPreferredServerUrl()).toBe("http://localhost:3001");
    });

    it("clears rather than storing an empty string", () => {
      rememberPreferredServerUrl("http://localhost:3001");
      rememberPreferredServerUrl("  ");
      expect(window.localStorage.getItem(SERVER_URL_PREFERENCE_KEY)).toBeNull();
    });

    it("survives storage being unavailable (private mode) without throwing", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      });
      expect(() => rememberPreferredServerUrl("http://localhost:3001")).not.toThrow();
      expect(readPreferredServerUrl()).toBeNull();
    });
  });

  describe("resolvePublicServerUrl", () => {
    it("prefers the viewer's committed choice over the established session's server", () => {
      // The browser-shell-browse-F2 shape: the pill was corrected back to
      // :3001, the store still remembers some other server. What the viewer
      // SEES wins — it is the only one they can fix without signing in.
      window.localStorage.setItem(SERVER_URL_PREFERENCE_KEY, "http://localhost:3001");
      expect(resolvePublicServerUrl("http://localhost:9")).toBe("http://localhost:3001");
    });

    it("falls back to the established session's server when nothing is remembered", () => {
      expect(resolvePublicServerUrl("https://loombre.example.com")).toBe("https://loombre.example.com");
    });

    it("falls back to the same-origin guess when neither is set", () => {
      // jsdom serves these tests from http://localhost:3000.
      expect(resolvePublicServerUrl("")).toBe(`${window.location.protocol}//${window.location.hostname}:3001`);
    });

    it("ignores a whitespace-only established value", () => {
      expect(resolvePublicServerUrl("   ")).toBe(`${window.location.protocol}//${window.location.hostname}:3001`);
    });
  });
});
