// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/templates/shared.ts
//
// Optional mail transport run (E7): shared building blocks every template
// in this directory uses — never duplicated per-template. EMAIL-SAFE by
// construction:
//   - Every dynamic string is passed through escapeHtml() before it
//     reaches the HTML output (someone WILL put `<script>` in a display
//     name — apps/worker/test/mail/templates.spec.ts proves it).
//   - wrapEmail() emits INLINE styles only, no `<style>` block, no
//     webfonts, no external image/resource references of any kind — the
//     zero-telemetry posture (CLAUDE.md invariant 7) extends to mail: an
//     opened message must never phone home.
//   - The only `http(s)://` URL wrapEmail()/actionButton() ever emit is
//     the caller-supplied `actionUrl` — itself required to be built ONLY
//     from MailConfigService.publicUrl() by every caller of
//     MailDispatchService.trySend() (E7's "no Host-header trust anywhere
//     in the pipeline"). This module has no other source of a URL to draw
//     from.
//
// Visual language (design/phosphor/README.md's --color-bg/--color-text/
// --color-accent tokens, hardcoded as hex — email clients do not support
// CSS custom properties or color-mix()): dark background, amber accent,
// system font stack (no @font-face, no Google Fonts link — those ARE
// remote resources).

const BG = '#0b0c0f';
const CARD_BG = '#15171c';
const BORDER = 'rgba(255,255,255,0.12)';
const TEXT = '#e9ebee';
const TEXT_MUTED = '#9ba0a8';
const ACCENT = '#ffb454';
const ACCENT_TEXT = '#0c0d10';

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface WrapEmailInput {
  /** Plain text, used for the <title> and hidden preheader — escaped here,
   *  callers pass raw text. */
  title: string;
  /** Already-composed, already-escaped HTML for the card body. */
  bodyHtml: string;
  /** Short one-line summary many mail clients show in the inbox list
   *  before the message is opened — plain text, escaped here. */
  preheader: string;
}

/**
 * The one HTML wrapper every template renders through — a single-column
 * card on a dark background, inline styles only, no <style> block, no
 * external resources. `bodyHtml` is trusted to already be
 * escaped/composed by the caller (every per-template render() function is
 * responsible for escaping ITS OWN dynamic inputs before calling this).
 */
export function wrapEmail(input: WrapEmailInput): string {
  const safeTitle = escapeHtml(input.title);
  const safePreheader = escapeHtml(input.preheader);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};color:${TEXT};font-family:${FONT_STACK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};padding:32px 16px;">
<tr>
<td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;">
<tr>
<td style="padding:32px 28px;">
<div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT};font-weight:600;margin:0 0 20px 0;">Loombre</div>
${input.bodyHtml}
</td>
</tr>
</table>
<div style="max-width:480px;margin:20px auto 0 auto;color:${TEXT_MUTED};font-size:12px;line-height:1.5;">
This message was sent by a Loombre server. If you weren't expecting it, you can safely ignore it.
</div>
</td>
</tr>
</table>
</body>
</html>`;
}

/** An amber CTA button/link — the ONE http(s) URL a template is allowed to
 *  emit (see this file's header). `label` is escaped here; `actionUrl` is
 *  escaped in BOTH places it's rendered — the href attribute (a raw `"`
 *  in the URL could otherwise break out of the attribute) and the visible
 *  fallback text. */
export function actionButtonHtml(actionUrl: string, label: string): string {
  const safeLabel = escapeHtml(label);
  const safeUrl = escapeHtml(actionUrl);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px 0;">
<tr>
<td style="border-radius:8px;background-color:${ACCENT};">
<a href="${safeUrl}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:${ACCENT_TEXT};text-decoration:none;border-radius:8px;">${safeLabel}</a>
</td>
</tr>
</table>
<div style="margin:8px 0 0 0;font-size:12px;color:${TEXT_MUTED};word-break:break-all;">${safeUrl}</div>`;
}

export function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${TEXT};">${text}</p>`;
}

export function headingHtml(text: string): string {
  return `<h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.4;color:${TEXT};font-weight:600;">${escapeHtml(text)}</h1>`;
}

export function cautionHtml(text: string): string {
  return `<p style="margin:20px 0 0 0;padding:12px 14px;border-radius:8px;background-color:rgba(255,180,84,0.1);border:1px solid rgba(255,180,84,0.3);font-size:13px;line-height:1.5;color:${TEXT_MUTED};">${text}</p>`;
}
