// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/test-support/fake-settings-service.ts
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): a
// SettingsService-SHAPED test double for unit tests that need to inject a
// SettingsService but must not pay for a live Postgres connection —
// apps/server/src/settings/settings.service.ts's own bootstrap() genuinely
// reads server_settings (frozen for this lane, see that file's header), so
// a REAL instance needs a database. Every consumer this lane migrated only
// ever calls `.getEffective(key)` / `.getAllEffective()` / `.onChange(fn)`
// on the injected service — never `.bootstrap()`/`.reload()`/
// `.updateSetting()` — so faking exactly those three methods is sufficient
// for every unit test in this lane, while still resolving values through
// the SAME pure `resolveEffectiveSettings` every real code path uses
// (packages/shared/src/settings-resolve.ts) rather than a hand-rolled
// stand-in precedence rule that could silently drift from production.
//
// Cast through `unknown` on return: SettingsService declares private
// fields (`resolution`/`bootSnapshot`/`listeners`), which makes it
// NOMINALLY typed in TypeScript — a plain object satisfying only its
// public method shape cannot be assigned to that type without the cast.
// Same pattern this package's specs already use for other frozen-shape
// fakes (e.g. rate-limit.guard.spec.ts's `as unknown as ExecutionContext`).

import {
  SETTINGS_REGISTRY,
  resolveEffectiveSettings,
  type EffectiveSettingValue,
  type ServerSettingRowLike,
  type SettingsTier,
} from "@loombre/shared";
import type { SettingsChangedEvent, SettingsChangeListener, SettingsService } from "../../settings/settings.service.js";

export interface FakeSettingsServiceInit {
  /** Defaults to `process.env` — pass an explicit object to isolate a test
   *  from the real process environment entirely. */
  env?: Record<string, string | undefined>;
  dbRows?: readonly ServerSettingRowLike[];
  tier?: SettingsTier;
}

export interface FakeSettingsServiceHandle {
  /** Pass this to any constructor typed `SettingsService`. */
  service: SettingsService;
  /** Test-only hot-reload simulation: overwrites one key's DB-row value,
   *  re-resolves every entry through the same pure resolver, and fires
   *  every listener registered via `service.onChange()` — mirrors what
   *  SettingsService.updateSetting() does for real (write + reload +
   *  emitChange) without a database, so a consumer's onChange subscription
   *  can be exercised in a plain unit test. */
  setDbValue(key: string, value: unknown, actorUserId?: string): void;
}

export function createFakeSettingsService(init: FakeSettingsServiceInit = {}): FakeSettingsServiceHandle {
  const env = init.env ?? process.env;
  const tier = init.tier ?? 0;
  let dbRows: ServerSettingRowLike[] = init.dbRows ? [...init.dbRows] : [];
  let values: Readonly<Record<string, EffectiveSettingValue>> = resolveEffectiveSettings(
    SETTINGS_REGISTRY,
    env,
    dbRows,
    { tier },
  ).values;
  const listeners = new Set<SettingsChangeListener>();

  const fakeService = {
    getEffective(key: string): EffectiveSettingValue | undefined {
      return values[key];
    },
    getAllEffective(): Readonly<Record<string, EffectiveSettingValue>> {
      return values;
    },
    onChange(listener: SettingsChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    service: fakeService as unknown as SettingsService,
    setDbValue(key: string, value: unknown, actorUserId = "test-admin-id"): void {
      const oldValue = values[key]?.value;
      dbRows = [...dbRows.filter((row) => row.key !== key), { key, value }];
      values = resolveEffectiveSettings(SETTINGS_REGISTRY, env, dbRows, { tier }).values;
      const event: SettingsChangedEvent = { key, oldValue, newValue: value, actorUserId, nowMs: Date.now() };
      for (const listener of listeners) listener(event);
    },
  };
}
