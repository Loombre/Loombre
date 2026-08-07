// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal, hand-rolled parser for exactly the shape of packages/
 * playback-engine/matrix/fixtures/caps.yaml — NOT a general YAML parser.
 *
 * Dependency decision (reported per this step's instructions): @loombre/
 * worker has no `yaml` dependency today; packages/playback-engine does
 * (a devDependency, used only by its own matrix loader). Adding `yaml` to
 * apps/worker just to read one fixture file in one test would be a real,
 * lockfile-visible dependency for a need this file's ~40 lines cover
 * completely — caps.yaml's structure is a closed, simple shape (a flat map
 * of named fixture sets, each a `backends:` list of 4-field records with
 * ONLY inline `[a, b, c]`-style arrays, never multi-line/nested YAML), so
 * this module reimplements exactly that shape rather than pulling in a
 * general-purpose parser. If caps.yaml's shape ever grows real YAML
 * features (anchors, multi-line scalars, nested maps), this parser is the
 * thing to replace with the real `yaml` package at that point — flagged
 * here so a future reader doesn't mistake the omission for an oversight.
 */

export interface CapsBackendFixture {
  backend: string;
  decode: string[];
  encode: string[];
  toneMap: string[];
  verifiedAtMs: number;
}

export interface CapsFixtureSet {
  backends: CapsBackendFixture[];
}

export type CapsFixtures = Record<string, CapsFixtureSet>;

function parseInlineArray(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseCapsYaml(text: string): CapsFixtures {
  const result: CapsFixtures = {};
  let currentSetName: string | null = null;
  let currentBackend: Partial<CapsBackendFixture> | null = null;

  function commitBackend(): void {
    if (currentBackend === null) return;
    if (currentSetName === null) {
      throw new Error("caps-yaml: backend entry committed with no active fixture set");
    }
    const b = currentBackend;
    if (
      typeof b.backend !== "string" ||
      !Array.isArray(b.decode) ||
      !Array.isArray(b.encode) ||
      !Array.isArray(b.toneMap) ||
      typeof b.verifiedAtMs !== "number"
    ) {
      throw new Error(`caps-yaml: incomplete backend entry in fixture set "${currentSetName}": ${JSON.stringify(b)}`);
    }
    result[currentSetName]!.backends.push(b as CapsBackendFixture);
    currentBackend = null;
  }

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Top-level key (column 0): `<name>:` — starts a new fixture set.
    const topLevelMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (topLevelMatch && line[0] !== " ") {
      commitBackend();
      currentSetName = topLevelMatch[1]!;
      result[currentSetName] = { backends: [] };
      continue;
    }

    // `  backends:` — no state to record, just a structural marker.
    if (/^\s*backends:\s*$/.test(line)) continue;

    // `  backends: []` — inline empty list (W1/D-1's `empty` fixture: a
    // COMPLETED probe that verified nothing). The set keeps the empty
    // backends array it was initialized with.
    if (/^\s*backends:\s*\[\s*\]\s*$/.test(line)) continue;

    const backendStart = /^\s*-\s*backend:\s*(\S+)\s*$/.exec(line);
    if (backendStart) {
      commitBackend();
      if (currentSetName === null) {
        throw new Error("caps-yaml: backend list entry found before any top-level fixture set");
      }
      currentBackend = { backend: backendStart[1]! };
      continue;
    }

    if (currentBackend) {
      const decodeMatch = /^\s*decode:\s*\[(.*)\]\s*$/.exec(line);
      if (decodeMatch) {
        currentBackend.decode = parseInlineArray(decodeMatch[1]!);
        continue;
      }
      const encodeMatch = /^\s*encode:\s*\[(.*)\]\s*$/.exec(line);
      if (encodeMatch) {
        currentBackend.encode = parseInlineArray(encodeMatch[1]!);
        continue;
      }
      const toneMapMatch = /^\s*toneMap:\s*\[(.*)\]\s*$/.exec(line);
      if (toneMapMatch) {
        currentBackend.toneMap = parseInlineArray(toneMapMatch[1]!);
        continue;
      }
      const verifiedMatch = /^\s*verifiedAtMs:\s*(\d+)\s*$/.exec(line);
      if (verifiedMatch) {
        currentBackend.verifiedAtMs = Number(verifiedMatch[1]);
        continue;
      }
    }

    throw new Error(`caps-yaml: unrecognized line while parsing caps.yaml: ${JSON.stringify(line)}`);
  }
  commitBackend();

  return result;
}
