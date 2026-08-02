// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/index.ts
export { mailSendConsumerHandler, type MailConsumerDeps, type MailTransporter } from './consumer.js';
export { createMailTerminalFailureHook } from './terminal-failure-hook.js';
export { resolveMailCredentials, type MailCredentialsResolution } from './credentials.js';
export { buildTransportOptions, type MailTransportConfig, type MailTransportCredentials, type MailSmtpSecurity } from './transport.js';
export { renderTemplate, type RenderedMail } from './templates/index.js';
