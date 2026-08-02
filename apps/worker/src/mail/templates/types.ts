// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/types.ts

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Every template's params come from the SAME `Record<string,string>` the
 * enqueuer passed to MailDispatchService.trySend()/the admin test-send
 * action — this file documents the keys each template actually reads.
 * `actionUrl` (where present) MUST be built by the caller from
 * MailConfigService.publicUrl() alone (E7) — no template in this
 * directory ever composes a URL itself from a host/path pair, precisely
 * so there is only ONE place in the whole pipeline that could ever get
 * Host-header trust wrong, and it isn't here.
 */
export interface TemplateParamKeys {
  invite: {
    /** Required. Falls back to rendering without a button/link if absent
     *  or empty — a template render failure would fail the whole job
     *  (and eventually retry/terminally fail) for what is, from the
     *  recipient's point of view, a cosmetic problem; degrading is safer. */
    actionUrl?: string;
    /** Optional — "Hi <displayName>," vs. a generic greeting. */
    displayName?: string;
    /** Optional, pre-formatted (e.g. "72 hours") — this module never does
     *  duration arithmetic itself. */
    expiresLabel?: string;
  };
  'password-reset': {
    actionUrl?: string;
    displayName?: string;
  };
  'security-notice': {
    /** Optional here (unlike invite/password-reset) — an admin-initiated
     *  reset notice is informational; a sign-in link is a nicety, not the
     *  point of the message. */
    actionUrl?: string;
    displayName?: string;
  };
  /** G7 (STATE.md "Current-password re-auth on self-changes", F5):
   *  deliberately carries NO actionUrl key at all — this template is
   *  URL-FREE by design (nothing for the recipient to click). */
  'email-in-use-notice': {
    /** Optional — falls back to "Loombre" (the registry default for
     *  mail.fromName) when absent/empty. */
    serverName?: string;
  };
  test: Record<string, never>;
}
