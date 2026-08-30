// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/consumer.ts
//
// The 'mail-send' job consumer (E6/M7). `mailSendConsumerHandler(deps)` is
// a FACTORY, matching apps/worker/src/image/consumer.ts's convention — it
// closes over injected deps (db, and an OPTIONAL nodemailer transport
// factory/credential resolver for tests) and returns the JobHandler
// `queue.work('mail-send', ...)` expects.
//
// Everything is resolved FRESH at job start, never once at worker boot
// (mirrors image/consumer.ts's settings re-resolution and
// resolveApiKeyWithKeyring's credential-resolution SHAPE — see
// ./credentials.ts's own header for why this one differs from that
// module's boot-time timing): effective mail.* settings via
// loadWorkerEffectiveSettings, then credentials env-first-else-keyring via
// resolveMailCredentials. A settings/credentials change from the admin
// screen therefore applies to the very next mail-send job with zero
// worker restart.
//
// Throws (job fails, pg-boss retries per JOB_QUEUE_OPTIONS['mail-send'])
// when mail has become unconfigured between enqueue and this job actually
// running (an admin could have cleared mail.smtpHost/fromAddress in that
// window) — MailDispatchService already checked isConfigured() before
// enqueueing, so this is the rare race case, not the common path.
//
// Render -> send: renderTemplate() never touches the network; sendMail()
// is the only I/O this handler performs, through nodemailer, with hard
// connection/greeting/socket timeouts (transport.ts) so a hung mail server
// can never hold this worker's one 'mail-send' concurrency slot forever.

import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { JobHandler } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import { detectSecretBackend, tryResolveSecret, unsealLinkToken } from '@loombre/secrets';
import { getWorkerSettingValue, loadWorkerEffectiveSettings } from '../settings/effective-settings.js';
import { mirrorServerDataDir } from '../metadata/keys.js';
import { resolveMailCredentials, type MailCredentialsResolution } from './credentials.js';
import { buildTransportOptions, type MailSmtpSecurity } from './transport.js';
import { renderTemplate } from './templates/index.js';

/** Templates whose message carries a live claim/reset link. Their payloads
 *  must arrive with `link` (a sealed reference, MRV-R1) — `params` never
 *  carries a token or a pre-built actionUrl, because pg-boss persists the
 *  payload where anyone with DB read access can see it. */
const LINKED_TEMPLATE_IDS = new Set(['invite', 'password-reset']);

/** The sealing secret is minted by the SERVER (mail-dispatch.service.ts)
 *  before any sealed payload is ever enqueued, through the same shared
 *  keyring both processes already use for the SMTP credentials — absence
 *  here is a real deployment fault (split dataDir/keyring), so it fails
 *  the job loudly rather than degrading. */
async function resolveSealingSecret(env: NodeJS.ProcessEnv): Promise<string> {
  const detected = await detectSecretBackend(env);
  const key = `${mirrorServerDataDir(env)}/secrets/mail-link-sealing-key`;
  const secret = await tryResolveSecret({ backend: detected.backend, key });
  if (secret === null) {
    throw new Error(
      'mail-send: the mail-link sealing key is missing from the keyring — the server creates it when it enqueues linked mail, so the worker is likely reading a different data dir / secret backend than the server.',
    );
  }
  return secret;
}

export interface MailTransporter {
  sendMail(options: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
  close(): void;
}

export interface MailConsumerDeps {
  db: DbOrTx;
  env?: NodeJS.ProcessEnv;
  /** Test seam — defaults to nodemailer.createTransport. */
  createTransport?: (options: SMTPTransport.Options) => MailTransporter;
  /** Test seam — defaults to ./credentials.js's resolveMailCredentials. */
  resolveCredentials?: (env: NodeJS.ProcessEnv) => Promise<MailCredentialsResolution>;
}

function fromHeader(fromName: string, fromAddress: string): string {
  // A from-name containing `"` would break the quoted-string form; strip
  // it defensively (fromName is admin-configured, not attacker-controlled,
  // but this costs nothing and avoids depending on nodemailer's own
  // quoting behavior for correctness).
  const safeName = fromName.replace(/"/g, '');
  return safeName.length > 0 ? `"${safeName}" <${fromAddress}>` : fromAddress;
}

export function mailSendConsumerHandler(deps: MailConsumerDeps): JobHandler<'mail-send'> {
  const env = deps.env ?? process.env;
  const createTransport = deps.createTransport ?? ((options: SMTPTransport.Options) => nodemailer.createTransport(options) as unknown as MailTransporter);
  const resolveCredentials = deps.resolveCredentials ?? resolveMailCredentials;

  return async (payload) => {
    const settingsResult = await loadWorkerEffectiveSettings(deps.db, env);
    const smtpHost = getWorkerSettingValue(settingsResult, 'mail.smtpHost', '');
    const smtpPort = getWorkerSettingValue(settingsResult, 'mail.smtpPort', 587);
    const smtpSecurity = getWorkerSettingValue<MailSmtpSecurity>(settingsResult, 'mail.smtpSecurity', 'starttls');
    const fromAddress = getWorkerSettingValue(settingsResult, 'mail.fromAddress', '');
    const fromName = getWorkerSettingValue(settingsResult, 'mail.fromName', 'Loombre');

    if (smtpHost.trim().length === 0 || fromAddress.trim().length === 0) {
      throw new Error('mail-send: mail is not configured (mail.smtpHost/mail.fromAddress must both be set) — cannot send.');
    }

    const credentialsResolution = await resolveCredentials(env);
    const credentials = credentialsResolution.enabled ? { username: credentialsResolution.username, password: credentialsResolution.password } : null;

    // MRV-R1: the actionUrl is built HERE, at send time, never at enqueue
    // time — the sealed token is unsealed in memory and the base comes
    // from the CURRENT effective network.publicUrl (same trailing-slash
    // strip mail-config.service.ts's publicUrl() applies), so a publicUrl
    // fix applies to still-queued mail and the plaintext never touched
    // the queue's tables.
    let params = payload.params;
    if (payload.link !== undefined) {
      const publicUrl = getWorkerSettingValue(settingsResult, 'network.publicUrl', '').trim().replace(/\/+$/, '');
      if (publicUrl.length === 0) {
        throw new Error('mail-send: network.publicUrl is not configured — cannot build the message link (it was configured at enqueue time; an admin cleared it since).');
      }
      const sealingSecret = await resolveSealingSecret(env);
      const token = unsealLinkToken(sealingSecret, payload.link.sealedToken);
      params = { ...payload.params, actionUrl: `${publicUrl}/${payload.link.kind === 'claim' ? 'claim' : 'reset'}/${token}` };
    } else if (LINKED_TEMPLATE_IDS.has(payload.templateId)) {
      throw new Error(`mail-send: template "${payload.templateId}" requires a sealed link and the payload carries none.`);
    }

    const rendered = renderTemplate(payload.templateId, params);

    const transportOptions = buildTransportOptions({
      config: { host: smtpHost, port: smtpPort, security: smtpSecurity },
      credentials,
    });
    const transporter = createTransport(transportOptions);
    try {
      await transporter.sendMail({
        from: fromHeader(fromName, fromAddress),
        to: payload.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } finally {
      transporter.close();
    }
  };
}
