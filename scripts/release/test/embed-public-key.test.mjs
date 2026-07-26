// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/embed-public-key.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { renderPublicKeyFileSource } from "../lib/embed-public-key.mjs";

const SAMPLE_KEY_TEXT = "untrusted comment: minisign public key ABCDEF0123456789\nRWQ...base64...\n";

test("renderPublicKeyFileSource embeds the exact file text (with trailing newline) as a JS string literal", () => {
  const source = renderPublicKeyFileSource(SAMPLE_KEY_TEXT);
  assert.match(source, /^\/\/ GENERATED — do not edit/);
  assert.match(source, /export const LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = /);
  // Round-trip: evaluating the generated module text should reproduce the
  // (trimmed + newline-restored) original.
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleUrl).then(({ LOOMBRE_UPDATE_PUBLIC_KEY_TEXT }) => {
    assert.equal(LOOMBRE_UPDATE_PUBLIC_KEY_TEXT, `${SAMPLE_KEY_TEXT.trimEnd()}\n`);
  });
});

test("renderPublicKeyFileSource normalizes trailing whitespace/blank lines to exactly one trailing newline", () => {
  const source = renderPublicKeyFileSource(`${SAMPLE_KEY_TEXT}\n\n\n   \n`);
  assert.match(source, /export const LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = "untrusted comment:.*\\n";\n$/s);
});

test("renderPublicKeyFileSource rejects a file that doesn't look like a minisign public key (too few lines)", () => {
  assert.throws(() => renderPublicKeyFileSource("only one line\n"), /does not look like/);
  assert.throws(() => renderPublicKeyFileSource(""), /does not look like/);
});

test("renderPublicKeyFileSource output has no unescaped quote/backslash breakage for a realistic comment", () => {
  const tricky = 'untrusted comment: key "with quotes" and a \\ backslash\nRWQAAA\n';
  const source = renderPublicKeyFileSource(tricky);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleUrl).then(({ LOOMBRE_UPDATE_PUBLIC_KEY_TEXT }) => {
    assert.equal(LOOMBRE_UPDATE_PUBLIC_KEY_TEXT, `${tricky.trimEnd()}\n`);
  });
});
