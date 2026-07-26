// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/settings/effective-settings.ts
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): apps/worker
// has no NestJS, so it has no apps/server/src/settings/settings.service.ts
// equivalent (no long-lived per-request cache, no in-process hot-reload
// emitter). Instead, this module is a thin, honest re-resolution helper —
// load the current server_settings rows via @loombre/db's PUBLIC barrel
// (never @loombre/db/internal for this: settings reads are instance facts,
// not viewer-scoped catalog data, matching packages/db/src/query/
// settings.ts's own header) + resolveEffectiveSettings(registry, env, rows)
// from @loombre/shared — the SAME pure precedence rule (env-pin > DB >
// default, A8) apps/server's SettingsService uses, just called fresh at
// whatever NATURAL BOUNDARY each call site chooses (job start / scan start
// / per transcode admission / sweeper tick — see each consumer's own
// header for which boundary it picked and why). No polling loop of its
// own: a boundary that never recurs (e.g. a worker that never gets another
// scan job) simply never re-resolves, which is correct — there is nothing
// to apply a new value TO until the next unit of work begins.

import { cpus } from "node:os";
import { listServerSettings } from "@loombre/db";
import type { DbOrTx } from "@loombre/db/internal";
import {
  SETTINGS_REGISTRY,
  resolveEffectiveSettings,
  type EffectiveSettingValue,
  type ResolveEffectiveSettingsResult,
  type SettingsTier,
} from "@loombre/shared";

/** Mirrors apps/server/src/settings/settings.service.ts's own
 *  `resolveTier` exactly (LOOMBRE_TIER, 0/1/2) — duplicated deliberately
 *  rather than imported, same reasoning that file's own header gives for
 *  not cross-importing playback/resolve-policy.ts's identical
 *  `parseEnvTier`: three lines, no other reason for a cross-package dep. */
function resolveTier(env: NodeJS.ProcessEnv): SettingsTier {
  const raw = env["LOOMBRE_TIER"];
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return 0;
}

/**
 * Loads server_settings + resolves every registry entry's effective value
 * against the current env snapshot. Never throws on a bad row/env pin (the
 * pure resolver's own "never a crash" discipline, A4) — unknown rows and
 * validation notices are logged loudly (ADMIN NOTICE), same convention as
 * the server-side service's boot log, so an operator running worker-only
 * logs still sees them.
 */
export async function loadWorkerEffectiveSettings(
  db: DbOrTx,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolveEffectiveSettingsResult> {
  const rows = await listServerSettings(db);
  const tier = resolveTier(env);
  const result = resolveEffectiveSettings(
    SETTINGS_REGISTRY,
    env,
    rows.map((row) => ({ key: row.key, value: row.value })),
    { tier },
  );

  for (const key of result.unknownDbKeys) {
    console.warn(
      `@loombre/worker settings: server_settings row "${key}" does not match any registered setting — preserved untouched, never applied. ADMIN NOTICE.`,
    );
  }
  for (const notice of result.notices) {
    console.warn(
      `@loombre/worker settings: invalid ${notice.source} value for "${notice.key}" (${notice.reason}) — falling back to the next-lower-precedence source, never crashing. ADMIN NOTICE.`,
    );
  }

  return result;
}

/** Typed convenience accessor — `fallback` is defensive-only (every
 *  registry entry always resolves to SOME value, env/DB/default, so this
 *  only matters for a typo'd key). */
export function getWorkerSettingValue<T>(result: ResolveEffectiveSettingsResult, key: string, fallback: T): T {
  const effective = result.values[key] as EffectiveSettingValue<T> | undefined;
  return effective !== undefined ? effective.value : fallback;
}

/**
 * scanner.concurrency's registry `default` (packages/shared/src/
 * settings-registry.ts) is a static, conservative literal (2) — but this
 * setting's REAL historical unset-env-and-no-DB-row fallback is CPU-derived
 * (`max(2, cpus/2)`, apps/worker/src/scan/concurrency.ts's original
 * `resolveScanConcurrency` formula), and the registry entry's own comment
 * documents this exact divergence ("this registry default is the
 * documented floor of that formula ... see this lane's report"). To keep
 * Addendum A's behavior invariant EXACT ("no server_settings rows and no
 * env pins -> byte-identical to today"), this function overrides the
 * static registry default with the CPU-derived value whenever the
 * resolution's `source` is `'default'` — an env pin (LOOMBRE_SCAN_CONCURRENCY)
 * or a DB row both flow through completely unchanged, identical to every
 * other setting (this is the ONLY registry entry needing this treatment;
 * see this lane's final report for why a static registry `default` field
 * cannot itself express a host-derived formula).
 */
export function resolveScanConcurrencyFromEffective(result: ResolveEffectiveSettingsResult): number {
  const effective = result.values["scanner.concurrency"];
  if (effective && effective.source !== "default") {
    return effective.value as number;
  }
  const cpuCount = cpus().length || 1;
  return Math.max(2, Math.floor(cpuCount / 2));
}
