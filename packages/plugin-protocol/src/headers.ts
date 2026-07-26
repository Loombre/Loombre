// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/headers.ts
//
// C3: config/secrets are injected PER-REQUEST via `X-LPP-Config` (JSON) and
// `X-LPP-Secret-<NAME>` so plugins stay stateless. HTTP header VALUES are
// restricted to a Latin-1-safe byte range by the HTTP spec (RFC 9110 §5.5)
// and mishandled outright by some intermediaries/runtimes above that range
// — a config value or secret containing non-ASCII text (a display name, a
// description with an accent, an emoji in a Discord webhook message
// template) cannot be dropped into a header raw. The encoding this file
// defines: UTF-8 encode the value, then standard base64 (RFC 4648 §4, with
// padding) the bytes. Base64's output alphabet (`A-Za-z0-9+/=`) is pure
// ASCII token-safe, so the result is always a legal header value regardless
// of what the original text contained.
//
//   X-LPP-Config:        base64(utf8(JSON.stringify(configObject)))
//   X-LPP-Secret-<NAME>: base64(utf8(secretStringValue))
//
// `<NAME>` is the plugin's own configSchema property key for that secret
// field (json-schema-subset.ts's `secret: true` leaves are always
// `type: "string"`, so the payload is always a single string — see that
// file's header for why non-string secrets are rejected at the schema
// level). Header NAMES are further restricted to RFC 7230 `token` chars;
// `lppSecretHeaderName` below canonicalizes a field key into one
// deterministically so an unusual-but-JSON-legal property name (rare; plain
// camelCase/kebab-case keys pass through untouched) still produces a valid
// header name instead of throwing.

const TOKEN_SAFE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Canonicalizes a configSchema field key into the `<NAME>` suffix of an
 *  `X-LPP-Secret-<NAME>` header name: uppercased, any run of non-token
 *  characters collapsed to a single `-`, leading/trailing `-` trimmed.
 *  Field keys that are already simple identifiers (the overwhelmingly
 *  common case) pass through unchanged apart from case. */
export function lppSecretHeaderFieldName(fieldKey: string): string {
  const upper = fieldKey.toUpperCase();
  const collapsed = TOKEN_SAFE.test(upper) ? upper : upper.replace(/[^!#$%&'*+\-.^_`|~0-9A-Z]+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  if (trimmed.length === 0) {
    throw new Error(`lppSecretHeaderFieldName: "${fieldKey}" has no representable header-token characters`);
  }
  return trimmed;
}

export const LPP_CONFIG_HEADER = "X-LPP-Config";

/** Full header name for one secret-marked configSchema field. */
export function lppSecretHeaderName(fieldKey: string): string {
  return `X-LPP-Secret-${lppSecretHeaderFieldName(fieldKey)}`;
}

/** True for any header name a plugin should treat as a secret field
 *  delivery — used by example/reference plugins and the conformance suite
 *  to enumerate secrets a request actually carried. */
export function isLppSecretHeaderName(headerName: string): boolean {
  return /^x-lpp-secret-/i.test(headerName);
}

/** Recovers the raw configSchema field key's canonical form from a header
 *  name (the inverse of the header-name half of `lppSecretHeaderName`; the
 *  canonicalization is lossy for exotic keys, so callers that need the
 *  ORIGINAL key should look it up by re-deriving `lppSecretHeaderName` for
 *  each candidate key from the plugin's own configSchema rather than
 *  reversing this). */
export function lppSecretFieldNameFromHeaderName(headerName: string): string {
  return headerName.replace(/^x-lpp-secret-/i, "");
}

export function encodeLppConfigHeaderValue(config: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}

/** Throws if `value` is not valid base64 or does not decode to valid JSON —
 *  callers (host + conformance suite + example plugins) should treat a
 *  thrown error here the same as any other malformed-request condition. */
export function decodeLppConfigHeaderValue(value: string): unknown {
  const json = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(json);
}

export function encodeLppSecretHeaderValue(secretValue: string): string {
  return Buffer.from(secretValue, "utf8").toString("base64");
}

export function decodeLppSecretHeaderValue(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
