// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/auth-store.test.ts
//
// Covers the two hard safety requirements from the auth store's header:
// (1) access token lives in memory only, refreshToken/deviceId/serverUrl
// persist to localStorage across store instances; (2) concurrent 401s /
// expiry checks trigger EXACTLY ONE POST /auth/refresh — the rotating
// refresh token is single-use server-side, so a second concurrent send
// would be treated as reuse and revoke the whole device chain.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, getAuthStore, type AuthFetch } from "./auth-store.js";

function seedPersisted(): void {
  window.localStorage.setItem(
    "loombre.auth.v1",
    JSON.stringify({ serverUrl: "http://localhost:3001", refreshToken: "rt-0", deviceId: "device-1" }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("AuthStore persistence", () => {
  it("persists serverUrl/refreshToken/deviceId to localStorage but keeps accessToken in memory only", () => {
    const store = new AuthStore();
    store.setServerUrl("http://localhost:3001");
    store.applyTokenPair({
      accessToken: "at-0",
      refreshToken: "rt-0",
      accessTokenExpiresAtMs: Date.now() + 900_000,
      deviceId: "device-1",
    });

    const raw = window.localStorage.getItem("loombre.auth.v1");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    expect(persisted.refreshToken).toBe("rt-0");
    expect(persisted.deviceId).toBe("device-1");
    expect(persisted).not.toHaveProperty("accessToken");

    // A fresh store instance (simulating a page reload) picks up the
    // persisted refresh chain but starts with no in-memory access token.
    const reloaded = new AuthStore();
    expect(reloaded.getSnapshot().accessToken).toBeNull();
    expect(reloaded.getSnapshot().refreshToken).toBe("rt-0");
    expect(reloaded.isAuthenticated()).toBe(true);
  });

  it("clear() wipes both in-memory and persisted state", () => {
    const store = new AuthStore();
    store.setServerUrl("http://localhost:3001");
    store.applyTokenPair({
      accessToken: "at-0",
      refreshToken: "rt-0",
      accessTokenExpiresAtMs: Date.now() + 900_000,
      deviceId: "device-1",
    });
    store.clear();
    expect(store.isAuthenticated()).toBe(false);
    const persisted = JSON.parse(window.localStorage.getItem("loombre.auth.v1")!);
    expect(persisted.refreshToken).toBeNull();
  });
});

describe("AuthStore single-flight refresh", () => {
  it("fires exactly one POST /auth/refresh for concurrent expired-token reads", async () => {
    seedPersisted();
    let refreshCalls = 0;
    const fetchMock: AuthFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        // Simulate real network latency so both callers overlap in-flight.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          JSON.stringify({
            accessToken: "at-new",
            refreshToken: "rt-new",
            accessTokenExpiresAtMs: Date.now() + 900_000,
            deviceId: "device-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });

    const store = new AuthStore(fetchMock);
    // Two concurrent callers, both seeing an unauthenticated (expired) cached token.
    const [a, b] = await Promise.all([store.getAccessToken(), store.getAccessToken()]);

    expect(refreshCalls).toBe(1);
    expect(a).toBe("at-new");
    expect(b).toBe("at-new");
    expect(store.getSnapshot().refreshToken).toBe("rt-new");
  });

  it("dedupes a reactive 401 handler call against a concurrent proactive refresh", async () => {
    seedPersisted();
    let refreshCalls = 0;
    const fetchMock: AuthFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          JSON.stringify({
            accessToken: "at-new",
            refreshToken: "rt-new",
            accessTokenExpiresAtMs: Date.now() + 900_000,
            deviceId: "device-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const store = new AuthStore(fetchMock);
    const [proactive, reactive] = await Promise.all([
      store.getAccessToken(),
      store.handleUnauthorized(),
    ]);

    expect(refreshCalls).toBe(1);
    expect(proactive).toBe("at-new");
    expect(reactive).toBe("at-new");
  });

  it("clears the store when refresh fails (reuse-detected / revoked chain)", async () => {
    seedPersisted();
    const fetchMock: AuthFetch = vi.fn(async () => new Response(null, { status: 401 }));
    const store = new AuthStore(fetchMock);

    const result = await store.handleUnauthorized();
    expect(result).toBeNull();
    expect(store.isAuthenticated()).toBe(false);
  });

  it("does NOT clear on a transient network error — the refresh token survives for a retry", async () => {
    seedPersisted();
    const fetchMock: AuthFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch"); // offline / connection refused during a server restart
    });
    const store = new AuthStore(fetchMock);

    const result = await store.handleUnauthorized();
    expect(result).toBeNull(); // this attempt failed...
    expect(store.isAuthenticated()).toBe(true); // ...but the credential is intact

    // A later attempt against a recovered server succeeds without re-login.
    const recovered: AuthFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: "at-1",
            refreshToken: "rt-1",
            accessTokenExpiresAtMs: Date.now() + 900_000,
            deviceId: "device-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const store2 = new AuthStore(recovered);
    expect(await store2.handleUnauthorized()).toBe("at-1");
  });

  it("does NOT clear on a 5xx/503/429 (server restarting or rate-limited) — only a 401 clears", async () => {
    for (const status of [500, 503, 429]) {
      seedPersisted();
      const fetchMock: AuthFetch = vi.fn(async () => new Response(null, { status }));
      const store = new AuthStore(fetchMock);
      const result = await store.handleUnauthorized();
      expect(result).toBeNull();
      expect(store.isAuthenticated()).toBe(true); // credential preserved across a transient server failure
    }
  });

  it("does not refresh when the cached access token is still fresh", async () => {
    seedPersisted();
    const fetchMock: AuthFetch = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const store = new AuthStore(fetchMock);
    store.applyTokenPair({
      accessToken: "at-fresh",
      refreshToken: "rt-0",
      accessTokenExpiresAtMs: Date.now() + 900_000,
      deviceId: "device-1",
    });

    const token = await store.getAccessToken();
    expect(token).toBe("at-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getAuthStore() singleton hardening (HMR / module-duplication)", () => {
  it("returns the same instance across repeated calls", () => {
    expect(getAuthStore()).toBe(getAuthStore());
  });

  it("survives module re-evaluation: two independently-evaluated copies of this module share one AuthStore instance", async () => {
    // `import.meta.url` gives a stable specifier we can force vitest to
    // re-execute via resetModules() — this simulates exactly the failure
    // mode the fix targets: dev HMR (or duplicate bundler chunks) creating
    // a SECOND copy of auth-store.ts's module scope, which — with a plain
    // `let singleton` — would produce a second AuthStore fighting the first
    // over the same rotating refresh token.
    const first = await import("./auth-store.js");
    const firstInstance = first.getAuthStore();

    vi.resetModules();

    const second = await import("./auth-store.js");
    const secondInstance = second.getAuthStore();

    // Two distinct module namespace objects (proving re-evaluation actually
    // happened)...
    expect(second).not.toBe(first);
    // ...but the SAME AuthStore instance underneath, because the singleton
    // is stashed on globalThis (never duplicated) rather than in module
    // scope (duplicated by resetModules, exactly like HMR would).
    expect(secondInstance).toBe(firstInstance);
  });
});

describe("AuthStore logout", () => {
  it("calls POST /auth/logout with the device id and clears state regardless of network outcome", async () => {
    seedPersisted();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: AuthFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      return new Response(null, { status: 204 });
    });

    const store = new AuthStore(fetchMock);
    store.applyTokenPair({
      accessToken: "at-0",
      refreshToken: "rt-0",
      accessTokenExpiresAtMs: Date.now() + 900_000,
      deviceId: "device-1",
    });

    await store.logout();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/auth/logout");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ deviceId: "device-1" });
    expect(store.isAuthenticated()).toBe(false);
  });

  it("still clears local state if the logout network call throws", async () => {
    seedPersisted();
    const fetchMock: AuthFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const store = new AuthStore(fetchMock);
    store.applyTokenPair({
      accessToken: "at-0",
      refreshToken: "rt-0",
      accessTokenExpiresAtMs: Date.now() + 900_000,
      deviceId: "device-1",
    });

    await store.logout();
    expect(store.isAuthenticated()).toBe(false);
  });
});

describe("AuthStore.checkNeedsSetup (STATE.md P4.6 boot wiring)", () => {
  it("returns true when the server reports needsSetup: true", async () => {
    const fetchMock: AuthFetch = vi.fn(async (url: string) => {
      expect(url).toContain("/setup/state");
      return new Response(JSON.stringify({ needsSetup: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    expect(await store.checkNeedsSetup()).toBe(true);
  });

  it("returns false when the server reports needsSetup: false", async () => {
    const fetchMock: AuthFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ needsSetup: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    expect(await store.checkNeedsSetup()).toBe(false);
  });

  it("memoizes: a second call never re-hits the network", async () => {
    let calls = 0;
    const fetchMock: AuthFetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ needsSetup: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    expect(await store.checkNeedsSetup()).toBe(true);
    expect(await store.checkNeedsSetup()).toBe(true);
    expect(await store.checkNeedsSetup()).toBe(true);
    expect(calls).toBe(1);
  });

  it("single-flights concurrent callers into exactly one network call", async () => {
    let calls = 0;
    const fetchMock: AuthFetch = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ needsSetup: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    const [a, b, c] = await Promise.all([
      store.checkNeedsSetup(),
      store.checkNeedsSetup(),
      store.checkNeedsSetup(),
    ]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([true, true, true]);
  });

  it("fails CLOSED (false) on a non-2xx response — never flashes the wizard due to a server error", async () => {
    const fetchMock: AuthFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    expect(await store.checkNeedsSetup()).toBe(false);
  });

  it("fails CLOSED (false) on a network error", async () => {
    const fetchMock: AuthFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const store = new AuthStore(fetchMock);
    store.setServerUrl("http://localhost:3001");

    expect(await store.checkNeedsSetup()).toBe(false);
  });

  it("falls back to the same-origin:3001 guess when no serverUrl is set yet", async () => {
    const fetchMock: AuthFetch = vi.fn(async (url: string) => {
      expect(url).toMatch(/:3001\/setup\/state$/);
      return new Response(JSON.stringify({ needsSetup: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const store = new AuthStore(fetchMock);
    // No setServerUrl() call — jsdom's default location is http://localhost/.
    await store.checkNeedsSetup();
    expect(fetchMock).toHaveBeenCalled();
  });
});
