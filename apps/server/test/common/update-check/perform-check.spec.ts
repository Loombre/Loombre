// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/common/update-check/perform-check.spec.ts
//
// STATE.md P4.3/P4.16 test requirement: "update-check client against local
// fixture server (valid manifest / tampered manifest via the frozen
// package's tamper fixtures / unreachable / disabled)". This suite uses
// @loombre/release-manifest's OWN real signing fixture helpers
// (test/helpers/minisign-fixtures.ts — a genuine ed25519 keypair via
// node:crypto, hand-encoded into the actual minisign wire format, exactly
// what that package's own spike test proves against) so "tampered" here
// means a REAL signature over REAL bytes that got REAL-ly bit-flipped, not
// a mocked verifier. Imported by relative path (test-only helper, not
// exported from the package's public src/ — see that file's own header)
// straight from its TypeScript source: vitest transforms it on the fly,
// no build step needed for TEST code (unlike apps/server's PRODUCTION
// import of the package (Wave-1 shim since replaced by the real workspace dep)
// that one DOES need a relative dist-path + explicit build-order hook).
//
// fetchImpl is injected directly (perform-check.ts's UpdateCheckDeps) —
// this suite does not spin up a real HTTP server; the zero-identifying-
// payload capture test (a separate file) is the one that does, since ITS
// whole point is proving what a REAL fetch() call sends over the wire.

import { describe, expect, it, vi } from "vitest";
import {
  generateFixtureKeypair,
  buildPublicKeyFile,
  buildSignatureFile,
} from "../../../../../packages/release-manifest/test/helpers/minisign-fixtures.js";
import { performUpdateCheck, fetchWithBoundedRedirects, MAX_REDIRECT_HOPS, type UpdateCheckConfig } from "../../../src/common/update-check/perform-check.js";

const NOW_MS = 1_753_315_200_000;

function baseConfig(overrides: Partial<UpdateCheckConfig> = {}, publicKeyText: string): UpdateCheckConfig {
  return {
    mode: "manual",
    manifestBaseUrl: "https://manifest.example.invalid/releases",
    channel: "stable",
    currentVersion: "0.9.0",
    publicKeyText,
    ...overrides,
  };
}

function manifestJson(releases: Array<{ version: string; notesUrl?: string }>) {
  return JSON.stringify({
    manifestVersion: 1,
    channel: "stable",
    releases: releases.map((r) => ({
      version: r.version,
      releasedAtMs: NOW_MS,
      notesUrl: r.notesUrl ?? `https://example.invalid/releases/${r.version}`,
      artifacts: [],
    })),
  });
}

function fakeFetchFor(manifestBody: string | null, sigBody: string | null, opts: { fail?: boolean; manifestStatus?: number; sigStatus?: number } = {}) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (opts.fail) throw new Error("simulated network failure");
    if (href.endsWith(".minisig")) {
      return new Response(sigBody ?? "", { status: opts.sigStatus ?? 200 });
    }
    return new Response(manifestBody ?? "", { status: opts.manifestStatus ?? 200 });
  });
}

describe("performUpdateCheck — disabled", () => {
  it("mode='off' never calls fetch and returns the disabled shape with checkedAtMs null", async () => {
    const keypair = generateFixtureKeypair();
    const config = baseConfig({ mode: "off" }, buildPublicKeyFile(keypair));
    const fetchImpl = vi.fn();

    const result = await performUpdateCheck(config, { fetchImpl, clockNowMs: () => NOW_MS });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      currentVersion: "0.9.0",
      channel: "stable",
      latestVersion: null,
      updateAvailable: false,
      notesUrl: null,
      checkedAtMs: null,
      verification: "disabled",
    });
  });
});

describe("performUpdateCheck — verified (valid manifest)", () => {
  it("verifies a genuine signature and reports the highest-precedence release", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "0.9.0" }, { version: "1.1.0" }, { version: "1.0.5" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("verified");
    expect(result.latestVersion).toBe("1.1.0"); // highest precedence, not last-in-array
    expect(result.notesUrl).toBe("https://example.invalid/releases/1.1.0");
    expect(result.updateAvailable).toBe(true);
    expect(result.checkedAtMs).toBe(NOW_MS);
  });

  it("updateAvailable is false when currentVersion is already the latest", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "0.9.0" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({ currentVersion: "0.9.0" }, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("verified");
    expect(result.updateAvailable).toBe(false);
  });

  it("an empty releases array verifies with latestVersion/notesUrl null", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("verified");
    expect(result.latestVersion).toBeNull();
    expect(result.notesUrl).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });
});

describe("performUpdateCheck — tampered manifest (real signatures, real tampering)", () => {
  it("a bit-flipped manifest body fails signature verification", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    // Flip one visible character in the JSON text after signing — the
    // signature was computed over the ORIGINAL bytes.
    const tamperedBody = body.replace('"1.1.0"', '"9.9.9"');
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(tamperedBody, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("signature-invalid");
    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("a manifest signed with a DIFFERENT key than the pinned one fails verification", async () => {
    const signingKeypair = generateFixtureKeypair();
    const pinnedKeypair = generateFixtureKeypair(); // different from the signer
    const body = manifestJson([{ version: "1.1.0" }]);
    const sig = buildSignatureFile(signingKeypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(pinnedKeypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("signature-invalid");
  });

  it("a truncated/corrupted .minisig file fails closed as signature-invalid, never throws", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const realSig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const truncatedSig = realSig.split("\n").slice(0, 2).join("\n"); // drop the trusted-comment + global-sig lines
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, truncatedSig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("signature-invalid");
  });

  it("a tampered trusted comment fails closed as signature-invalid", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const realSig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    // Anchored to line-start (^ + /m): the FIRST line is "untrusted
    // comment: ..." which literally contains the substring "trusted
    // comment: " (as a tail of "un" + "trusted comment: ...") — an
    // unanchored regex tampers that decorative line instead of the real
    // authenticated one and this test would false-pass.
    const tamperedSig = realSig.replace(/^trusted comment: .*/m, "trusted comment: forged");
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, tamperedSig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("signature-invalid");
  });

  it("an 'ED' prehashed-variant signature is recognized and always rejected (P4.18)", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body), { alg: "ED" });
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("signature-invalid");
  });

  it("a genuinely signed but non-JSON payload is 'unreachable', not a crash", async () => {
    const keypair = generateFixtureKeypair();
    const body = "not json at all";
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
  });

  it("a genuinely signed but structurally malformed manifest is 'unreachable'", async () => {
    const keypair = generateFixtureKeypair();
    const body = JSON.stringify({ manifestVersion: 1, channel: "stable" /* missing releases */ });
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
  });

  it("a genuinely signed manifest for a DIFFERENT channel is 'unreachable' for this server", async () => {
    const keypair = generateFixtureKeypair();
    const body = JSON.stringify({
      manifestVersion: 1,
      channel: "beta",
      releases: [{ version: "1.1.0", releasedAtMs: NOW_MS, notesUrl: "x", artifacts: [] }],
    });
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({ channel: "stable" }, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, sig),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
  });
});

describe("performUpdateCheck — unreachable", () => {
  it("a network-level failure (fetch throws) is 'unreachable'", async () => {
    const keypair = generateFixtureKeypair();
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(null, null, { fail: true }),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
    expect(result.checkedAtMs).toBe(NOW_MS);
  });

  it("a non-2xx manifest response is 'unreachable'", async () => {
    const keypair = generateFixtureKeypair();
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor("", "", { manifestStatus: 404 }),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
  });

  it("a non-2xx signature response is 'unreachable'", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const result = await performUpdateCheck(config, {
      fetchImpl: fakeFetchFor(body, "", { sigStatus: 404 }),
      clockNowMs: () => NOW_MS,
    });

    expect(result.verification).toBe("unreachable");
  });
});

describe("performUpdateCheck — request shape", () => {
  it("fetches exactly manifest.json and manifest.json.minisig under the configured base URL", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({ manifestBaseUrl: "https://mirror.example.invalid/releases/" }, buildPublicKeyFile(keypair));
    const fetchImpl = fakeFetchFor(body, sig);

    await performUpdateCheck(config, { fetchImpl, clockNowMs: () => NOW_MS });

    const calledUrls = fetchImpl.mock.calls.map((call) => String(call[0])).sort();
    expect(calledUrls).toEqual([
      "https://mirror.example.invalid/releases/manifest.json",
      "https://mirror.example.invalid/releases/manifest.json.minisig",
    ]);
  });
});

// Security review L3: the update check used to hand fetch() its default
// redirect-following behavior — an unbounded, unvalidated chain. The
// default GitHub `releases/latest/download` base REQUIRES one redirect
// (302 to the CDN), so a flat no-redirect fetch is not an option; instead
// redirects are followed MANUALLY with a hop cap and per-hop validation:
// a redirect target must be https (no downgrade-to-plain-http bounce to
// somewhere on the operator's LAN) unless it stays same-origin (a local
// http mirror redirecting within itself, as fixture servers do).
describe("fetchWithBoundedRedirects (L3)", () => {
  const redirectTo = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  it("follows redirects to https targets and returns the final response, always fetching with redirect:'manual'", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo("https://cdn.example.invalid/assets/manifest.json"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchWithBoundedRedirects(fetchImpl as unknown as typeof fetch, "https://github.example.invalid/releases/latest/download/manifest.json", { method: "GET" });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://cdn.example.invalid/assets/manifest.json");
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe("manual");
    }
  });

  it("resolves a relative Location against the current URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo("/mirror/manifest.json"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchWithBoundedRedirects(fetchImpl as unknown as typeof fetch, "https://mirror.example.invalid/releases/manifest.json", { method: "GET" });

    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://mirror.example.invalid/mirror/manifest.json");
  });

  it("allows a same-origin plain-http redirect (local fixture/lab mirrors)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo("http://127.0.0.1:8099/alt/manifest.json"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchWithBoundedRedirects(fetchImpl as unknown as typeof fetch, "http://127.0.0.1:8099/releases/manifest.json", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("refuses a cross-origin redirect to a non-https target", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectTo("http://192.168.1.1/admin"));

    await expect(
      fetchWithBoundedRedirects(fetchImpl as unknown as typeof fetch, "https://mirror.example.invalid/releases/manifest.json", { method: "GET" }),
    ).rejects.toThrow(/non-https/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`caps the chain at ${MAX_REDIRECT_HOPS} hops`, async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const n = Number(new URL(String(url)).pathname.replace(/\D/g, "") || 0);
      return Promise.resolve(redirectTo(`https://mirror.example.invalid/hop${n + 1}`));
    });

    await expect(
      fetchWithBoundedRedirects(fetchImpl as unknown as typeof fetch, "https://mirror.example.invalid/hop0", { method: "GET" }),
    ).rejects.toThrow(/redirect/);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(MAX_REDIRECT_HOPS + 1);
  });

  it("performUpdateCheck reports 'unreachable' when the redirect chain is refused (never throws to the caller)", async () => {
    const keypair = generateFixtureKeypair();
    const config = baseConfig({}, buildPublicKeyFile(keypair));
    const fetchImpl = vi.fn().mockResolvedValue(redirectTo("http://10.0.0.1/loot"));

    const result = await performUpdateCheck(config, { fetchImpl: fetchImpl as unknown as typeof fetch, clockNowMs: () => NOW_MS });
    expect(result.verification).toBe("unreachable");
  });

  it("performUpdateCheck verifies end-to-end through a well-behaved https redirect", async () => {
    const keypair = generateFixtureKeypair();
    const body = manifestJson([{ version: "1.1.0" }]);
    const sig = buildSignatureFile(keypair, new TextEncoder().encode(body));
    const config = baseConfig({}, buildPublicKeyFile(keypair));

    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://cdn.example.invalid/")) {
        return Promise.resolve(new Response(u.endsWith(".minisig") ? sig : body, { status: 200 }));
      }
      const target = u.replace("https://manifest.example.invalid/releases", "https://cdn.example.invalid/assets");
      return Promise.resolve(redirectTo(target));
    });

    const result = await performUpdateCheck(config, { fetchImpl: fetchImpl as unknown as typeof fetch, clockNowMs: () => NOW_MS });
    expect(result.verification).toBe("verified");
  });
});
