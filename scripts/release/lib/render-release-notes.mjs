// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/render-release-notes.mjs
//
// Pure {{PLACEHOLDER}} substitution over scripts/release/release-notes-
// template.md (P4.9 location #3 — the release-notes template; see
// keys/README.md's three-location rollout checklist). Kept as a real
// standalone Markdown file rather than synthesized inline inside
// release.yml's YAML: a bash heredoc needs its literal backticks escaped
// to survive unquoted-heredoc variable expansion, which would mean the
// KEY BLOCK's fenced-code-block delimiters are never literal ``` in the
// checked-in source — scripts/release/check-pubkey-consistency.mjs reads
// literal ``` fences, so this design keeps that script simple and keeps
// the template reviewable as plain Markdown in diffs.

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function renderReleaseNotes(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  const remaining = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (remaining) {
    throw new Error(`renderReleaseNotes: unresolved placeholder(s) after substitution: ${remaining.join(", ")}`);
  }
  return rendered;
}
