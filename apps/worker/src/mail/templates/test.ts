// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/test.ts
//
// Optional mail transport run (E6/M11): rendered by the admin "send test
// email" action (POST /admin/mail/test-send). No params required — takes
// no action link at all, so it trivially satisfies the zero-external-
// resources rule with no caller input to escape.

import { headingHtml, paragraphHtml, wrapEmail } from './shared.js';
import type { RenderedMail } from './types.js';

export function render(_params: Record<string, string>): RenderedMail {
  const subject = 'Loombre test email';

  const bodyHtml =
    headingHtml('Mail is working') +
    paragraphHtml('This is a test message from your Loombre server. If you received it, outgoing mail is configured correctly.');

  const html = wrapEmail({ title: subject, preheader: 'Outgoing mail is configured correctly.', bodyHtml });

  const text = 'This is a test message from your Loombre server. If you received it, outgoing mail is configured correctly.\n';

  return { subject, html, text };
}
