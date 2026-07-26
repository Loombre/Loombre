// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/keyring-keys.spec.ts
//
// Addendum A / A9 exit-gate seam ("keyed scan works end-to-end from a
// UI-entered key"): proves the WORKER-side resolveApiKeyWithKeyring picks
// up a key written exactly the way the SERVER's ProviderKeysService writes
// it (same backend detection, same `<dataDir>/secrets/provider-key-
// <provider>` identifier, same {value, setAtMs} JSON envelope — AD4), and
// that A8 env precedence + P1.9 graceful degradation both hold. Uses the
// file0600 backend under a throwaway LOOMBRE_DATA_DIR (the established
// convention from apps/server/test/admin-settings.e2e.spec.ts) so no real
// OS credential store is touched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectSecretBackend, storeSecret } from '@loombre/secrets';
import { resolveApiKeyWithKeyring } from '../../src/metadata/keys.js';

const KEY_VALUE = 'ui-entered-tmdb-key-8b1f';

let dataDir: string;
const ORIGINAL_BACKEND = process.env['LOOMBRE_SECRET_BACKEND'];

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOOMBRE_DATA_DIR: dataDir,
    LOOMBRE_TMDB_API_KEY: undefined,
    LOOMBRE_TVDB_API_KEY: undefined,
    ...overrides,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'loombre-keyring-keys-test-'));
  process.env['LOOMBRE_SECRET_BACKEND'] = 'file0600';

  // Write the envelope EXACTLY as apps/server/src/settings/provider-keys.
  // service.ts does: storeSecret at `<dataDir>/secrets/provider-key-tmdb`
  // with the AD4 JSON envelope. If the server-side derivation ever drifts
  // from the worker's mirror, this test is the tripwire.
  const detected = await detectSecretBackend();
  await storeSecret(
    detected.backend,
    `${dataDir}/secrets/provider-key-tmdb`,
    JSON.stringify({ value: KEY_VALUE, setAtMs: 1_784_900_000_000 }),
  );
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_BACKEND === undefined) delete process.env['LOOMBRE_SECRET_BACKEND'];
  else process.env['LOOMBRE_SECRET_BACKEND'] = ORIGINAL_BACKEND;
});

describe('resolveApiKeyWithKeyring (A9 worker seam)', () => {
  it('resolves a keyring-stored key when the env var is unset', async () => {
    const result = await resolveApiKeyWithKeyring('LOOMBRE_TMDB_API_KEY', 'tmdb', envFor());
    expect(result).toEqual({ enabled: true, apiKey: KEY_VALUE });
  });

  it('env var WINS over a present keyring key (A8 precedence)', async () => {
    const result = await resolveApiKeyWithKeyring(
      'LOOMBRE_TMDB_API_KEY',
      'tmdb',
      envFor({ LOOMBRE_TMDB_API_KEY: 'env-key-wins' }),
    );
    expect(result).toEqual({ enabled: true, apiKey: 'env-key-wins' });
  });

  it('absent everywhere -> disabled, reason names BOTH seams, never the value', async () => {
    const result = await resolveApiKeyWithKeyring('LOOMBRE_TVDB_API_KEY', 'tvdb', envFor());
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toContain('LOOMBRE_TVDB_API_KEY');
      expect(result.reason).toContain('admin settings screen');
      expect(result.reason).not.toContain(KEY_VALUE);
    }
  });

  it('a malformed keyring envelope degrades to disabled — never a crash (P1.9)', async () => {
    const secretsDir = path.join(dataDir, 'secrets');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(path.join(secretsDir, 'provider-key-tvdb'), 'not json at all', { mode: 0o600 });
    const result = await resolveApiKeyWithKeyring('LOOMBRE_TVDB_API_KEY', 'tvdb', envFor());
    expect(result.enabled).toBe(false);
  });
});
