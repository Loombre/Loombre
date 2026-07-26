// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/uuidv7.ts
//
// Two small helpers the gap-window computation (delivery-loop.ts) needs
// that packages/shared/src/ids.ts's `uuidv7()` doesn't provide: decoding
// the embedded timestamp back out of an existing id, and synthesizing a
// "boundary" id at an EXACT timestamp with the minimum possible trailing
// bits (so it sorts before any real UUIDv7 minted at that same
// millisecond — RFC 9562 §5.7 layout, docs/PLAN.md's keyset-cursor
// convention, packages/db/src/query/events.ts's header). Kept local to
// this lane rather than added to packages/shared (out of this lane's
// touch scope, and tightly coupled to the retention-window semantics
// nothing else in the repo needs).

const HEX_DIGITS = "0123456789abcdef";

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
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32)
  );
}

/** Decodes the 48-bit big-endian unix_ts_ms embedded in a UUIDv7's leading
 *  6 bytes. Works on any RFC-4122-shaped uuid string (version nibble is
 *  never inspected) — callers only ever pass real events.id values, which
 *  are always minted by loombre_uuidv7() (migrations/0001_init.sql), or a
 *  boundary id this module itself produced. */
export function decodeUuidv7TimestampMs(uuid: string): number {
  const hex = uuid.replace(/-/g, "");
  return Number.parseInt(hex.slice(0, 12), 16);
}

/**
 * Synthesizes a valid-shaped UUIDv7 at exactly `timestampMs` with every
 * bit after the timestamp/version/variant fields set to zero — the
 * MINIMUM possible UUIDv7 value for that millisecond. Used as a
 * "read everything from this timestamp forward" cursor boundary: because
 * it is the minimum value at that ms, `events.id > boundary` includes
 * every real event minted at that exact millisecond (their random tail
 * bits are astronomically unlikely to also be all-zero, and even a
 * fluke tie would sort AFTER this boundary under `>`, never before it).
 */
export function boundaryUuidv7AtMs(timestampMs: number): string {
  const bytes = new Uint8Array(16);
  let remaining = Math.floor(timestampMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70; // version 7, rand_a = 0
  bytes[8] = 0x80; // variant 10, rand_b top bits = 0
  return formatUuid(bytes);
}

/** "Never delivered before" cursor substitute — the minimum possible
 *  UUIDv7 (epoch 0), so `events.id > EPOCH_ZERO_BOUNDARY_UUID` matches
 *  every real event ever written. */
export const EPOCH_ZERO_BOUNDARY_UUID = boundaryUuidv7AtMs(0);
