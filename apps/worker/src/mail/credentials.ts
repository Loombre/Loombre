// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/credentials.ts
//
// Optional mail transport run (E5/E6, M8/M10): SMTP username/password
// resolution for the 'mail-send' job consumer. Mirrors apps/worker/src/
// metadata/keys.ts's resolveApiKeyWithKeyring SHAPE exactly (env-first,
// else the keyring entry the server's admin settings screen wrote, same
// graceful degradation on any keyring failure) — but resolved fresh AT JOB
// START (consumer.ts calls this once per 'mail-send' job), never once at
// worker boot, matching apps/worker/src/image/consumer.ts's per-job
// effective-settings re-resolution convention (that module's own header).
// A credentials change from the admin settings screen therefore applies to
// the NEXT mail-send job with no worker restart.
//
// M8: credentials are OPTIONAL overall — unauthenticated SMTP (a private-
// network relay) is a fully legal configuration. Unlike resolveApiKey's
// KeyResolution (where `enabled: false` disables an entire metadata
// provider), `enabled: false` here means "connect without SMTP AUTH", not
// "mail is unavailable" — transport.ts's caller decides that meaning, this
// module only resolves the pair (or the absence of one).
//
// Double-nested envelope (mirrors apps/server/src/settings/
// mail-credentials.service.ts's write side exactly): the OUTER keyring
// envelope is `{value, setAtMs}` (AD4), and `value` is itself a JSON
// string of `{username, password}` — never a bare credential string.

import { detectSecretBackend, tryResolveSecret } from '@loombre/secrets';
import { mirrorServerDataDir } from '../metadata/keys.js';

const SMTP_USERNAME_ENV_VAR = 'LOOMBRE_SMTP_USERNAME';
const SMTP_PASSWORD_ENV_VAR = 'LOOMBRE_SMTP_PASSWORD';

export type MailCredentialsResolution =
  | { enabled: true; username: string; password: string }
  | { enabled: false; reason: string };

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Mirrors provider-keys.service.ts/mail-credentials.service.ts's secret
 *  key naming exactly — `<dataDir>/secrets/mail-smtp-credentials`. */
function secretKeyFor(env: NodeJS.ProcessEnv): string {
  return `${mirrorServerDataDir(env)}/secrets/mail-smtp-credentials`;
}

export async function resolveMailCredentials(env: NodeJS.ProcessEnv = process.env): Promise<MailCredentialsResolution> {
  const envUsername = env[SMTP_USERNAME_ENV_VAR];
  const envPassword = env[SMTP_PASSWORD_ENV_VAR];
  if (isNonEmpty(envUsername) && isNonEmpty(envPassword)) {
    return { enabled: true, username: envUsername, password: envPassword };
  }

  try {
    const detected = await detectSecretBackend();
    const raw = await tryResolveSecret({ backend: detected.backend, key: secretKeyFor(env) });
    if (raw !== null) {
      const envelope: unknown = JSON.parse(raw);
      const envelopeValue =
        typeof envelope === 'object' && envelope !== null && typeof (envelope as { value?: unknown }).value === 'string'
          ? (envelope as { value: string }).value
          : null;
      if (envelopeValue !== null) {
        const inner: unknown = JSON.parse(envelopeValue);
        if (
          typeof inner === 'object' &&
          inner !== null &&
          isNonEmpty((inner as { username?: unknown }).username as string | undefined) &&
          isNonEmpty((inner as { password?: unknown }).password as string | undefined)
        ) {
          const parsed = inner as { username: string; password: string };
          return { enabled: true, username: parsed.username, password: parsed.password };
        }
      }
    }
  } catch {
    // Keyring unavailability is never a worker crash — degrades to
    // unauthenticated, same as a missing env var (P1.9's "a missing key is
    // an admin-notice, not a startup failure", extended here).
  }

  return {
    enabled: false,
    reason: `${SMTP_USERNAME_ENV_VAR}/${SMTP_PASSWORD_ENV_VAR} are not set and no credentials have been saved from the admin settings screen`,
  };
}
