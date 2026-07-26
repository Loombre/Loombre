// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/headers.spec.ts
//
// buildPluginRequestHeaders is a thin composition over plugin-protocol's
// frozen codecs (LD2) — this test proves the composition, not the codecs
// themselves (those are proven in packages/plugin-protocol/test/
// headers.spec.ts already).

import { describe, expect, it } from "vitest";
import { decodeLppConfigHeaderValue, decodeLppSecretHeaderValue, LPP_CONFIG_HEADER, lppSecretHeaderName } from "@loombre/plugin-protocol";
import { buildPluginRequestHeaders } from "../src/headers.js";

describe("buildPluginRequestHeaders", () => {
  it("always includes X-LPP-Config, base64/JSON round-trippable, even with no secrets", () => {
    const headers = buildPluginRequestHeaders({ fixturePrefix: "Loombre Fixture" });
    expect(headers[LPP_CONFIG_HEADER]).toBeDefined();
    expect(decodeLppConfigHeaderValue(headers[LPP_CONFIG_HEADER]!)).toEqual({ fixturePrefix: "Loombre Fixture" });
    expect(Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-lpp-secret-"))).toEqual([]);
  });

  it("adds one X-LPP-Secret-<NAME> header per secret field, independently decodable", () => {
    const headers = buildPluginRequestHeaders({}, { webhookUrl: "https://hooks.example/abc", apiKey: "s3cr3t" });
    const webhookHeader = lppSecretHeaderName("webhookUrl");
    const apiKeyHeader = lppSecretHeaderName("apiKey");
    expect(decodeLppSecretHeaderValue(headers[webhookHeader]!)).toBe("https://hooks.example/abc");
    expect(decodeLppSecretHeaderValue(headers[apiKeyHeader]!)).toBe("s3cr3t");
  });

  it("sets content-type: application/json", () => {
    const headers = buildPluginRequestHeaders({});
    expect(headers["content-type"]).toBe("application/json");
  });

  it("never leaks a secret value into the config header", () => {
    const headers = buildPluginRequestHeaders({ visible: "yes" }, { secretField: "TOP-SECRET-VALUE" });
    expect(headers[LPP_CONFIG_HEADER]).toBeDefined();
    const decodedConfig = Buffer.from(headers[LPP_CONFIG_HEADER]!, "base64").toString("utf8");
    expect(decodedConfig).not.toContain("TOP-SECRET-VALUE");
  });
});
