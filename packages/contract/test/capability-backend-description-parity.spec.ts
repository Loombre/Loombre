// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/capability-backend-description-parity.spec.ts
//
// AUD-A8a-002 (audit fafa47f, Fix Wave 4): CapabilityBackend.name's
// description claims to mirror the DB CHECK on hw_capability_backends.backend
// ("closed set enforced by the DB CHECK, mirrored not re-enumerated here so
// a new backend is additive") but under-enumerated it — `amf` was live in
// the CHECK (and elsewhere in this same contract file, the
// hw-encoder-selected event-reason pattern) yet absent from this one prose
// list. `name` itself is `type: string` with no enum, so nothing validates
// this at request time; the only guard against the list rotting again is
// this test, diffing the description's parenthetical list against the real
// migration CHECK constraint.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = "packages/contract/openapi.yaml";
const MIGRATION_FILE = "packages/db/migrations/0011_hw_capability_snapshots.sql";

interface OpenApiDoc {
  components: {
    schemas: {
      CapabilityBackend: { properties: { name: { description: string } } };
    };
  };
}

function loadContractDescription(): string {
  const raw = readFileSync(path.resolve(__dirname, "../openapi.yaml"), "utf8");
  const doc = YAML.parse(raw) as OpenApiDoc;
  const description = doc.components?.schemas?.CapabilityBackend?.properties?.name?.description;
  if (typeof description !== "string") {
    throw new Error(`${CONTRACT_FILE} is missing components.schemas.CapabilityBackend.properties.name.description`);
  }
  return description;
}

/** Pulls the parenthesized, em-dash-terminated backend list out of the
 *  description prose, e.g. "(videotoolbox, nvenc, qsv — closed set..." ->
 *  ["videotoolbox", "nvenc", "qsv"]. */
function parseDescriptionBackendList(description: string): string[] {
  const match = description.match(/\(([^—]+)—/);
  if (!match) {
    throw new Error(`could not find a "(...list... —" backend list in the description: ${description}`);
  }
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadDbCheckBackends(): string[] {
  const raw = readFileSync(path.resolve(__dirname, "../../db/migrations/0011_hw_capability_snapshots.sql"), "utf8");
  const match = raw.match(/backend\s+IN\s*\(([^)]+)\)/);
  if (!match) {
    throw new Error(`could not find the "backend IN (...)" CHECK constraint in ${MIGRATION_FILE}`);
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter((s) => s.length > 0);
}

describe("CapabilityBackend.name description parity (contract prose vs. DB CHECK)", () => {
  it("lists every backend the DB CHECK on hw_capability_backends.backend allows", () => {
    const description = loadContractDescription();
    const described = new Set(parseDescriptionBackendList(description));
    const dbBackends = loadDbCheckBackends();

    const missingFromDescription = dbBackends.filter((b) => !described.has(b));
    expect(
      missingFromDescription,
      `backend${missingFromDescription.length === 1 ? "" : "s"} in ${MIGRATION_FILE}'s CHECK but absent from ${CONTRACT_FILE}'s CapabilityBackend.name description: ${missingFromDescription.join(", ")}`,
    ).toEqual([]);
  });

  it("names no backend the DB CHECK doesn't also allow (stale/aspirational entries)", () => {
    const description = loadContractDescription();
    const described = parseDescriptionBackendList(description);
    const dbBackends = new Set(loadDbCheckBackends());

    const staleInDescription = described.filter((b) => !dbBackends.has(b));
    expect(
      staleInDescription,
      `backend${staleInDescription.length === 1 ? "" : "s"} in ${CONTRACT_FILE}'s CapabilityBackend.name description but absent from ${MIGRATION_FILE}'s CHECK: ${staleInDescription.join(", ")}`,
    ).toEqual([]);
  });
});
