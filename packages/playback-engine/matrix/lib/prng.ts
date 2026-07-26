// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Seeded, deterministic PRNG + sampling helpers for the property-test
 * harness (docs/PLAYBACK.md §10 "Mandatory property tests" / §11 step 1).
 *
 * mulberry32: a small, fast, well-known PRNG. Same seed => same sequence,
 * forever, across OSes and Node versions — pure integer/float arithmetic,
 * NO Math.random anywhere in this module (or anywhere in matrix/lib —
 * property tests must be exactly reproducible from a fixed seed).
 */

export type Rng = () => number;

/** mulberry32(seed) returns a generator function producing floats in [0,1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max], inclusive on both ends. */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Uniform float in [min, max), rounded to `decimals` places. */
export function float(rng: Rng, min: number, max: number, decimals = 3): number {
  const value = min + rng() * (max - min);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** true with probability `p` (default 0.5). */
export function bool(rng: Rng, p = 0.5): boolean {
  return rng() < p;
}

/** Uniform pick from a non-empty readonly array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick(): items must be non-empty");
  const index = Math.min(Math.floor(rng() * items.length), items.length - 1);
  return items[index] as T;
}

/** Fisher-Yates shuffle (deterministic given rng); returns a new array. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Pick `n` distinct items (order randomized); `n` clamped to items.length. */
export function pickN<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const clamped = Math.max(0, Math.min(n, items.length));
  return shuffle(rng, items).slice(0, clamped);
}

/** Run `fn(i)` for i in [0, n), collecting results — a seed-agnostic loop
 *  helper (not itself randomized) used by the generators to build arrays. */
export function times<T>(n: number, fn: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(fn(i));
  return out;
}
