// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UUIDv7 (RFC 9562 §5.7) — original implementation.
 *
 * Layout (128 bits, big-endian byte order):
 *   48 bits  unix_ts_ms
 *    4 bits  version (0111)
 *   12 bits  rand_a
 *    2 bits  variant (10)
 *   62 bits  rand_b
 *
 * Time-ordered (sorts correctly as a plain string/byte comparison for the
 * timestamp portion) and index-friendly — this is why Postgres primary keys
 * use it repo-wide (CLAUDE.md invariant 5).
 */
import { randomBytes } from "node:crypto";

const HEX_DIGITS = "0123456789abcdef";

/** RFC 4122 textual form, version nibble 1-8, variant nibble 8-b (case-insensitive). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeTimestampMs(bytes: Uint8Array, timestampMs: number): void {
  // 48-bit big-endian ms-since-epoch across bytes[0..5]. Uses division/modulo
  // rather than bitwise ops: JS bitwise operators coerce to 32-bit ints, which
  // would silently corrupt timestamps above 2^31.
  let remaining = Math.floor(timestampMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_DIGITS.charAt((byte >> 4) & 0x0f) + HEX_DIGITS.charAt(byte & 0x0f);
  }
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/**
 * Generates a UUIDv7. `timestampMs` defaults to the current time but may be
 * supplied explicitly (tests, deterministic fixtures, backfills).
 */
export function uuidv7(timestampMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  writeTimestampMs(bytes, timestampMs);

  // bytes[6..15]: 10 random bytes carrying rand_a (12 bits) + rand_b (62 bits).
  const random = randomBytes(10);
  bytes.set(random, 6);

  // Version 7: top nibble of byte 6 = 0111.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  // Variant (RFC 4122): top two bits of byte 8 = 10.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  return formatUuid(bytes);
}

/** Validates textual UUID shape (any RFC 4122 version/variant, case-insensitive). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
