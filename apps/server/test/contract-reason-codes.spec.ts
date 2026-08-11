// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/contract-reason-codes.spec.ts
//
// Opus review finding A (2026-08-10, open-GOP HEVC leading-pictures strip
// wave): packages/contract/openapi.yaml's PlanReasonCode is a CLOSED enum
// ("Additions to the fixed list are contract PRs", docs/PLAYBACK.md §4) —
// but the engine shipped a new fixed reason code
// (open-gop-leading-pictures-stripped, packages/playback-engine/src/
// reasons.ts) without a matching contract PR, and nothing caught it. This
// spec closes that drift class: it parses openapi.yaml directly (no
// generated-SDK indirection — the SDK is itself generated FROM this file,
// so comparing against it would just re-check codegen, not the source of
// truth) and asserts the engine's two exported fixed reason-code lists
// (BLOCKING_REASON_CODES, FIXED_INFORMATIONAL_REASON_CODES) are EXACTLY the
// contract's closed enum members — in both directions, so a contract entry
// the engine never emits is caught too, not just the reverse.
//
// Pure / file-read-only (this package's test-execution rules): no NestJS
// bootstrap, no database, no I/O beyond reading two files already on disk.
// Deliberately dependency-light — `yaml` is already in the repo's
// dependency graph (packages/contract's own codegen.mjs and
// packages/playback-engine/matrix's case loader both parse the spec with
// it); added here as an apps/server devDependency purely to link it into
// this workspace's node_modules (pnpm's isolated linker doesn't hoist a
// transitive dep of @loombre/contract/@loombre/playback-engine into a
// sibling package by default).
//
// The two pattern-typed families (`hw-encoder-selected:<backend>`,
// `software-fallback:<cause>`) are NOT closed-enum members — the contract
// models them as regex patterns, and the engine's own types
// (HwEncoderSelectedReasonCode/SoftwareFallbackReasonCode) are template
// literal types with no runtime array to compare — so they're out of scope
// here by construction, exactly like the closed-enum-vs-pattern split in
// openapi.yaml's own `oneOf`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BLOCKING_REASON_CODES, FIXED_INFORMATIONAL_REASON_CODES } from "@loombre/playback-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(__dirname, "../../../packages/contract/openapi.yaml");

interface OpenApiDoc {
  components: {
    schemas: {
      PlanReasonCode: {
        oneOf: Array<{ type: string; enum?: string[]; pattern?: string }>;
      };
    };
  };
}

function loadClosedEnumMembers(): string[] {
  const raw = readFileSync(OPENAPI_PATH, "utf8");
  const doc = parse(raw) as OpenApiDoc;
  const closedMember = doc.components.schemas.PlanReasonCode.oneOf.find(
    (member) => Array.isArray(member.enum),
  );
  if (!closedMember?.enum) {
    throw new Error("contract-reason-codes.spec.ts: PlanReasonCode has no closed-enum oneOf member to compare against");
  }
  return closedMember.enum;
}

describe("contract PlanReasonCode enum vs engine reason-code lists (drift guard)", () => {
  const contractClosedCodes = loadClosedEnumMembers();
  const engineFixedCodes = [...BLOCKING_REASON_CODES, ...FIXED_INFORMATIONAL_REASON_CODES];

  it("every engine BLOCKING_REASON_CODES member is a contract enum member", () => {
    for (const code of BLOCKING_REASON_CODES) {
      expect(contractClosedCodes, `"${code}" is emitted by the engine but missing from packages/contract/openapi.yaml's PlanReasonCode enum`).toContain(code);
    }
  });

  it("every engine FIXED_INFORMATIONAL_REASON_CODES member is a contract enum member", () => {
    for (const code of FIXED_INFORMATIONAL_REASON_CODES) {
      expect(contractClosedCodes, `"${code}" is emitted by the engine but missing from packages/contract/openapi.yaml's PlanReasonCode enum`).toContain(code);
    }
  });

  it("every contract closed-enum member is a real engine reason code (no dead/aspirational contract entries)", () => {
    for (const code of contractClosedCodes) {
      expect(engineFixedCodes, `"${code}" is declared in the contract but no engine reasons.ts export emits it`).toContain(code);
    }
  });

  it("the two sets are exactly equal (no drift in either direction) and carry no accidental duplicates", () => {
    expect(new Set(engineFixedCodes).size).toBe(engineFixedCodes.length);
    expect(new Set(contractClosedCodes).size).toBe(contractClosedCodes.length);
    expect(new Set(engineFixedCodes)).toEqual(new Set(contractClosedCodes));
  });
});
