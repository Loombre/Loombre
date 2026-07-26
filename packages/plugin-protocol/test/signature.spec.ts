// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/signature.spec.ts

import { describe, expect, it } from "vitest";
import {
  LPP_DEFAULT_REPLAY_WINDOW_MS,
  LPP_SIGNATURE_HEADER,
  generateLppSigningSecret,
  parseLppSignatureHeader,
  signLppBatch,
  verifyLppSignature,
} from "../src/signature.js";

const SECRET = "test-signing-secret";
const NOW_MS = 1_753_315_200_000;
const BODY = JSON.stringify({ batchId: "x", events: [] });

describe("signLppBatch / parseLppSignatureHeader", () => {
  it("produces a 't=<ms>,v1=<hex>' header value", () => {
    const header = signLppBatch(SECRET, NOW_MS, BODY);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("round-trips through parseLppSignatureHeader", () => {
    const header = signLppBatch(SECRET, NOW_MS, BODY);
    const parsed = parseLppSignatureHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestampMs).toBe(NOW_MS);
  });

  it("parseLppSignatureHeader returns null for a malformed header", () => {
    expect(parseLppSignatureHeader("not-a-signature")).toBeNull();
    expect(parseLppSignatureHeader("t=abc,v1=zz")).toBeNull();
    expect(parseLppSignatureHeader("v1=deadbeef")).toBeNull();
  });

  it("LPP_SIGNATURE_HEADER is the documented header name", () => {
    expect(LPP_SIGNATURE_HEADER).toBe("X-LPP-Signature");
  });
});

describe("verifyLppSignature", () => {
  it("accepts a validly signed, fresh batch", () => {
    const header = signLppBatch(SECRET, NOW_MS, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a missing signature header", () => {
    const result = verifyLppSignature({ headerValue: undefined, secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "missing-header" });
  });

  it("rejects a malformed signature header", () => {
    const result = verifyLppSignature({ headerValue: "garbage", secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "malformed-header" });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const header = signLppBatch(SECRET, NOW_MS, BODY);
    const tamperedBody = JSON.stringify({ batchId: "x", events: [{ tampered: true }] });
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: tamperedBody, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects the wrong secret", () => {
    const header = signLppBatch(SECRET, NOW_MS, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: "wrong-secret", rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects a stale timestamp outside the replay window", () => {
    const staleMs = NOW_MS - LPP_DEFAULT_REPLAY_WINDOW_MS - 1;
    const header = signLppBatch(SECRET, staleMs, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "stale-timestamp" });
  });

  it("rejects a future timestamp outside the replay window", () => {
    const futureMs = NOW_MS + LPP_DEFAULT_REPLAY_WINDOW_MS + 1;
    const header = signLppBatch(SECRET, futureMs, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: false, reason: "future-timestamp" });
  });

  it("accepts a timestamp exactly at the replay window boundary", () => {
    const header = signLppBatch(SECRET, NOW_MS - LPP_DEFAULT_REPLAY_WINDOW_MS, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: BODY, nowMs: NOW_MS });
    expect(result).toEqual({ valid: true });
  });

  it("honors a custom replayWindowMs", () => {
    const header = signLppBatch(SECRET, NOW_MS - 10_000, BODY);
    const result = verifyLppSignature({ headerValue: header, secret: SECRET, rawBody: BODY, nowMs: NOW_MS, replayWindowMs: 5_000 });
    expect(result).toEqual({ valid: false, reason: "stale-timestamp" });
  });
});

describe("generateLppSigningSecret", () => {
  it("produces a 64-char hex string (256 bits) and is not deterministic", () => {
    const a = generateLppSigningSecret();
    const b = generateLppSigningSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
