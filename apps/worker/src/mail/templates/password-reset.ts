// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/password-reset.ts
//
// Optional mail transport run (E7/E8): the self-serve "forgot password"
// email — carries the single-use, 30-minute reset link (M15). Deliberately
// says NOTHING about whether the account/email exists beyond what the
// reader already knows by having received the message at all (E8's
// no-enumeration posture is enforced upstream, at the
// POST /auth/forgot-password endpoint, which always responds identically
// whether or not the account exists — this template only ever renders for
// a real send, so it can be direct).

import { actionButtonHtml, cautionHtml, escapeHtml, headingHtml, paragraphHtml, wrapEmail } from './shared.js';
import type { RenderedMail } from './types.js';

export function render(params: Record<string, string>): RenderedMail {
  const displayNameRaw = params['displayName']?.trim();
  const greetingName = displayNameRaw && displayNameRaw.length > 0 ? displayNameRaw : null;
  const actionUrl = params['actionUrl']?.trim();

  const subject = 'Reset your Loombre password';

  // escapeHtml runs exactly ONCE, over the fully-composed sentence — see
  // invite.ts's own comment on this for why (double-escaping would show
  // "&amp;lt;" to the recipient instead of rendering a `<` safely).
  const greetingSentence = greetingName ? `Hi ${greetingName},` : 'Hello,';
  const bodyHtml =
    headingHtml('Reset your password') +
    paragraphHtml(escapeHtml(`${greetingSentence} someone requested a password reset for your Loombre account.`)) +
    (actionUrl && actionUrl.length > 0 ? actionButtonHtml(actionUrl, 'Choose a new password') : '') +
    cautionHtml('This link works once and expires in 30 minutes. If you did not request this, you can ignore this email — your password will not change.');

  const html = wrapEmail({ title: subject, preheader: 'Reset your Loombre password.', bodyHtml });

  const textLines = [
    greetingName ? `Hi ${greetingName},` : 'Hello,',
    'someone requested a password reset for your Loombre account.',
    '',
  ];
  if (actionUrl && actionUrl.length > 0) {
    textLines.push('Choose a new password:', actionUrl, '');
  }
  textLines.push('This link works once and expires in 30 minutes. If you did not request this, you can ignore this email — your password will not change.');
  const text = textLines.join('\n').trim() + '\n';

  return { subject, html, text };
}
