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
import { getWorkerSettingValue, loadWorkerEffectiveSettings } from '../settings/effective-settings.js';
import { resolveMailCredentials, type MailCredentialsResolution } from './credentials.js';
import { buildTransportOptions, type MailSmtpSecurity } from './transport.js';
import { renderTemplate } from './templates/index.js';

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

    const rendered = renderTemplate(payload.templateId, payload.params);

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
