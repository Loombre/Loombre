// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/http01-server.spec.ts
//
// Real HTTP requests against a real listening server (127.0.0.1, an
// ephemeral port) — no docker/pebble needed for this piece; the pebble
// suite (test/tls/acme-pebble.integration.spec.ts) proves the SAME class
// end-to-end against a real ACME server crossing a real network boundary.

import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Http01ChallengeServer } from "./http01-server.js";

function get(port: number, path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

describe("Http01ChallengeServer", () => {
  let server: Http01ChallengeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("serves a registered token's key authorization at the well-known path", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1" });
    await server.listen(0);
    const port = server.port!;

    server.register("abc123", "abc123.thumbprint-xyz");
    const res = await get(port, "/.well-known/acme-challenge/abc123");
    expect(res.status).toBe(200);
    expect(res.body).toBe("abc123.thumbprint-xyz");
  });

  it("404s an unknown token", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1" });
    await server.listen(0);
    const port = server.port!;

    const res = await get(port, "/.well-known/acme-challenge/nope");
    expect(res.status).toBe(404);
  });

  it("404s an unregistered (removed) token even if it was previously registered", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1" });
    await server.listen(0);
    const port = server.port!;

    server.register("gone", "value");
    server.unregister("gone");
    const res = await get(port, "/.well-known/acme-challenge/gone");
    expect(res.status).toBe(404);
  });

  it("404s any other path when no https redirect port is configured", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1" });
    await server.listen(0);
    const port = server.port!;

    const res = await get(port, "/anything");
    expect(res.status).toBe(404);
  });

  it("301-redirects any other path to https on redirectHttpsPort when configured", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1", redirectHttpsPort: 3643 });
    await server.listen(0);
    const port = server.port!;

    const res = await get(port, "/browse");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`https://127.0.0.1:3643/browse`);
  });

  it("isListening reflects real listen()/close() state", async () => {
    server = new Http01ChallengeServer({ host: "127.0.0.1" });
    expect(server.isListening).toBe(false);
    await server.listen(0);
    expect(server.isListening).toBe(true);
    await server.close();
    expect(server.isListening).toBe(false);
  });
});
