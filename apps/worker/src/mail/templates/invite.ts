// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/invite.ts
//
// Optional mail transport run (E7): the invite email — delivers the SAME
// claim link an admin could otherwise copy and hand over directly (E1: no
// flow assumes mail exists; mail, when configured, delivers the identical
// artifact). Every dynamic value is escaped (escapeHtml, via
// paragraphHtml/actionButtonHtml/headingHtml's own escaping) before it
// reaches the HTML output.

import { actionButtonHtml, cautionHtml, escapeHtml, headingHtml, paragraphHtml, wrapEmail } from './shared.js';
import type { RenderedMail } from './types.js';

export function render(params: Record<string, string>): RenderedMail {
  const displayNameRaw = params['displayName']?.trim();
  const greetingName = displayNameRaw && displayNameRaw.length > 0 ? displayNameRaw : null;
  const actionUrl = params['actionUrl']?.trim();
  const expiresLabel = params['expiresLabel']?.trim();

  const subject = "You're invited to Loombre";

  // escapeHtml runs exactly ONCE, over the fully-composed sentence — NOT
  // once on greetingName and again on the sentence it's embedded in
  // (double-escaping would literally show "&amp;lt;" to the recipient
  // instead of rendering a `<` safely).
  const greetingSentence = greetingName ? `Hi ${greetingName},` : 'Hello,';
  const introHtml =
    paragraphHtml(escapeHtml(`${greetingSentence} you've been invited to join a Loombre server.`)) +
    paragraphHtml('Follow the link below to set up your account.');
  const expiryHtml = expiresLabel
    ? cautionHtml(`This invitation expires in ${escapeHtml(expiresLabel)}. After that, ask whoever invited you for a new link.`)
    : '';

  const bodyHtml =
    headingHtml("You're invited") +
    introHtml +
    (actionUrl && actionUrl.length > 0 ? actionButtonHtml(actionUrl, 'Set up your account') : '') +
    expiryHtml;

  const html = wrapEmail({ title: subject, preheader: "You've been invited to join a Loombre server.", bodyHtml });

  const textLines = [
    greetingName ? `Hi ${greetingName},` : 'Hello,',
    "you've been invited to join a Loombre server.",
    '',
  ];
  if (actionUrl && actionUrl.length > 0) {
    textLines.push('Set up your account:', actionUrl, '');
  }
  if (expiresLabel) {
    textLines.push(`This invitation expires in ${expiresLabel}. After that, ask whoever invited you for a new link.`);
  }
  const text = textLines.join('\n').trim() + '\n';

  return { subject, html, text };
}
