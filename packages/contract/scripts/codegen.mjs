#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Generates packages/sdk/src/generated/{types.ts,paths.ts} from
// packages/contract/openapi.yaml. Run via:
//   pnpm --filter @loombre/contract codegen
//
// Determinism is load-bearing: CI's drift-check re-runs this script and
// does `git diff --exit-code packages/sdk`. Both outputs below are built
// from a single parse of openapi.yaml and emit stable, sorted ordering —
// no Object key iteration on non-deterministic sources, no timestamps.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import openapiTS, { astToString } from "openapi-typescript";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(CONTRACT_ROOT, "openapi.yaml");
const SDK_GENERATED_DIR = path.resolve(CONTRACT_ROOT, "../sdk/src/generated");

const BANNER = "// GENERATED — do not edit (pnpm --filter @loombre/contract codegen)\n";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

function loadSpec() {
  const raw = readFileSync(SPEC_PATH, "utf8");
  return YAML.parse(raw);
}

async function generateTypes(doc) {
  const ast = await openapiTS(doc);
  const body = astToString(ast);
  return BANNER + "\n" + body;
}

function generatePaths(doc) {
  /** @type {Array<{ path: string, method: string, operationId: string }>} */
  const operations = [];

  const pathKeys = Object.keys(doc.paths ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const p of pathKeys) {
    const pathItem = doc.paths[p];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (!op.operationId) {
        throw new Error(`Missing operationId for ${method.toUpperCase()} ${p}`);
      }
      operations.push({ path: p, method, operationId: op.operationId });
    }
  }

  // Stable secondary sort: path already sorted above; HTTP_METHODS order is
  // fixed, so iteration order is deterministic without an extra sort pass.

  const seen = new Set();
  for (const { operationId } of operations) {
    if (seen.has(operationId)) {
      throw new Error(`Duplicate operationId: ${operationId}`);
    }
    seen.add(operationId);
  }

  const entriesSrc = operations
    .map(
      ({ path: p, method, operationId }) =>
        `  { path: ${JSON.stringify(p)}, method: ${JSON.stringify(method)}, operationId: ${JSON.stringify(
          operationId
        )} },`
    )
    .join("\n");

  const out = `${BANNER}
/**
 * Flat, typed list of every (path, method, operationId) triple declared in
 * openapi.yaml. Consumed by the conformance walker (packages/contract, see
 * docs/PLAN.md §4.5) to assert 100% of contract paths are exercised by the
 * server test suite. Sorted by path, then by a fixed HTTP method order —
 * stable across regenerations for any given openapi.yaml.
 */
export interface ApiOperation {
  readonly path: string;
  readonly method: ${HTTP_METHODS.map((m) => JSON.stringify(m)).join(" | ")};
  readonly operationId: string;
}

export const API_OPERATIONS = [
${entriesSrc}
] as const satisfies readonly ApiOperation[];

export type ApiOperationId = (typeof API_OPERATIONS)[number]["operationId"];
`;

  return out;
}

async function main() {
  const doc = loadSpec();

  mkdirSync(SDK_GENERATED_DIR, { recursive: true });

  const typesOut = await generateTypes(doc);
  writeFileSync(path.join(SDK_GENERATED_DIR, "types.ts"), typesOut, "utf8");

  const pathsOut = generatePaths(doc);
  writeFileSync(path.join(SDK_GENERATED_DIR, "paths.ts"), pathsOut, "utf8");

  const opCount = (pathsOut.match(/operationId:/g) ?? []).length - 1; // -1 for the type union line's own use
  console.log(`[codegen] wrote ${path.relative(CONTRACT_ROOT, path.join(SDK_GENERATED_DIR, "types.ts"))}`);
  console.log(`[codegen] wrote ${path.relative(CONTRACT_ROOT, path.join(SDK_GENERATED_DIR, "paths.ts"))}`);
  console.log(`[codegen] ${opCount} operations`);
}

main().catch((err) => {
  console.error("[codegen] failed:", err);
  process.exitCode = 1;
});
