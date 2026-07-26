// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/settings-resolve.ts
//
// Addendum A, ARCHITECTURE GUIDANCE: the effective-value resolution stays
// PURE here (no I/O, no framework, clock/env/DB-rows all passed in) so it is
// unit-testable in isolation and reusable by apps/server's settings service,
// apps/worker (lane S3's read-site migrations), and the docs generator
// (lane D1) alike — none of them need to re-derive precedence rules.
//
// Precedence (A8): env pin > valid DB value > registry default.
//   - scope:'env-only' entries are ALWAYS sourced from their env var (or the
//     registry default when unset) — a server_settings row for one of these
//     keys, however it got there, is never consulted (A2's boundary: env-
//     only configuration must be resolvable before the DB is even reachable,
//     so making it DB-overridable would defeat the whole point).
//   - scope:'ui' entries with no envVar resolve DB-value-else-default.
//   - scope:'ui' entries WITH an envVar (A8's env-pin) resolve env (if set
//     and schema-valid) else DB (if present and schema-valid) else default.
//     A set-but-invalid env pin does NOT throw and does NOT lock the setting
//     (A4's "never a crash" discipline extends to env pins) — it is reported
//     as a notice and resolution falls through to DB-or-default instead.
//
// "locked" (A8: "the setting is locked ... the DB value is preserved but
// inert") is true only when an env pin is ACTIVELY governing a scope:'ui'
// entry's effective value — never true for scope:'env-only' entries (those
// have no DB value to make inert in the first place) and never true when
// the env var is unset or its value failed schema validation.

import { z } from "zod";
import { stableStringify } from "./stable-stringify.js";
import type { SettingsRegistryEntry, SettingsTier } from "./settings-registry.js";
import { registryDefaultForTier } from "./settings-registry.js";

export type SettingsValueSource = "environment" | "database" | "default";

export interface EffectiveSettingValue<T = unknown> {
  key: string;
  value: T;
  source: SettingsValueSource;
  requiresRestart: boolean;
  scope: SettingsRegistryEntry["scope"];
  envVar: string | undefined;
  /** True iff an env pin is actively overriding a scope:'ui' entry's DB
   *  value right now (A8). */
  locked: boolean;
  /** `entry.envVar` when `locked` is true, else undefined — the "set by
   *  environment, <VAR>" projection text is built from this. */
  lockedBy: string | undefined;
}

export interface SettingsResolutionNotice {
  key: string;
  /** Which input failed validation — 'environment' for a set-but-invalid
   *  env pin, 'database' for a set-but-invalid stored row. */
  source: "environment" | "database";
  reason: string;
}

export interface ResolveEffectiveSettingsOptions {
  /** LOOMBRE_TIER, already resolved by the caller (0/1/2) — this module
   *  never reads process.env itself. Defaults to 0 (the conservative tier)
   *  when omitted, matching resolve-policy.ts's own parseEnvTier default. */
  tier?: SettingsTier;
}

export interface ServerSettingRowLike {
  key: string;
  value: unknown;
}

export interface ResolveEffectiveSettingsResult {
  values: Readonly<Record<string, EffectiveSettingValue>>;
  /** DB rows whose key is not in the registry at all (A4: "unknown rows
   *  REPORTED at boot ... never silently dropped") — the row itself is left
   *  untouched by this pure function; a caller decides what "reported"
   *  means (loud log + admin-notice mechanism, apps/server/src/settings/). */
  unknownDbKeys: readonly string[];
  notices: readonly SettingsResolutionNotice[];
}

function zodErrorReason(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(value)"}: ${issue.message}`).join("; ");
}

/**
 * Resolves every registry entry's effective value against a raw env
 * snapshot and the current server_settings rows. Never throws — an invalid
 * env pin or invalid DB value both fall through to the next-lower-precedence
 * source and are surfaced as a `notices` entry instead (A4's "invalid-at-
 * boot values fall back to default with a loud admin notice, never a
 * crash", generalized here to env pins too).
 */
export function resolveEffectiveSettings(
  registry: readonly SettingsRegistryEntry[],
  envSnapshot: Readonly<Record<string, string | undefined>>,
  dbRows: readonly ServerSettingRowLike[],
  options: ResolveEffectiveSettingsOptions = {},
): ResolveEffectiveSettingsResult {
  const tier = options.tier ?? 0;
  const registryKeys = new Set(registry.map((entry) => entry.key));
  const unknownDbKeys = dbRows.map((row) => row.key).filter((key) => !registryKeys.has(key));
  const dbByKey = new Map(dbRows.map((row) => [row.key, row.value]));
  const notices: SettingsResolutionNotice[] = [];
  const values: Record<string, EffectiveSettingValue> = {};

  for (const entry of registry) {
    const fallbackDefault = registryDefaultForTier(entry, tier);

    // 1. Env pin — every env-only entry always takes this branch (or falls
    //    to the default branch below when unset); a UI entry takes it only
    //    when it declares envVar AND the var is actually set.
    if (entry.envVar !== undefined) {
      const raw = envSnapshot[entry.envVar];
      if (raw !== undefined && raw.trim().length > 0) {
        const preParsed = entry.parseEnv ? entry.parseEnv(raw) : raw;
        if (preParsed !== undefined) {
          const parsed = entry.schema.safeParse(preParsed);
          if (parsed.success) {
            values[entry.key] = {
              key: entry.key,
              value: parsed.data,
              source: "environment",
              requiresRestart: entry.requiresRestart,
              scope: entry.scope,
              envVar: entry.envVar,
              locked: entry.scope === "ui",
              lockedBy: entry.scope === "ui" ? entry.envVar : undefined,
            };
            continue;
          }
          notices.push({ key: entry.key, source: "environment", reason: zodErrorReason(parsed.error) });
        } else {
          notices.push({ key: entry.key, source: "environment", reason: `unparseable value ${JSON.stringify(raw)}` });
        }
      }
    }

    // 2. DB value — only ever consulted for scope:'ui' entries (A2: env-only
    //    configuration is never DB-overridable, regardless of what row may
    //    happen to exist).
    if (entry.scope === "ui" && dbByKey.has(entry.key)) {
      const parsed = entry.schema.safeParse(dbByKey.get(entry.key));
      if (parsed.success) {
        values[entry.key] = {
          key: entry.key,
          value: parsed.data,
          source: "database",
          requiresRestart: entry.requiresRestart,
          scope: entry.scope,
          envVar: entry.envVar,
          locked: false,
          lockedBy: undefined,
        };
        continue;
      }
      notices.push({ key: entry.key, source: "database", reason: zodErrorReason(parsed.error) });
    }

    // 3. Registry default (tier-aware).
    values[entry.key] = {
      key: entry.key,
      value: fallbackDefault,
      source: "default",
      requiresRestart: entry.requiresRestart,
      scope: entry.scope,
      envVar: entry.envVar,
      locked: false,
      lockedBy: undefined,
    };
  }

  return { values, unknownDbKeys, notices };
}

/**
 * A5: "track a boot-time snapshot of each requiresRestart key's effective
 * value; restartPending = keys whose current effective value differs from
 * the boot snapshot." Deep-equality via stableStringify (packages/shared's
 * own key-sorted JSON serializer) so object/array-valued settings (e.g.
 * transcode.ladderRungs) compare correctly regardless of key order.
 */
export function computeRestartPendingKeys(
  registry: readonly SettingsRegistryEntry[],
  bootValues: Readonly<Record<string, unknown>>,
  currentValues: Readonly<Record<string, EffectiveSettingValue>>,
): string[] {
  const pending: string[] = [];
  for (const entry of registry) {
    if (!entry.requiresRestart) continue;
    const bootValue = bootValues[entry.key];
    const currentValue = currentValues[entry.key]?.value;
    if (stableStringify(bootValue) !== stableStringify(currentValue)) {
      pending.push(entry.key);
    }
  }
  return pending;
}

/** Convenience snapshot helper — every requiresRestart key's CURRENT
 *  effective value, keyed by settings key (what onApplicationBootstrap
 *  should capture immediately after the first resolveEffectiveSettings
 *  call, before it can ever change). */
export function snapshotRestartSensitiveValues(
  registry: readonly SettingsRegistryEntry[],
  currentValues: Readonly<Record<string, EffectiveSettingValue>>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of registry) {
    if (!entry.requiresRestart) continue;
    snapshot[entry.key] = currentValues[entry.key]?.value;
  }
  return snapshot;
}
