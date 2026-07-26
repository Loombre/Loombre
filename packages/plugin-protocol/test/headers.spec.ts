// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/headers.spec.ts

import { describe, expect, it } from "vitest";
import {
  LPP_CONFIG_HEADER,
  decodeLppConfigHeaderValue,
  decodeLppSecretHeaderValue,
  encodeLppConfigHeaderValue,
  encodeLppSecretHeaderValue,
  isLppSecretHeaderName,
  lppSecretFieldNameFromHeaderName,
  lppSecretHeaderFieldName,
  lppSecretHeaderName,
} from "../src/headers.js";

describe("config header encoding", () => {
  it("round-trips a plain object", () => {
    const config = { fixturePrefix: "Loombre Fixture", maxRetries: 3, enabled: true };
    const encoded = encodeLppConfigHeaderValue(config);
    expect(/^[A-Za-z0-9+/=]*$/.test(encoded)).toBe(true); // standard base64 alphabet, always ASCII
    expect(decodeLppConfigHeaderValue(encoded)).toEqual(config);
  });

  it("round-trips non-ASCII text safely (the header VALUE stays ASCII)", () => {
    const config = { label: "Café ☕ 日本語 — em dash", note: "emoji: 🎬🍿" };
    const encoded = encodeLppConfigHeaderValue(config);
    // every character of the encoded header value must be plain ASCII
    expect(/^[A-Za-z0-9+/=]*$/.test(encoded)).toBe(true);
    expect(decodeLppConfigHeaderValue(encoded)).toEqual(config);
  });

  it("LPP_CONFIG_HEADER is the documented header name", () => {
    expect(LPP_CONFIG_HEADER).toBe("X-LPP-Config");
  });
});

describe("secret header encoding", () => {
  it("round-trips a secret string value, including non-ASCII", () => {
    const value = "a-webhook-token-with-café-☕";
    const encoded = encodeLppSecretHeaderValue(value);
    expect(/^[A-Za-z0-9+/=]*$/.test(encoded)).toBe(true);
    expect(decodeLppSecretHeaderValue(encoded)).toBe(value);
  });
});

describe("lppSecretHeaderName / lppSecretHeaderFieldName", () => {
  it("uppercases a simple camelCase field key unchanged apart from case", () => {
    expect(lppSecretHeaderFieldName("webhookUrl")).toBe("WEBHOOKURL");
    expect(lppSecretHeaderName("webhookUrl")).toBe("X-LPP-Secret-WEBHOOKURL");
  });

  it("collapses non-token characters into '-' for an unusual field key", () => {
    expect(lppSecretHeaderFieldName("api key/v2")).toBe("API-KEY-V2");
  });

  it("throws for a field key with no representable token characters", () => {
    expect(() => lppSecretHeaderFieldName("日本語")).toThrow();
  });

  it("isLppSecretHeaderName recognizes the family case-insensitively", () => {
    expect(isLppSecretHeaderName("X-LPP-Secret-WEBHOOKURL")).toBe(true);
    expect(isLppSecretHeaderName("x-lpp-secret-webhookurl")).toBe(true);
    expect(isLppSecretHeaderName("X-LPP-Config")).toBe(false);
  });

  it("lppSecretFieldNameFromHeaderName strips the prefix", () => {
    expect(lppSecretFieldNameFromHeaderName("X-LPP-Secret-WEBHOOKURL")).toBe("WEBHOOKURL");
  });
});
