// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/settings-registry.test.ts
//
// Addendum A / lane S1: registry-level invariants that must hold no matter
// how many entries get added later — "every default is valid" and "every
// env-only entry declares its envVar" are the two the mission text names
// explicitly as minimum coverage.

import { describe, expect, it } from "vitest";
import {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_BY_KEY,
  getSettingsRegistryEntry,
  registryDefaultForTier,
  settingsValueJsonSchema,
} from "../src/settings-registry.js";

describe("SETTINGS_REGISTRY", () => {
  it("has at least one entry of each scope", () => {
    const scopes = new Set(SETTINGS_REGISTRY.map((e) => e.scope));
    expect(scopes.has("ui")).toBe(true);
    expect(scopes.has("env-only")).toBe(true);
  });

  it("every key is unique", () => {
    const keys = SETTINGS_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry's simple default passes its own schema", () => {
    for (const entry of SETTINGS_REGISTRY) {
      const result = entry.schema.safeParse(entry.default);
      expect(result.success, `${entry.key}: default ${JSON.stringify(entry.default)} failed schema: ${JSON.stringify(!result.success ? result.error.issues : undefined)}`).toBe(true);
    }
  });

  it("every tierDefaults value (0/1/2) passes its own schema", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (!entry.tierDefaults) continue;
      for (const tier of [0, 1, 2] as const) {
        const value = registryDefaultForTier(entry, tier);
        const result = entry.schema.safeParse(value);
        expect(result.success, `${entry.key} tier ${tier}: ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  it("every env-only entry declares envVar", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.scope === "env-only") {
        expect(entry.envVar, `${entry.key} is env-only but has no envVar`).toBeDefined();
      }
    }
  });

  it("every entry with a parseEnv also declares envVar", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.parseEnv) {
        expect(entry.envVar, `${entry.key} has parseEnv but no envVar`).toBeDefined();
      }
    }
  });

  it("restricted.majorityAgeYears enforces the >=18 floor in its schema (D13/A3)", () => {
    const entry = getSettingsRegistryEntry("restricted.majorityAgeYears");
    expect(entry).toBeDefined();
    expect(entry!.schema.safeParse(17).success).toBe(false);
    expect(entry!.schema.safeParse(18).success).toBe(true);
  });

  it("every rateLimit.* entry has a hard floor of >=1 in its own unit (AD1 lockout-impossibility)", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.category !== "rateLimit") continue;
      expect(entry.schema.safeParse(0).success, `${entry.key} must reject 0`).toBe(false);
      expect(entry.schema.safeParse(-1).success, `${entry.key} must reject negative`).toBe(false);
      expect(entry.schema.safeParse(1).success, `${entry.key} must accept 1`).toBe(true);
    }
  });

  it("SETTINGS_REGISTRY_BY_KEY is a 1:1 index of SETTINGS_REGISTRY", () => {
    expect(SETTINGS_REGISTRY_BY_KEY.size).toBe(SETTINGS_REGISTRY.length);
    for (const entry of SETTINGS_REGISTRY) {
      expect(SETTINGS_REGISTRY_BY_KEY.get(entry.key)).toBe(entry);
    }
  });

  it("settingsValueJsonSchema produces a JSON-schema-shaped projection for every entry", () => {
    for (const entry of SETTINGS_REGISTRY) {
      const schema = settingsValueJsonSchema(entry);
      expect(typeof schema).toBe("object");
      expect(schema).not.toBeNull();
      expect(schema["$schema"]).toBeDefined();
    }
  });

  it("transcode.maxSimultaneousTranscodes tierDefaults matches resolve-policy.ts's historical tier table (1/2/4)", () => {
    const entry = getSettingsRegistryEntry("transcode.maxSimultaneousTranscodes");
    expect(entry?.tierDefaults).toEqual({ 0: 1, 1: 2, 2: 4 });
  });

  // ==========================================================================
  // Security review F1: database.url's `secret` flag — the value it protects
  // embeds a Postgres password, unlike every other env-only entry.
  // ==========================================================================

  describe("F1: `secret` flag audit", () => {
    it("database.url is flagged secret:true", () => {
      const entry = getSettingsRegistryEntry("database.url");
      expect(entry?.secret).toBe(true);
    });

    it("no other entry is flagged secret:true (none of the audited env-only paths/flags are credentials)", () => {
      const secretEntries = SETTINGS_REGISTRY.filter((e) => e.secret === true);
      expect(secretEntries.map((e) => e.key)).toEqual(["database.url"]);
    });
  });

  // ==========================================================================
  // Security review F9: ceilings on single-key schemas that were previously
  // floor-only, so a schema-legal edit or env pin couldn't take the product
  // down or turn a knob into an effectively-unbounded value.
  // ==========================================================================

  describe("F9: registry-level ceilings", () => {
    it("transcode.maxSimultaneousTranscodes rejects above 64, accepts 64", () => {
      const entry = getSettingsRegistryEntry("transcode.maxSimultaneousTranscodes")!;
      expect(entry.schema.safeParse(65).success).toBe(false);
      expect(entry.schema.safeParse(64).success).toBe(true);
    });

    it("scanner.concurrency rejects above 64, accepts 64", () => {
      const entry = getSettingsRegistryEntry("scanner.concurrency")!;
      expect(entry.schema.safeParse(65).success).toBe(false);
      expect(entry.schema.safeParse(64).success).toBe(true);
    });

    it("sessions.heartbeatSuspendCutoffMs rejects below 30s and above 1h, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("sessions.heartbeatSuspendCutoffMs")!;
      expect(entry.schema.safeParse(29_999).success).toBe(false);
      expect(entry.schema.safeParse(30_000).success).toBe(true);
      expect(entry.schema.safeParse(3_600_001).success).toBe(false);
      expect(entry.schema.safeParse(3_600_000).success).toBe(true);
    });

    it("sessions.staleCutoffMs rejects below 1min and above 24h, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("sessions.staleCutoffMs")!;
      expect(entry.schema.safeParse(59_999).success).toBe(false);
      expect(entry.schema.safeParse(60_000).success).toBe(true);
      expect(entry.schema.safeParse(86_400_001).success).toBe(false);
      expect(entry.schema.safeParse(86_400_000).success).toBe(true);
    });

    it("transcode.ladderRungs rejects an out-of-range per-rung bitrate (below 100kbps or above 100Mbps)", () => {
      const entry = getSettingsRegistryEntry("transcode.ladderRungs")!;
      const baseRung = { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" as const };
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 99_999 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000 }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000_001 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000_000 }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...baseRung, audioBitrateBps: 99_999 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, audioBitrateBps: 100_000_001 }]).success).toBe(false);
    });
  });

  // ==========================================================================
  // Security review F4: restricted.defaultUnlockDurationMs was floor-only
  // (.min(1)) — a schema-legal MAX_SAFE_INTEGER value turned gate 5 into a
  // permanent unlock. The exact PoC from the review is asserted directly.
  // ==========================================================================

  describe("F4: restricted.defaultUnlockDurationMs bounds", () => {
    it("rejects the review's MAX_SAFE_INTEGER permanent-unlock PoC", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.schema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    });

    it("rejects below 1 minute and above 24 hours, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.schema.safeParse(59_999).success).toBe(false);
      expect(entry.schema.safeParse(60_000).success).toBe(true);
      expect(entry.schema.safeParse(24 * 60 * 60 * 1000 + 1).success).toBe(false);
      expect(entry.schema.safeParse(24 * 60 * 60 * 1000).success).toBe(true);
    });

    it("carries a caution explaining the shared-device tradeoff", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.caution).toBeDefined();
      expect(entry.caution!.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Security review F5/F6/F11d: every scope:'ui' entry's `description` is
  // admin-UI-facing copy — plain language, no repo paths, no class/function
  // names, no signal names, no internal decision-ID citations.
  // ==========================================================================

  describe("F5/F6/F11d: scope:'ui' description register", () => {
    const uiEntries = SETTINGS_REGISTRY.filter((e) => e.scope === "ui");

    it("covers all 25 scope:'ui' entries (sanity — keeps this suite honest if the registry grows)", () => {
      expect(uiEntries.length).toBe(25);
    });

    it("no scope:'ui' description references a repo path (apps/, packages/, scripts/, docs/)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\b(apps|packages|scripts|docs)\//);
        expect(entry.caution ?? "", entry.key).not.toMatch(/\b(apps|packages|scripts|docs)\//);
      }
    });

    it("no scope:'ui' description references an internal decision ID (A1-A10, AD1-AD9, D1-D30-ish, P-phase IDs)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\b(A\d{1,2}|AD\d{1,2}|D\d{1,2}|P\d\.\d+)\b/);
      }
    });

    it("no scope:'ui' description references a POSIX signal name (SIGSTOP/SIGCONT/etc.)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\bSIG[A-Z]+\b/);
      }
    });

    it("scanner.concurrency's description carries the CPU-derived-default honesty sentence (F6)", () => {
      const entry = getSettingsRegistryEntry("scanner.concurrency")!;
      expect(entry.description).toMatch(/half your processor cores/i);
    });

    it("restricted.defaultUnlockDurationMs's description does NOT claim a client-requested-duration path (F11d — that path does not exist)", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.description).not.toMatch(/client/i);
      expect(entry.description).not.toMatch(/request/i);
    });
  });
});
