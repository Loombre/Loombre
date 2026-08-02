// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/mail/templates.spec.ts
//
// Optional mail transport run (E7): EMAIL-SAFE proof for the four
// templates — zero remote resources (no http(s) URL anywhere in the
// rendered output OTHER than the caller-supplied actionUrl itself), every
// dynamic param HTML-escaped (someone WILL put <script> in a display
// name), and both an HTML and a plaintext alternative are always
// non-empty.

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/mail/templates/index.js";
import { actionButtonHtml, escapeHtml } from "../../src/mail/templates/shared.js";

const TEMPLATE_IDS = ["invite", "password-reset", "security-notice", "test"] as const;

/** Every http(s) URL literally present in a string, deduplicated. */
function findUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return [...new Set(matches)];
}

describe("mail templates — zero external resources (E7)", () => {
  it.each(TEMPLATE_IDS)("%s: the ONLY http(s) URL in the rendered HTML+text is the caller's own actionUrl (when given)", (templateId) => {
    const actionUrl = "https://loombre.example.com/claim/tok_abc123";
    const rendered = renderTemplate(templateId, { actionUrl, displayName: "Ozzy", expiresLabel: "72 hours" });

    const urlsInHtml = findUrls(rendered.html);
    const urlsInText = findUrls(rendered.text);

    for (const url of [...urlsInHtml, ...urlsInText]) {
      expect(url.startsWith(actionUrl) || url === actionUrl, `unexpected URL in ${templateId}: ${url}`).toBe(true);
    }
  });

  it.each(TEMPLATE_IDS)("%s: with NO actionUrl at all, the rendered HTML+text contain ZERO http(s) URLs", (templateId) => {
    const rendered = renderTemplate(templateId, { displayName: "Ozzy" });
    expect(findUrls(rendered.html)).toEqual([]);
    expect(findUrls(rendered.text)).toEqual([]);
  });

  it.each(TEMPLATE_IDS)("%s: no <style> block, no <link>/<script>/<img> tag anywhere (inline styles only, no webfonts, no remote resources)", (templateId) => {
    const rendered = renderTemplate(templateId, { actionUrl: "https://x.example.com/y" });
    expect(rendered.html).not.toMatch(/<style[\s>]/i);
    expect(rendered.html).not.toMatch(/<link[\s>]/i);
    expect(rendered.html).not.toMatch(/<script[\s>]/i);
    expect(rendered.html).not.toMatch(/<img[\s>]/i);
    expect(rendered.html).not.toMatch(/@import/i);
    expect(rendered.html).not.toMatch(/@font-face/i);
  });

  it.each(TEMPLATE_IDS)("%s: subject and both HTML/plaintext bodies are always non-empty", (templateId) => {
    const rendered = renderTemplate(templateId, {});
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });
});

describe("mail templates — every param is HTML-escaped (E7)", () => {
  const XSS_DISPLAY_NAME = '<script>alert(1)</script>"onmouseover="x';

  it.each(["invite", "password-reset", "security-notice"] as const)(
    "%s: a <script>-bearing displayName never appears unescaped in the rendered HTML",
    (templateId) => {
      const rendered = renderTemplate(templateId, { displayName: XSS_DISPLAY_NAME, actionUrl: "https://x.example.com/y" });
      expect(rendered.html).not.toContain("<script>alert(1)</script>");
      expect(rendered.html).toContain(escapeHtml(XSS_DISPLAY_NAME));
    },
  );

  it("invite: an XSS-bearing expiresLabel is escaped too", () => {
    const rendered = renderTemplate("invite", { expiresLabel: '<img src=x onerror=alert(1)>' });
    expect(rendered.html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("actionUrl itself is HTML-escaped when it contains an ampersand (query string safety)", () => {
    const rendered = renderTemplate("password-reset", { actionUrl: "https://x.example.com/reset?token=abc&foo=bar" });
    expect(rendered.html).not.toContain('token=abc&foo=bar"');
    expect(rendered.html).toContain("token=abc&amp;foo=bar");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("actionButtonHtml — F12 (opus adversarial review, fix wave): scheme allow-list", () => {
  it("a javascript: URL renders NO button at all — empty string", () => {
    expect(actionButtonHtml("javascript:alert(1)", "Click me")).toBe("");
  });

  it("a data: URL also renders no button", () => {
    expect(actionButtonHtml("data:text/html,<script>alert(1)</script>", "Click me")).toBe("");
  });

  it("http/https URLs are unaffected — the button still renders", () => {
    expect(actionButtonHtml("https://loombre.example.com/claim/tok", "Click me")).toContain("<a href=");
    expect(actionButtonHtml("http://loombre.example.com/claim/tok", "Click me")).toContain("<a href=");
  });

  it.each(["invite", "password-reset", "security-notice"] as const)(
    "%s: a javascript: actionUrl renders NO <a> tag anywhere and never appears as a raw href",
    (templateId) => {
      const rendered = renderTemplate(templateId, { actionUrl: "javascript:alert(document.cookie)", displayName: "Ozzy" });
      expect(rendered.html).not.toMatch(/<a\s/i);
      expect(rendered.html).not.toContain("javascript:alert(document.cookie)");
    },
  );
});
