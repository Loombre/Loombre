// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/headers.ts
//
// LD2 "header/secret injection composition (spec base64 codecs)": a thin
// composition layer over packages/plugin-protocol's frozen header codecs
// (headers.ts there) — this module owns no encoding logic of its own,
// only the "build the full header set for one outbound call" assembly a
// caller (callPlugin.ts, and eventually W3/W4's capability integrations)
// needs every time. Per-request injection (LD1/spec §3): config/secrets
// are resolved by the CALLER (apps/server/src/plugins, which alone has
// keyring access) and passed in already-decrypted; this module never
// touches the keyring itself.

import {
  LPP_CONFIG_HEADER,
  encodeLppConfigHeaderValue,
  encodeLppSecretHeaderValue,
  lppSecretHeaderName,
} from "@loombre/plugin-protocol";

/**
 * Builds the `X-LPP-Config` + one `X-LPP-Secret-<NAME>` per secret field
 * header set for one outbound plugin call (spec §3). `config` is every
 * NON-secret configSchema field value; `secrets` maps a secret field's OWN
 * configSchema property key to its plaintext value (already resolved from
 * the keyring by the caller — LD1: secret config fields are per-request
 * injected, never re-derived here).
 */
export function buildPluginRequestHeaders(
  config: Record<string, unknown>,
  secrets: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [LPP_CONFIG_HEADER]: encodeLppConfigHeaderValue(config),
  };
  for (const [fieldKey, value] of Object.entries(secrets)) {
    headers[lppSecretHeaderName(fieldKey)] = encodeLppSecretHeaderValue(value);
  }
  return headers;
}
