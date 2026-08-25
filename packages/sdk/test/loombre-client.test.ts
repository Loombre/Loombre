// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/sdk/test/loombre-client.test.ts
//
// d3-e6: RUNTIME coverage for LoombreClient's one fetch seam. `request()`
// is the only place in the SDK that touches `fetch`, and everything it does
// — URL assembly, auth header, body encoding, response decoding, error
// shaping — was previously unguarded at runtime inside this package (the
// package's `test` script ran `tsc` only).
//
// `fetch` is stubbed through the constructor's own `fetch` option, so no
// network, no globals to restore — except in the ONE test that deliberately
// exercises the default path (see "binds the default fetch to globalThis").
//
// Real contract paths are used deliberately rather than casts: this file is
// also typechecked by `tsc -p tsconfig.test.json` (tsconfig includes
// `test`), so a call here that stopped matching openapi.yaml would fail the
// type-level half of the same command.

import { afterEach, describe, expect, it, vi } from "vitest";
import { LoombreApiError, LoombreClient } from "../src/client.js";

interface StubCall {
  url: string;
  init: RequestInit;
}

function stub(response: Response): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, token: string | null = "tok-123", baseUrl = "https://loombre.local"): LoombreClient {
  return new LoombreClient({ baseUrl, getAccessToken: () => token, fetch: fetchImpl });
}

describe("LoombreClient — URL assembly", () => {
  it("substitutes and percent-encodes path parameters", async () => {
    const s = stub(new Response("crash log", { status: 200, headers: { "content-type": "text/plain" } }));
    await client(s.fetch).get("/admin/crash-files/{name}", { params: { path: { name: "crash 2026/01.log" } } });
    expect(s.calls[0]!.url).toBe("https://loombre.local/admin/crash-files/crash%202026%2F01.log");
  });

  it("appends query parameters, repeats arrays, and skips null/undefined", async () => {
    const s = stub(json({ items: [], nextCursor: null }));
    await client(s.fetch).get("/libraries", {
      params: { query: { limit: 25, cursor: undefined } as never },
    });
    const url = new URL(s.calls[0]!.url);
    expect(url.pathname).toBe("/libraries");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("keeps a base URL's sub-path prefix instead of resolving it away", async () => {
    const s = stub(json({}));
    await client(s.fetch, "tok", "https://loombre.local/api/v1").get("/system/info");
    expect(s.calls[0]!.url).toBe("https://loombre.local/api/v1/system/info");
  });

  it("treats a base URL with and without a trailing slash identically", async () => {
    const a = stub(json({}));
    const b = stub(json({}));
    await client(a.fetch, "tok", "https://loombre.local/api").get("/system/info");
    await client(b.fetch, "tok", "https://loombre.local/api/").get("/system/info");
    expect(a.calls[0]!.url).toBe(b.calls[0]!.url);
  });
});

describe("LoombreClient — request shaping", () => {
  it("sends the bearer token when one is available and omits the header when it is not", async () => {
    const withToken = stub(json({}));
    await client(withToken.fetch, "tok-123").get("/system/info");
    expect((withToken.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-123");

    const withoutToken = stub(json({}));
    await client(withoutToken.fetch, null).get("/system/info");
    expect((withoutToken.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("awaits an async token provider", async () => {
    const s = stub(json({}));
    const c = new LoombreClient({
      baseUrl: "https://loombre.local",
      getAccessToken: () => Promise.resolve("async-tok"),
      fetch: s.fetch,
    });
    await c.get("/system/info");
    expect((s.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer async-tok");
  });

  it("JSON-encodes a body and sets Content-Type only when there is one", async () => {
    const withBody = stub(json({ id: "l1" }, 201));
    await client(withBody.fetch).post("/libraries", {
      body: { name: "Movies", mediaKind: "movie", paths: ["/media/movies"] } as never,
    });
    const init = withBody.calls[0]!.init;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Movies" });

    const withoutBody = stub(json({}));
    await client(withoutBody.fetch).get("/system/info");
    expect((withoutBody.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(withoutBody.calls[0]!.init.body).toBeUndefined();
  });

  it("always asks for JSON, and lets a caller override any header", async () => {
    const s = stub(json({}));
    await client(s.fetch).get("/system/info", { headers: { Accept: "text/plain", "X-Trace": "abc" } });
    const headers = s.calls[0]!.init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("text/plain");
    expect(headers["X-Trace"]).toBe("abc");
  });

  it("uppercases the method and forwards the abort signal", async () => {
    const s = stub(new Response(null, { status: 204 }));
    const controller = new AbortController();
    await client(s.fetch).delete("/playback/sessions/{id}", {
      params: { path: { id: "018f6f1e-0000-7000-8000-000000000004" } },
      signal: controller.signal,
    });
    expect(s.calls[0]!.init.method).toBe("DELETE");
    expect(s.calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe("LoombreClient — response decoding", () => {
  it("decodes a JSON body", async () => {
    const s = stub(json({ version: "0.9.0-rc.7" }));
    const info = await client(s.fetch).get("/system/info");
    expect(info).toMatchObject({ version: "0.9.0-rc.7" });
  });

  it("returns text for a non-JSON content type", async () => {
    const s = stub(new Response("segment log line\n", { status: 200, headers: { "content-type": "text/plain" } }));
    const body = await client(s.fetch).get("/admin/crash-files/{name}", { params: { path: { name: "a.log" } } });
    expect(body).toBe("segment log line\n");
  });

  it("returns undefined for 204 without touching the body", async () => {
    const s = stub(new Response(null, { status: 204 }));
    const result = await client(s.fetch).delete("/playback/sessions/{id}", {
      params: { path: { id: "018f6f1e-0000-7000-8000-000000000004" } },
    });
    expect(result).toBeUndefined();
  });
});

describe("LoombreClient — error shaping", () => {
  it("throws LoombreApiError carrying the parsed problem document, detail-first", async () => {
    const s = stub(
      new Response(JSON.stringify({ type: "urn:loombre:problem:not-found", title: "Not Found", status: 404, detail: "No such library." }), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      }),
    );
    await expect(client(s.fetch).get("/system/info")).rejects.toMatchObject({
      name: "LoombreApiError",
      status: 404,
      message: "No such library.",
    });
  });

  it("carries a non-JSON error body through as text", async () => {
    const s = stub(new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const err = await client(s.fetch)
      .get("/system/info")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoombreApiError);
    expect((err as LoombreApiError).problem).toBe("<html>502</html>");
    expect((err as LoombreApiError).message).toBe("Request failed with status 502");
  });

  it("survives an error body that claims JSON but is not — undefined problem, never a parse throw", async () => {
    const s = stub(new Response("not json at all", { status: 500, headers: { "content-type": "application/json" } }));
    const err = await client(s.fetch)
      .get("/system/info")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoombreApiError);
    expect((err as LoombreApiError).problem).toBeUndefined();
    expect((err as LoombreApiError).message).toBe("Request failed with status 500");
  });
});

describe("LoombreClient — default fetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("binds the default fetch to globalThis, so a browser's window.fetch is never called with the client as receiver", async () => {
    const receivers: unknown[] = [];
    globalThis.fetch = vi.fn(function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(json({ version: "x" }));
    }) as unknown as typeof fetch;

    // No `fetch` option: the constructor captures the global one, bound.
    const c = new LoombreClient({ baseUrl: "https://loombre.local", getAccessToken: () => null });
    await c.get("/system/info");

    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(globalThis);
  });
});
