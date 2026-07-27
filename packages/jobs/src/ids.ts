// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/ids.ts
//
// UUIDv7 (RFC 9562 §5.7) for the job ids queue.ts mints itself (it owns the
// id so the ledger row lands before boss.send() — see that file's comment).
// CLAUDE.md invariant 5 is "UUIDv7 everywhere": a caller-supplied id
// overrides `jobs.id`'s `DEFAULT loombre_uuidv7()`, so node:crypto's
// randomUUID() (a v4) would silently drop the time-ordering property every
// other primary key in the schema has.
//
// Deliberately duplicated from packages/shared/src/ids.ts rather than
// imported: this package takes no @loombre/shared workspace dependency (the
// same constraint types.ts's MetadataJobPayload comment already records for
// the inlined MediaKind/ContentClass unions).

import { randomBytes } from 'node:crypto';

const HEX_DIGITS = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX_DIGITS.charAt((byte >> 4) & 0x0f) + HEX_DIGITS.charAt(byte & 0x0f);
  }
  return out;
}

/**
 * Generates a UUIDv7. `timestampMs` defaults to the current time but may be
 * supplied explicitly (tests, deterministic fixtures).
 */
export function uuidv7(timestampMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit big-endian ms-since-epoch across bytes[0..5]. Division/modulo
  // rather than bitwise ops: JS bitwise operators coerce to 32-bit ints,
  // which would corrupt timestamps above 2^31.
  let remaining = Math.floor(timestampMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  // bytes[6..15]: 10 random bytes carrying rand_a (12 bits) + rand_b (62 bits).
  bytes.set(randomBytes(10), 6);
  // Version 7: top nibble of byte 6 = 0111.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  // Variant (RFC 4122): top two bits of byte 8 = 10.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = toHex(bytes);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
