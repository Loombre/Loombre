// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/settings-resolve.test.ts
//
// Pure unit tests for resolveEffectiveSettings/computeRestartPendingKeys —
// no DB, no framework (ARCHITECTURE GUIDANCE: this module is deliberately
// I/O-free). Covers the mission's minimum list: env-pin-wins + DB-inert,
// invalid-at-boot DB value -> default + notice (never throw), unknown DB
// key -> reported (not dropped), restart-pending computation.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SettingsRegistryEntry } from "../src/settings-registry.js";
import {
  computeRestartPendingKeys,
  resolveEffectiveSettings,
  snapshotRestartSensitiveValues,
} from "../src/settings-resolve.js";

const BOOL_ENTRY: SettingsRegistryEntry<boolean> = {
  key: "test.boolFlag",
  schema: z.boolean(),
  default: false,
  category: "security",
  description: "test",
  requiresRestart: false,
  scope: "ui",
  envVar: "TEST_BOOL_FLAG",
  parseEnv: (raw) => {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0") return false;
    return undefined;
  },
};

const NUM_ENTRY: SettingsRegistryEntry<number> = {
  key: "test.numKnob",
  schema: z.number().int().min(1),
  default: 5,
  category: "rateLimit",
  description: "test",
  requiresRestart: true,
  scope: "ui",
};

const ENV_ONLY_ENTRY: SettingsRegistryEntry<string> = {
  key: "test.envOnlyPath",
  schema: z.string().min(1),
  default: "./default-path",
  category: "paths",
  description: "test",
  requiresRestart: true,
  scope: "env-only",
  envVar: "TEST_ENV_ONLY_PATH",
};

const TIERED_ENTRY: SettingsRegistryEntry<number> = {
  key: "test.tiered",
  schema: z.number().int().min(1),
  default: 1,
  tierDefaults: { 0: 1, 1: 2, 2: 4 },
  category: "transcode",
  description: "test",
  requiresRestart: false,
  scope: "ui",
};

const REGISTRY = [BOOL_ENTRY, NUM_ENTRY, ENV_ONLY_ENTRY, TIERED_ENTRY];

describe("resolveEffectiveSettings", () => {
  it("falls back to the registry default when nothing else is set", () => {
    const result = resolveEffectiveSettings(REGISTRY, {}, []);
    expect(result.values["test.boolFlag"]).toMatchObject({ value: false, source: "default", locked: false });
    expect(result.values["test.numKnob"]).toMatchObject({ value: 5, source: "default" });
    expect(result.values["test.envOnlyPath"]).toMatchObject({ value: "./default-path", source: "default" });
  });

  it("a valid DB value wins over the default", () => {
    const result = resolveEffectiveSettings(REGISTRY, {}, [{ key: "test.numKnob", value: 42 }]);
    expect(result.values["test.numKnob"]).toMatchObject({ value: 42, source: "database", locked: false });
  });

  it("env pin wins over a valid DB value AND marks it locked (A8)", () => {
    const result = resolveEffectiveSettings(
      REGISTRY,
      { TEST_BOOL_FLAG: "true" },
      [{ key: "test.boolFlag", value: false }],
    );
    expect(result.values["test.boolFlag"]).toMatchObject({
      value: true,
      source: "environment",
      locked: true,
      lockedBy: "TEST_BOOL_FLAG",
    });
  });

  it("removing the env pin restores the (still-preserved) DB value", () => {
    const dbRows = [{ key: "test.boolFlag", value: false }];
    const pinned = resolveEffectiveSettings(REGISTRY, { TEST_BOOL_FLAG: "true" }, dbRows);
    expect(pinned.values["test.boolFlag"].value).toBe(true);

    const unpinned = resolveEffectiveSettings(REGISTRY, {}, dbRows);
    expect(unpinned.values["test.boolFlag"]).toMatchObject({ value: false, source: "database", locked: false });
  });

  it("scope:'env-only' entries never consult a DB row, even if one exists", () => {
    const result = resolveEffectiveSettings(REGISTRY, {}, [{ key: "test.envOnlyPath", value: "/should/never/apply" }]);
    expect(result.values["test.envOnlyPath"]).toMatchObject({ value: "./default-path", source: "default" });
  });

  it("an invalid DB value falls back to default with a notice, never throws", () => {
    const result = resolveEffectiveSettings(REGISTRY, {}, [{ key: "test.numKnob", value: "not-a-number" }]);
    expect(result.values["test.numKnob"]).toMatchObject({ value: 5, source: "default" });
    expect(result.notices).toContainEqual(
      expect.objectContaining({ key: "test.numKnob", source: "database" }),
    );
  });

  it("an invalid env pin falls back to DB-or-default with a notice, never throws, and never locks", () => {
    const result = resolveEffectiveSettings(
      REGISTRY,
      { TEST_BOOL_FLAG: "not-a-boolean" },
      [{ key: "test.boolFlag", value: true }],
    );
    expect(result.values["test.boolFlag"]).toMatchObject({ value: true, source: "database", locked: false });
    expect(result.notices).toContainEqual(
      expect.objectContaining({ key: "test.boolFlag", source: "environment" }),
    );
  });

  it("an unknown DB key is reported, not silently dropped, and does not throw", () => {
    const result = resolveEffectiveSettings(REGISTRY, {}, [{ key: "not.a.real.key", value: 123 }]);
    expect(result.unknownDbKeys).toEqual(["not.a.real.key"]);
  });

  it("tier defaults select per LOOMBRE_TIER (A8)", () => {
    expect(resolveEffectiveSettings(REGISTRY, {}, [], { tier: 0 }).values["test.tiered"].value).toBe(1);
    expect(resolveEffectiveSettings(REGISTRY, {}, [], { tier: 1 }).values["test.tiered"].value).toBe(2);
    expect(resolveEffectiveSettings(REGISTRY, {}, [], { tier: 2 }).values["test.tiered"].value).toBe(4);
  });

  it("an empty-string env var is treated as unset (falls through)", () => {
    const result = resolveEffectiveSettings(REGISTRY, { TEST_BOOL_FLAG: "" }, []);
    expect(result.values["test.boolFlag"]).toMatchObject({ source: "default" });
  });
});

describe("computeRestartPendingKeys / snapshotRestartSensitiveValues", () => {
  it("only considers requiresRestart:true entries", () => {
    const before = resolveEffectiveSettings(REGISTRY, {}, []);
    const snapshot = snapshotRestartSensitiveValues(REGISTRY, before.values);
    expect(Object.keys(snapshot)).toEqual(["test.numKnob", "test.envOnlyPath"]);
  });

  it("reports no pending keys when nothing changed since boot", () => {
    const before = resolveEffectiveSettings(REGISTRY, {}, []);
    const snapshot = snapshotRestartSensitiveValues(REGISTRY, before.values);
    const after = resolveEffectiveSettings(REGISTRY, {}, []);
    expect(computeRestartPendingKeys(REGISTRY, snapshot, after.values)).toEqual([]);
  });

  it("reports a key whose effective value changed since boot, restricted to requiresRestart entries", () => {
    const before = resolveEffectiveSettings(REGISTRY, {}, []);
    const snapshot = snapshotRestartSensitiveValues(REGISTRY, before.values);

    // test.boolFlag is requiresRestart:false -> changing it must never appear as pending.
    const afterHotChange = resolveEffectiveSettings(REGISTRY, {}, [{ key: "test.boolFlag", value: true }]);
    expect(computeRestartPendingKeys(REGISTRY, snapshot, afterHotChange.values)).toEqual([]);

    // test.numKnob is requiresRestart:true -> changing it MUST appear as pending.
    const afterColdChange = resolveEffectiveSettings(REGISTRY, {}, [{ key: "test.numKnob", value: 99 }]);
    expect(computeRestartPendingKeys(REGISTRY, snapshot, afterColdChange.values)).toEqual(["test.numKnob"]);
  });
});
