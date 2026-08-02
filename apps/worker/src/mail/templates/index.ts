// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/index.ts

import * as invite from './invite.js';
import * as passwordReset from './password-reset.js';
import * as securityNotice from './security-notice.js';
import * as test from './test.js';
import type { RenderedMail } from './types.js';

export type { RenderedMail } from './types.js';

const RENDERERS: Record<'invite' | 'password-reset' | 'security-notice' | 'test', (params: Record<string, string>) => RenderedMail> = {
  invite: invite.render,
  'password-reset': passwordReset.render,
  'security-notice': securityNotice.render,
  test: test.render,
};

export function renderTemplate(
  templateId: 'invite' | 'password-reset' | 'security-notice' | 'test',
  params: Record<string, string>,
): RenderedMail {
  return RENDERERS[templateId](params);
}
