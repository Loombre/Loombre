// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/security-notice.ts
//
// Optional mail transport run (E7, M14): sent alongside an ADMIN-initiated
// password reset (CLI `loombre admin reset-password` or the admin users
// action) when the email tier is active and the user has an address on
// file — a heads-up, not an action the recipient needs to take from this
// message (the admin already showed/printed the temporary password once,
// out of band). `actionUrl` is optional here, unlike invite/password-reset.

import { actionButtonHtml, cautionHtml, escapeHtml, headingHtml, paragraphHtml, wrapEmail } from './shared.js';
import type { RenderedMail } from './types.js';

export function render(params: Record<string, string>): RenderedMail {
  const displayNameRaw = params['displayName']?.trim();
  const greetingName = displayNameRaw && displayNameRaw.length > 0 ? displayNameRaw : null;
  const actionUrl = params['actionUrl']?.trim();

  const subject = 'Your Loombre password was reset';

  // escapeHtml runs exactly ONCE, over the fully-composed sentence — see
  // invite.ts's own comment on this for why (double-escaping would show
  // "&amp;lt;" to the recipient instead of rendering a `<` safely).
  const greetingSentence = greetingName ? `Hi ${greetingName},` : 'Hello,';
  const bodyHtml =
    headingHtml('Password reset') +
    paragraphHtml(escapeHtml(`${greetingSentence} an administrator reset the password on your Loombre account.`)) +
    paragraphHtml("You'll be asked to choose a new password the next time you sign in.") +
    (actionUrl && actionUrl.length > 0 ? actionButtonHtml(actionUrl, 'Sign in') : '') +
    cautionHtml("If you didn't expect this, contact your server's administrator.");

  const html = wrapEmail({ title: subject, preheader: 'An administrator reset your Loombre password.', bodyHtml });

  const textLines = [
    greetingName ? `Hi ${greetingName},` : 'Hello,',
    'an administrator reset the password on your Loombre account.',
    "You'll be asked to choose a new password the next time you sign in.",
    '',
  ];
  if (actionUrl && actionUrl.length > 0) {
    textLines.push('Sign in:', actionUrl, '');
  }
  textLines.push("If you didn't expect this, contact your server's administrator.");
  const text = textLines.join('\n').trim() + '\n';

  return { subject, html, text };
}
