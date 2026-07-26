// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/keyring.ts
//
// LPP v1, Lane W4 — worker-side, READ-ONLY resolution of a plugin's
// delivery-signing HMAC secret (LD1/LD9). Mirrors
// apps/worker/src/metadata/plugin-keyring.ts's shape exactly (that file's
// own header: "worker reads what the server wrote; worker never writes
// back" — the SAME asymmetry apps/worker/src/metadata/keys.ts establishes
// for provider API keys), adapted to the ONE secret this lane needs
// instead of per-field config secrets.
//
// Keyring naming (LD9): `plugin-hmac-<pluginId>`, stored at
// `${dataDir}/secrets/plugin-hmac-<pluginId>` — matches
// apps/server/src/plugins/plugin-keyring.ts's `pluginHmacLogicalName` +
// `pluginSecretStorePath` exactly (that file is the WRITER: mintPluginHmac/
// rotatePluginHmac). Stored as the RAW PLAINTEXT secret string (that
// file's `storeSecret(backend, path, secret)` call, `secret =
// generateLppSigningSecret()` — no JSON envelope, unlike keys.ts's
// provider-key `{value, setAtMs}` convention, which is specific to AD4's
// provider-key surface and does not apply here) — this module reads it
// back the same way, no JSON.parse.
//
// `mirrorServerDataDir` is imported from ./keys.js (apps/worker/src/
// metadata/keys.ts, off-limits to EDIT per this lane's scope but its
// exports are fair game to import, same as apps/worker/src/metadata/
// plugin-keyring.ts already does) rather than re-derived here — the two
// processes (server/worker) must agree on where a plugin's secrets live,
// and that file's own header explains why it mirrors apps/server/src/
// cli/app-paths.ts's resolveAppPaths dataDir half exactly.
//
// Never throws: any keyring failure (backend unavailable, nothing stored
// for this plugin) degrades to `null` — the delivery loop treats that as
// a non-breaker delivery failure for that tick (nothing to sign with),
// matching P1.9/C6's "a missing key is never a worker crash" posture.

import { detectSecretBackend, tryResolveSecret } from "@loombre/secrets";
import { mirrorServerDataDir } from "../metadata/keys.js";

function pluginHmacLogicalName(pluginId: string): string {
  return `plugin-hmac-${pluginId}`;
}

/** Exported for keyring.spec.ts — proves this lane's tests write the
 *  secret at the EXACT path this resolver reads, the same tripwire shape
 *  apps/worker/test/metadata/keyring-keys.spec.ts uses for the
 *  provider-key seam. */
export function pluginHmacKeyPath(pluginId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${mirrorServerDataDir(env)}/secrets/${pluginHmacLogicalName(pluginId)}`;
}

/**
 * Resolves plugin `pluginId`'s delivery-signing HMAC secret from the
 * keyring. Returns null (never throws) on ANY failure — backend
 * unavailable, no entry at that key. Bare plaintext, no JSON envelope
 * (see file header).
 */
export async function resolvePluginHmacSecret(pluginId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const detected = await detectSecretBackend();
    const raw = await tryResolveSecret({ backend: detected.backend, key: pluginHmacKeyPath(pluginId, env) });
    if (raw === null || raw.trim().length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}
