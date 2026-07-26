// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/plugin-keyring.ts
//
// LPP v1 (Lane W3): worker-side, READ-ONLY resolution of a plugin's
// `secret: true` configSchema field values (LD1/LD9) — the metadata-
// provider capability's per-request config-secret injection happens here,
// at CALL TIME (never at adapter-construction time), mirroring
// apps/server/src/plugins/plugin-keyring.ts's resolvePluginConfigSecret /
// resolveAllPluginConfigSecrets shape exactly, but only the READ half:
// this file never mints, rotates, stores, or removes anything — only the
// server's registration/lifecycle services (the only keyring WRITERS for
// plugin secrets) do that. Same asymmetry apps/worker/src/metadata/keys.ts
// already establishes for provider API keys (worker reads what the server
// wrote; worker never writes back).
//
// Keyring naming (LD9, unchanged): `plugin-<pluginId>-<fieldName>`, stored
// at `${dataDir}/secrets/plugin-<pluginId>-<fieldName>` (file0600's literal-
// path convention — see plugin-keyring.ts's header for why the logical name
// is embedded as the path's last segment). dataDir is derived via
// keys.ts's exported mirrorServerDataDir — the SAME derivation
// apps/server/src/cli/app-paths.ts's resolveAppPaths uses server-side, so
// both processes agree on where a plugin's secrets live.
//
// Unlike keys.ts's provider-key envelope ({value, setAtMs}, AD4-specific),
// a plugin config secret is stored as the RAW plaintext string
// (apps/server/src/plugins/plugin-keyring.ts's storePluginConfigSecret
// passes `value: string` straight to packages/secrets' storeSecret with no
// JSON wrapping) — this module reads it back the same way, no JSON.parse.
//
// Never throws: any keyring failure (backend unavailable, nothing stored
// for a field) degrades to that field being ABSENT from the result map —
// the caller (plugin-provider.ts) then simply omits the corresponding
// X-LPP-Secret-<NAME> header, and a plugin that required it responds with
// its own error, handled as an ordinary typed provider-call failure (never
// a worker crash — P1.9/C6's "a missing key is an admin-notice, not a
// startup failure" posture, applied here to plugin secrets).

import { detectSecretBackend, tryResolveSecret } from '@loombre/secrets';
import { mirrorServerDataDir } from './keys.js';

function pluginConfigSecretPath(env: NodeJS.ProcessEnv, pluginId: string, fieldName: string): string {
  return `${mirrorServerDataDir(env)}/secrets/plugin-${pluginId}-${fieldName}`;
}

/**
 * Resolves every named secret configSchema field for one plugin, keyed by
 * field name — a field with nothing stored (never configured, or the
 * keyring backend is unavailable) is simply omitted, never an error entry.
 * `secretFieldNames` normally comes from
 * `@loombre/plugin-protocol`'s `listTopLevelSecretFieldNames(configSchema)`
 * against the plugin's own manifest snapshot.
 */
export async function resolvePluginConfigSecrets(
  pluginId: string,
  secretFieldNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (secretFieldNames.length === 0) return out;

  let backend;
  try {
    // Mirrors keys.ts's resolveApiKeyWithKeyring: backend detection reads
    // the real process.env (LOOMBRE_SECRET_BACKEND override), independent
    // of the `env` parameter used for dataDir derivation below — the two
    // are deliberately different inputs, same as that file's own call.
    backend = (await detectSecretBackend()).backend;
  } catch {
    // Keyring backend detection itself failed — degrade to "no secrets
    // resolved", never a worker crash (see file header).
    return out;
  }

  for (const fieldName of secretFieldNames) {
    try {
      const raw = await tryResolveSecret({ backend, key: pluginConfigSecretPath(env, pluginId, fieldName) });
      if (raw !== null && raw.length > 0) out[fieldName] = raw;
    } catch {
      // One field's keyring read failing must not take the others down
      // with it — skip just this field.
    }
  }
  return out;
}
