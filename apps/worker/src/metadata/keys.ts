// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/keys.ts
//
// API-key resolution (P1.9): LOOMBRE_TMDB_API_KEY / LOOMBRE_TVDB_API_KEY.
// Absent key => the provider still constructs, reports enabled:false with a
// human-readable reason, and NOTHING crashes (docs/PLAN.md §4.4 extension
// points must degrade gracefully — a missing key is an admin-notice, not a
// startup failure).

import { detectSecretBackend, tryResolveSecret } from '@loombre/secrets';

export type KeyResolution = { enabled: true; apiKey: string } | { enabled: false; reason: string };

export function resolveApiKey(envVarName: string, env: NodeJS.ProcessEnv = process.env): KeyResolution {
  const value = env[envVarName];
  if (!value || value.trim().length === 0) {
    return { enabled: false, reason: `${envVarName} is not set` };
  }
  return { enabled: true, apiKey: value };
}

/**
 * Mirrors apps/server/src/cli/app-paths.ts's resolveAppPaths dataDir half
 * EXACTLY — documented duplication, same precedent as settings.service.ts's
 * resolveTier (apps/worker cannot import from apps/server, and both
 * processes MUST derive the same keyring identifier or a UI-saved key would
 * silently never be found here). Installed deployments set LOOMBRE_DATA_DIR
 * for both units (provisioning contract), so the platform-default branch
 * only matters for bare dev setups.
 *
 * Exported (LPP v1, Lane W3) so apps/worker/src/metadata/plugin-keyring.ts
 * can reuse this SAME dataDir derivation for `plugin-<pluginId>-<field>`
 * keyring reads (apps/server/src/plugins/plugin-keyring.ts's
 * pluginSecretStorePath counterpart) rather than a second private copy of
 * this platform-path logic — the "mirrorServerDataDir pattern" the LPP
 * mission text names as this file's precedent is reused directly, not
 * re-duplicated a third time.
 */
export function mirrorServerDataDir(env: NodeJS.ProcessEnv): string {
  const override = env['LOOMBRE_DATA_DIR']?.trim();
  if (override && override.length > 0) return override;
  if (process.platform === 'win32') {
    const home = env['USERPROFILE'] ?? env['HOME'] ?? 'C:\\Users\\Default';
    const base = env['LOCALAPPDATA'] ?? [home, 'AppData', 'Local'].join('\\').replace(/\\+/g, '\\');
    return [base, 'Loombre'].join('\\').replace(/\\+/g, '\\');
  }
  const home = env['HOME'] ?? '/root';
  if (process.platform === 'darwin') {
    return [home, 'Library', 'Application Support', 'Loombre'].join('/').replace(/\/+/g, '/');
  }
  const xdg = env['XDG_DATA_HOME'] ?? [home, '.local', 'share'].join('/').replace(/\/+/g, '/');
  return [xdg, 'loombre'].join('/').replace(/\/+/g, '/');
}

/**
 * A9 exit-gate seam ("keyed scan works end-to-end from a UI-entered key"):
 * env var wins per A8; otherwise the keyring entry the server's
 * ProviderKeysService wrote (`<dataDir>/secrets/provider-key-<provider>`,
 * JSON envelope {value, setAtMs} — AD4) is consulted through the exact
 * same @loombre/secrets backend detection. Resolved once at worker boot
 * (apps/worker/src/index.ts) — a key saved in the admin settings screen is
 * used from the next worker restart; env keys keep working unchanged. The
 * key value is never logged and never appears in a reason string. Any
 * keyring failure (backend unavailable, malformed envelope) degrades to
 * the same disabled-with-reason posture as a missing env var — P1.9's
 * "a missing key is an admin-notice, not a startup failure" holds.
 */
export async function resolveApiKeyWithKeyring(
  envVarName: string,
  provider: 'tmdb' | 'tvdb',
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeyResolution> {
  const fromEnv = resolveApiKey(envVarName, env);
  if (fromEnv.enabled) return fromEnv;
  try {
    const detected = await detectSecretBackend();
    const key = `${mirrorServerDataDir(env)}/secrets/provider-key-${provider}`;
    const raw = await tryResolveSecret({ backend: detected.backend, key });
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { value?: unknown }).value === 'string' &&
        ((parsed as { value: string }).value.trim().length > 0)
      ) {
        return { enabled: true, apiKey: (parsed as { value: string }).value };
      }
    }
  } catch {
    // fall through — keyring unavailability is never a worker crash
  }
  return {
    enabled: false,
    reason: `${envVarName} is not set and no key has been saved from the admin settings screen`,
  };
}
