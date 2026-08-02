// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/email-in-use-notice.ts
//
// G7 (STATE.md "Current-password re-auth on self-changes", F5): sent to
// the EXISTING owner of an address that someone else's invite-claim or
// self-service email-change attempt collided with (packages/db's
// claimInviteAndEmit / updateUserSelf both silently drop the colliding
// member — actor-visible behavior unchanged, E8 standing decision — this
// template is the out-of-band signal to the address's REAL owner, sent
// only when the mail tier is configured). Deliberately URL-FREE — zero
// links beats E7's own "one caller-supplied actionUrl at most" minimum,
// since there is genuinely nothing for the recipient to click or do.
// Rate-limited server-side, per address, BEFORE this ever renders
// (packages/db/src/query/email-collision-notice.ts's 24h ledger claim —
// "the signal must not become a harassment vector", F5).
//
// A NEW templateId, deliberately NOT security-notice.ts reused: that
// template's fixed subject/copy ("your password was reset by an
// administrator") describes a different security event entirely —
// conflating the two under one subject was rejected (G7).

import { cautionHtml, escapeHtml, headingHtml, paragraphHtml, wrapEmail } from './shared.js';
import type { RenderedMail } from './types.js';

const DEFAULT_SERVER_NAME = 'Loombre';

export function render(params: Record<string, string>): RenderedMail {
  const serverNameRaw = params['serverName']?.trim();
  const serverName = serverNameRaw && serverNameRaw.length > 0 ? serverNameRaw : DEFAULT_SERVER_NAME;

  const subject = `Your email address was used on ${serverName}`;

  // escapeHtml runs exactly ONCE, over the fully-composed sentence — same
  // convention as every other template in this directory (double-escaping
  // would show "&amp;lt;" instead of rendering a `<` safely).
  const bodyHtml =
    headingHtml('Your email address was used') +
    paragraphHtml(escapeHtml(`Someone attempted to use this email address on ${serverName}.`)) +
    paragraphHtml('If this was you, no action is needed.') +
    cautionHtml(
      escapeHtml("If it wasn't you, your account is unaffected — this address was not added or changed on any account."),
    );

  const html = wrapEmail({
    title: subject,
    preheader: `Someone attempted to use this email address on ${serverName}.`,
    bodyHtml,
  });

  const text =
    [
      `Someone attempted to use this email address on ${serverName}.`,
      '',
      'If this was you, no action is needed.',
      "If it wasn't you, your account is unaffected — this address was not added or changed on any account.",
    ]
      .join('\n')
      .trim() + '\n';

  return { subject, html, text };
}
