// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/common/update-check/zero-identifying-payload.spec.ts
//
// STATE.md P4.3/P4.16 test requirement: "a TEST asserting the outgoing
// request contains zero identifying content (capture the request in a
// local http server fixture)". Uses a REAL node:http server and the REAL
// global fetch (not a mocked fetchImpl) — this is the one test in this
// directory whose entire point is proving what actually goes over the
// wire, byte for byte, when performUpdateCheck talks to
// LOOMBRE_UPDATE_MANIFEST_URL. docs/ops/updating.md documents this exact
// contract in prose; this test is its enforcement.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateFixtureKeypair,
  buildPublicKeyFile,
  buildSignatureFile,
} from "../../../../../packages/release-manifest/test/helpers/minisign-fixtures.js";
import { performUpdateCheck } from "../../../src/common/update-check/perform-check.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}

describe("performUpdateCheck — zero-identifying-payload (real HTTP, real fetch)", () => {
  let server: Server;
  let baseUrl: string;
  const captured: CapturedRequest[] = [];

  beforeEach(async () => {
    captured.length = 0;
    const keypair = generateFixtureKeypair();
    const manifestBody = JSON.stringify({
      manifestVersion: 1,
      channel: "stable",
      releases: [
        { version: "1.0.0", releasedAtMs: 1, notesUrl: "https://example.invalid/1.0.0", artifacts: [] },
      ],
    });
    const sigBody = buildSignatureFile(keypair, new TextEncoder().encode(manifestBody));
    const publicKeyText = buildPublicKeyFile(keypair);

    server = createServer((req, res) => {
      captured.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url?.endsWith(".minisig")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(sigBody);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(manifestBody);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Stash for the test bodies below (avoids threading publicKeyText
    // through beforeEach's closure awkwardly).
    (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText = publicKeyText;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText;
  });

  it("makes exactly 2 bare GET requests, no query string, to manifest.json and manifest.json.minisig", async () => {
    const publicKeyText = (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText!;

    const result = await performUpdateCheck(
      { mode: "manual", manifestBaseUrl: baseUrl, channel: "stable", currentVersion: "0.9.0", publicKeyText },
      { fetchImpl: fetch, clockNowMs: () => 1_753_315_200_000 },
    );

    expect(result.verification).toBe("verified"); // end-to-end sanity: the round trip actually worked
    expect(captured).toHaveLength(2);

    for (const request of captured) {
      expect(request.method).toBe("GET");
      expect(request.url).not.toContain("?");
      expect(request.url).toMatch(/^\/manifest\.json(\.minisig)?$/);
    }
  });

  it("sends no query parameters and no cookies/authorization/identifying headers of any kind", async () => {
    const publicKeyText = (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText!;

    await performUpdateCheck(
      { mode: "manual", manifestBaseUrl: baseUrl, channel: "stable", currentVersion: "0.9.0", publicKeyText },
      { fetchImpl: fetch, clockNowMs: () => 1_753_315_200_000 },
    );

    for (const request of captured) {
      const headerNames = Object.keys(request.headers).map((h) => h.toLowerCase());

      // Nothing that could carry a session/identity/install fingerprint.
      expect(headerNames).not.toContain("cookie");
      expect(headerNames).not.toContain("authorization");
      expect(headerNames).not.toContain("x-forwarded-for");
      expect(headerNames).not.toContain("x-request-id");
      expect(headerNames).not.toContain("x-installation-id");
      expect(headerNames).not.toContain("x-device-id");
      expect(headerNames).not.toContain("x-loombre-version");
      expect(headerNames).not.toContain("x-os");
      expect(headerNames).not.toContain("referer");
    }
  });

  it("User-Agent is the fixed generic literal 'loombre-update-check' — no version, no OS, no host info appended", async () => {
    const publicKeyText = (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText!;

    await performUpdateCheck(
      { mode: "manual", manifestBaseUrl: baseUrl, channel: "stable", currentVersion: "0.9.0", publicKeyText },
      { fetchImpl: fetch, clockNowMs: () => 1_753_315_200_000 },
    );

    for (const request of captured) {
      const ua = request.headers["user-agent"];
      expect(ua).toBe("loombre-update-check");
      // Belt-and-suspenders: the literal must never have been templated
      // with the running version or platform (the classic "add it later
      // for debugging" regression this test exists to catch).
      expect(ua).not.toMatch(/\d+\.\d+\.\d+/); // no semver-shaped substring
      expect(ua?.toLowerCase()).not.toMatch(/darwin|linux|win32|macos|windows/);
    }
  });

  it("the full captured header set is exactly the documented allowlist — nothing extra ever sneaks in", async () => {
    const publicKeyText = (globalThis as { __fixturePublicKeyText?: string }).__fixturePublicKeyText!;

    await performUpdateCheck(
      { mode: "manual", manifestBaseUrl: baseUrl, channel: "stable", currentVersion: "0.9.0", publicKeyText },
      { fetchImpl: fetch, clockNowMs: () => 1_753_315_200_000 },
    );

    // Headers Node's own fetch (undici) always adds per the Fetch spec
    // (transport/protocol plumbing, not application-chosen, and carry no
    // identifying content — `sec-fetch-mode` is a fixed literal like
    // "cors", never anything about THIS install) plus the application-
    // chosen headers this checker explicitly sets (perform-check.ts's
    // REQUEST_HEADERS) — docs/ops/updating.md lists this exact set as
    // "everything the request contains".
    const ALLOWED = new Set([
      "host",
      "connection",
      "accept",
      "accept-encoding",
      "accept-language",
      "user-agent",
      "sec-fetch-mode",
    ]);

    for (const request of captured) {
      const headerNames = Object.keys(request.headers).map((h) => h.toLowerCase());
      const unexpected = headerNames.filter((h) => !ALLOWED.has(h));
      expect(unexpected, `unexpected header(s) on the update-check request: ${unexpected.join(", ")}`).toEqual([]);
    }
  });
});
