// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-client.test.ts
//
// Pins the reactive-401 retry's boundary (QA browser-restricted-settings-F2).
// The wrappers refresh-and-retry on 401 because a 401 usually means "your
// access token went stale". On a CREDENTIAL-VALIDATION endpoint that is
// wrong: POST /restricted/unlock answers 401 "Incorrect PIN." for a
// well-formed WRONG PIN, so the blanket retry refreshed a perfectly valid
// token and resent the same wrong PIN — two unlock POSTs per typed PIN,
// burning two of the five-per-minute unlock attempts and leaving the user
// only two real tries before "Too many attempts".
//
// These tests drive the REAL LoombreClient against a stubbed global fetch,
// so what they count is actual network calls, not wrapper internals.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const handleUnauthorized = vi.fn(async () => "refreshed-access-token");
  const store = {
    getSnapshot: () => ({ serverUrl: "http://api.test" }),
    getAccessToken: async () => "access-token",
    handleUnauthorized,
  };
  return { store, handleUnauthorized };
});

vi.mock("./auth-store.js", () => ({ getAuthStore: () => h.store }));

/** RFC 9457 problem+json response, exactly the shape the server sends. */
function problem(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** The 401 a WRONG PIN produces (restricted.controller.ts's
 *  `unauthorized("Incorrect PIN.", instance)`). */
function incorrectPin(): Response {
  return problem(401, {
    type: "urn:loombre:problem:unauthorized",
    title: "Unauthorized",
    status: 401,
    detail: "Incorrect PIN.",
    instance: "/restricted/unlock",
  });
}

/** The 401 the AuthGuard produces for a missing/expired/invalid Bearer
 *  token (UnauthenticatedException) — the one case a refresh DOES fix. */
function unauthenticated(instance: string): Response {
  return problem(401, {
    type: "urn:loombre:problem:unauthenticated",
    title: "Unauthenticated",
    status: 401,
    detail: "Missing or invalid Bearer token.",
    instance,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

async function loadClient(): Promise<typeof import("./api-client.js")> {
  // The module caches one LoombreClient per baseUrl, and the SDK binds the
  // global fetch at construction time — so the stub has to be in place
  // before the module is (re-)evaluated.
  vi.resetModules();
  return import("./api-client.js");
}

function postUrls(): string[] {
  return fetchMock.mock.calls
    .filter((call) => String((call[1] as RequestInit | undefined)?.method ?? "GET") === "POST")
    .map((call) => String(call[0]));
}

beforeEach(() => {
  h.handleUnauthorized.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("apiPost reactive-401 retry", () => {
  it("does NOT refresh-and-retry a wrong PIN: exactly one POST /restricted/unlock, one clean 401", async () => {
    fetchMock.mockImplementation(async () => incorrectPin());
    const { apiPost } = await loadClient();

    const err = await apiPost("/restricted/unlock", { body: { pin: "1111" } }).catch((e: unknown) => e);

    // Asserted structurally, not with `instanceof`: vi.resetModules() below
    // re-evaluates @loombre/sdk too, so the class identity a static import
    // would give this file is not the one the re-loaded module threw.
    expect((err as Error).name).toBe("LoombreApiError");
    expect((err as { status?: number }).status).toBe(401);
    expect((err as { problem?: { detail?: string } }).problem?.detail).toBe("Incorrect PIN.");
    expect(postUrls()).toEqual(["http://api.test/restricted/unlock"]);
    expect(h.handleUnauthorized).not.toHaveBeenCalled();
  });

  it("still refreshes-and-retries the unlock POST when the 401 came from the auth guard (stale token)", async () => {
    fetchMock
      .mockImplementationOnce(async () => unauthenticated("/restricted/unlock"))
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ unlockedUntilMs: 1_700_000_000_000 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
    const { apiPost } = await loadClient();

    await expect(apiPost("/restricted/unlock", { body: { pin: "1234" } })).resolves.toEqual({
      unlockedUntilMs: 1_700_000_000_000,
    });
    expect(h.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(postUrls()).toHaveLength(2);
  });

  it("keeps the blanket refresh-and-retry on ordinary (non-credential) endpoints", async () => {
    fetchMock
      .mockImplementationOnce(async () => unauthenticated("/restricted/lock"))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }));
    const { apiPost } = await loadClient();

    await expect(apiPost("/restricted/lock")).resolves.toBeUndefined();
    expect(h.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(postUrls()).toHaveLength(2);
  });
});
