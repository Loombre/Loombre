// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/transport.ts
//
// Optional mail transport run (E5): maps the mail-registry's effective
// settings + resolved credentials onto nodemailer's SMTP transport
// options. Pure/no I/O (returns an options object; the caller constructs
// the real transport and sends) so the mapping itself is unit-testable
// without a network.
//
// `mail.smtpSecurity`'s three values (settings-registry.ts) map onto
// nodemailer's SMTPConnection options as:
//   'implicit-tls' -> secure: true            (TLS from the first byte —
//                                                the common choice for port 465)
//   'starttls'     -> secure: false, requireTLS: true (upgrade via STARTTLS;
//                                                requireTLS REFUSES to send
//                                                if the server doesn't
//                                                support it, rather than
//                                                silently falling back to
//                                                plaintext — a caution-worthy
//                                                setting deserves a strict
//                                                transport, not merely an
//                                                opportunistic one)
//   'none'         -> secure: false, ignoreTLS: true (never attempts
//                                                encryption at all — the
//                                                registry entry's own
//                                                caution text: LAN-relay
//                                                use only)
//
// Hard timeouts (E6: a hung mail server must never hold a worker
// concurrency slot indefinitely) — connectionTimeout/greetingTimeout/
// socketTimeout all default to a bounded value; callers may override for
// tests.

import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';

export type MailSmtpSecurity = 'starttls' | 'implicit-tls' | 'none';

export interface MailTransportConfig {
  host: string;
  port: number;
  security: MailSmtpSecurity;
}

export interface MailTransportCredentials {
  username: string;
  password: string;
}

export interface BuildTransportOptionsInput {
  config: MailTransportConfig;
  credentials: MailTransportCredentials | null;
  /** @default 10_000 */
  connectionTimeoutMs?: number;
  /** @default 10_000 */
  greetingTimeoutMs?: number;
  /** @default 20_000 */
  socketTimeoutMs?: number;
}

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_GREETING_TIMEOUT_MS = 10_000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 20_000;

export function buildTransportOptions(input: BuildTransportOptionsInput): SMTPTransport.Options {
  const { config, credentials } = input;

  const securityOptions: Pick<SMTPTransport.Options, 'secure' | 'requireTLS' | 'ignoreTLS'> =
    config.security === 'implicit-tls'
      ? { secure: true }
      : config.security === 'starttls'
        ? { secure: false, requireTLS: true }
        : { secure: false, ignoreTLS: true };

  return {
    host: config.host,
    port: config.port,
    ...securityOptions,
    ...(credentials ? { auth: { user: credentials.username, pass: credentials.password } } : {}),
    connectionTimeout: input.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    greetingTimeout: input.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS,
    socketTimeout: input.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
  };
}
