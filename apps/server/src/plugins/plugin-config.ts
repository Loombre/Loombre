// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-config.ts
//
// LD6: "config validated against manifest configSchema (server-side ajv —
// already a server dependency; secret fields string-only per the frozen
// spec) -> non-secret config to plugins.config, secret fields to keyring".
// `configSchema` is itself a JSON Schema document (LPP §3's restricted
// subset — packages/plugin-protocol's LppConfig), so it can be handed
// straight to Ajv as a schema to validate the submitted values object
// against — mirrors apps/server/src/common/device-profile-validator.ts's
// `{ Ajv }` named-import convention exactly (that file's header explains
// why the named import, not the default one, is required under this
// repo's NodeNext + esModuleInterop setup).
//
// Compiled PER CALL, not once at construction: unlike DeviceProfileValidatorService's
// single fixed schema, every plugin has its OWN configSchema — this only
// runs on the admin registration/re-fetch/config-update path (never a
// per-request hot path), so CLAUDE.md invariant 9's Tier-0 rule does not
// apply here (same posture packages/db's own admin-surface writes take).

import { Ajv } from "ajv";
import { listTopLevelSecretFieldNames, type LppConfig } from "@loombre/plugin-protocol";

export interface PluginConfigValidationOk {
  ok: true;
  /** Non-secret configSchema field values only — goes to plugins.config (LD1). */
  nonSecret: Record<string, unknown>;
  /** Secret ('secret: true') field values only, keyed by their OWN
   *  configSchema property name — goes to the keyring, one entry per
   *  field, never to plugins.config (LD1). */
  secrets: Record<string, string>;
}

export interface PluginConfigValidationFailure {
  ok: false;
  errors: string;
}

export type PluginConfigValidationResult = PluginConfigValidationOk | PluginConfigValidationFailure;

/**
 * Validates `values` (a plain object of configSchema property name -> raw
 * submitted value) against a plugin's manifest-declared `configSchema`,
 * then splits it into the non-secret/secret halves LD1's storage split
 * needs. Ajv validates the WHOLE object at once (so `required`/
 * `additionalProperties: false` at the schema root are enforced exactly as
 * the plugin author declared them) — the secret/non-secret split below
 * only runs after validation succeeds, so a caller never receives a
 * partially-split result for invalid input.
 */
export function validatePluginConfig(configSchema: LppConfig, values: Record<string, unknown>): PluginConfigValidationResult {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(configSchema);
  const valid = validate(values);
  if (!valid) {
    return { ok: false, errors: ajv.errorsText(validate.errors) };
  }

  const secretFieldNames = new Set(listTopLevelSecretFieldNames(configSchema));
  const nonSecret: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (secretFieldNames.has(key)) {
      // LppConfigSchema (json-schema-subset.ts) only ever allows
      // `secret: true` on a `type: "string"` leaf — Ajv validation above
      // already guarantees `value` is a string for this key.
      secrets[key] = String(value);
    } else {
      nonSecret[key] = value;
    }
  }

  return { ok: true, nonSecret, secrets };
}
