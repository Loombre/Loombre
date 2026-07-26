// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-keyring.ts
//
// LD1/LD9 keyring naming, on top of the EXISTING packages/secrets
// generate/resolve/store/remove façade — mirrors
// apps/server/src/settings/provider-keys.service.ts's own
// secretKeyFor()/resolveBackend() shape exactly (that file's header
// explains why the `${dataDir}/secrets/<stable-name>` path form is
// required: file0600, packages/secrets's universal fallback backend,
// treats its `key` argument as a literal filesystem path, so the
// LOGICAL name LD1 specifies — `plugin-hmac-<pluginId>` /
// `plugin-<pluginId>-<fieldName>` — is embedded as the path's last
// segment, never used bare).
//
// Two secret KINDS, two different lifecycles (LD1):
//   - The delivery-signing HMAC (`plugin-hmac-<pluginId>`): minted ONCE at
//     registration (mintPluginHmac), re-mintable (rotatePluginHmac —
//     genuinely fresh randomness each time, NOT packages/secrets'
//     idempotent generate()), returned to the caller by VALUE exactly once
//     per mint/rotation and never re-read afterward by this module (there
//     is deliberately no `resolvePluginHmac` export — LD1: "NOT
//     re-injected per request").
//   - Per-field CONFIG secrets (`plugin-<pluginId>-<fieldName>`): written
//     at registration/config-update time, RESOLVED per outbound call by
//     W3/W4's capability integrations (resolvePluginConfigSecret), removed
//     when a plugin is removed or a secret field is cleared.

import { detectSecretBackend, removeSecret, storeSecret, tryResolveSecret } from "@loombre/secrets";
import { generateLppSigningSecret } from "@loombre/plugin-protocol";
import type { SecretBackend } from "@loombre/provisioning";
import { resolveAppPaths } from "../cli/app-paths.js";

async function resolveBackend(): Promise<SecretBackend> {
  const detected = await detectSecretBackend();
  return detected.backend;
}

/** file0600-compatible absolute path for a logical keyring name — see this
 *  file's header. Exported so tests (LD9's "distinctive-value" scans) can
 *  independently locate a plugin's keyring entries on disk without
 *  duplicating this construction. */
export function pluginSecretStorePath(logicalName: string): string {
  const { dataDir } = resolveAppPaths(process.platform, process.env);
  return `${dataDir}/secrets/${logicalName}`;
}

export function pluginHmacLogicalName(pluginId: string): string {
  return `plugin-hmac-${pluginId}`;
}

export function pluginConfigSecretLogicalName(pluginId: string, fieldName: string): string {
  return `plugin-${pluginId}-${fieldName}`;
}

/** Mints the delivery-signing HMAC for a NEWLY registering plugin (LD1).
 *  Returns the plaintext value — the ONLY time this module ever hands it
 *  back; callers must surface it to the admin immediately and never log
 *  or persist it themselves. */
export async function mintPluginHmac(pluginId: string): Promise<string> {
  const backend = await resolveBackend();
  const secret = generateLppSigningSecret();
  await storeSecret(backend, pluginSecretStorePath(pluginHmacLogicalName(pluginId)), secret);
  return secret;
}

/** Re-mints (LD1 "rotatable via a service method (re-mint + return once)")
 *  — always genuinely fresh randomness, overwriting whatever was stored
 *  before. Returns the new plaintext value exactly once. */
export async function rotatePluginHmac(pluginId: string): Promise<string> {
  return mintPluginHmac(pluginId);
}

export async function removePluginHmac(pluginId: string): Promise<void> {
  const backend = await resolveBackend();
  await removeSecret({ backend, key: pluginSecretStorePath(pluginHmacLogicalName(pluginId)) });
}

export async function storePluginConfigSecret(pluginId: string, fieldName: string, value: string): Promise<void> {
  const backend = await resolveBackend();
  await storeSecret(backend, pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, fieldName)), value);
}

/** Per-request resolution (LD1 — config secrets ARE re-injected per call,
 *  unlike the HMAC) — W3/W4's callPlugin wrappers call this to build
 *  X-LPP-Secret-* headers (packages/plugin-host's buildPluginRequestHeaders). */
export async function resolvePluginConfigSecret(pluginId: string, fieldName: string): Promise<string | null> {
  const backend = await resolveBackend();
  return tryResolveSecret({ backend, key: pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, fieldName)) });
}

export async function removePluginConfigSecret(pluginId: string, fieldName: string): Promise<void> {
  const backend = await resolveBackend();
  await removeSecret({ backend, key: pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, fieldName)) });
}

/** Resolves every named secret config field for a plugin in one call
 *  (W3/W4's convenience entry point) — a field with nothing stored is
 *  simply omitted from the result rather than erroring, so a plugin
 *  registered before a NEW optional secret field existed doesn't break
 *  every subsequent call. */
export async function resolveAllPluginConfigSecrets(
  pluginId: string,
  secretFieldNames: readonly string[],
): Promise<Record<string, string>> {
  const backend = await resolveBackend();
  const out: Record<string, string> = {};
  for (const fieldName of secretFieldNames) {
    const value = await tryResolveSecret({ backend, key: pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, fieldName)) });
    if (value !== null) out[fieldName] = value;
  }
  return out;
}

/** Removes every keyring entry a plugin owns — the HMAC and every secret
 *  field named in `secretFieldNames` — called by the lifecycle service
 *  alongside removePluginAndEmit (LD9: nothing keyring-side survives a
 *  plugin's removal). Best-effort per entry (packages/secrets'
 *  removeSecret never throws on "nothing to delete" — see that package's
 *  SecretBackendImpl.remove doc comment). */
export async function removeAllPluginSecrets(pluginId: string, secretFieldNames: readonly string[]): Promise<void> {
  await removePluginHmac(pluginId);
  for (const fieldName of secretFieldNames) {
    await removePluginConfigSecret(pluginId, fieldName);
  }
}
