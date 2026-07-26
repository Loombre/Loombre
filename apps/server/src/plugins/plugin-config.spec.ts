// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-config.spec.ts
//
// LD1/LD6: ajv validation of submitted config values against a manifest's
// configSchema, and the secret/non-secret split.

import { describe, expect, it } from "vitest";
import type { LppConfig } from "@loombre/plugin-protocol";
import { validatePluginConfig } from "./plugin-config.js";

const SCHEMA_WITH_SECRET: LppConfig = {
  type: "object",
  properties: {
    fixturePrefix: { type: "string", description: "prefix" },
    webhookUrl: { type: "string", description: "webhook", secret: true },
    maxResults: { type: "integer", minimum: 0, maximum: 100 },
  },
  required: ["webhookUrl"],
  additionalProperties: false,
};

describe("validatePluginConfig", () => {
  it("splits non-secret and secret fields correctly on valid input", () => {
    const result = validatePluginConfig(SCHEMA_WITH_SECRET, {
      fixturePrefix: "Loombre",
      webhookUrl: "https://hooks.example/abc",
      maxResults: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nonSecret).toEqual({ fixturePrefix: "Loombre", maxResults: 10 });
      expect(result.secrets).toEqual({ webhookUrl: "https://hooks.example/abc" });
    }
  });

  it("never leaks the secret field into nonSecret, and vice versa", () => {
    const result = validatePluginConfig(SCHEMA_WITH_SECRET, { webhookUrl: "https://hooks.example/xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.nonSecret)).not.toContain("hooks.example");
      expect(Object.keys(result.secrets)).toEqual(["webhookUrl"]);
    }
  });

  it("fails when a required secret field is missing", () => {
    const result = validatePluginConfig(SCHEMA_WITH_SECRET, { fixturePrefix: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails on additionalProperties:false violation", () => {
    const result = validatePluginConfig(SCHEMA_WITH_SECRET, { webhookUrl: "https://x", extra: "nope" });
    expect(result.ok).toBe(false);
  });

  it("fails on an out-of-range number field", () => {
    const result = validatePluginConfig(SCHEMA_WITH_SECRET, { webhookUrl: "https://x", maxResults: 999 });
    expect(result.ok).toBe(false);
  });

  it("succeeds trivially for the empty configSchema (a plugin with no configurable fields)", () => {
    const empty: LppConfig = { type: "object", properties: {}, additionalProperties: false };
    const result = validatePluginConfig(empty, {});
    expect(result).toEqual({ ok: true, nonSecret: {}, secrets: {} });
  });

  it("a config with no secret fields at all produces an empty secrets object", () => {
    const noSecrets: LppConfig = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    const result = validatePluginConfig(noSecrets, { name: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets).toEqual({});
      expect(result.nonSecret).toEqual({ name: "hello" });
    }
  });
});
