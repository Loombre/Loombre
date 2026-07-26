// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loader for matrix/fixtures/caps.yaml (docs/PLAYBACK.md §2.5), reused by
 * both the case-file fixture resolver (matrix/lib/load-cases.ts, via its
 * own independent cache) and the property-test generators (matrix/lib/
 * generators.ts) so the random-input generator draws its VerifiedCapabilities
 * values from the SAME named fixture sets (`software-only`, `full-hw`,
 * `encode-only`, `macos-vt` — STATE.md P3.3) that matrix cases reference,
 * rather than inventing a parallel ad-hoc shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parse } from "yaml";
import type { VerifiedCapabilities } from "../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPS_PATH = join(__dirname, "..", "fixtures", "caps.yaml");

let cache: Record<string, VerifiedCapabilities> | null = null;

export function loadCapsFixtures(): Record<string, VerifiedCapabilities> {
  if (cache) return cache;
  const raw = readFileSync(CAPS_PATH, "utf8");
  cache = parse(raw) as Record<string, VerifiedCapabilities>;
  return cache;
}

export function listCapsFixtureNames(): string[] {
  return Object.keys(loadCapsFixtures());
}
