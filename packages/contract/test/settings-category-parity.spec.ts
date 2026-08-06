// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/settings-category-parity.spec.ts
//
// AUD-A8a-001 (audit fafa47f, Fix Wave 4): openapi.yaml's SettingsCategory
// enum drifted from packages/shared/src/settings-registry.ts's real
// SettingsCategory union — `stash` drifted once already (see this enum's
// own inline comment in openapi.yaml) and `remote` drifted a second time,
// silently, because nothing diffed the two closed sets against each other.
// This is that diff, made permanent: it reads openapi.yaml directly (not
// the generated SDK — the generated types are a mechanical function of the
// contract, so testing against them would only prove codegen works, not
// that the contract itself is complete) and compares it against every
// `category` value actually used by a live SETTINGS_REGISTRY entry.
//
// Both directions matter: a category used by the registry but absent from
// the contract means `GET /admin/settings/schema` returns a value the
// published contract declares impossible (this finding); a category
// declared by the contract but never used by any registry entry is a
// dead/aspirational enum member the contract should not be promising.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SETTINGS_REGISTRY } from "@loombre/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = "packages/contract/openapi.yaml";
const REGISTRY_FILE = "packages/shared/src/settings-registry.ts";

interface OpenApiDoc {
  components: {
    schemas: {
      SettingsCategory: { enum: string[] };
    };
  };
}

function loadContractSettingsCategoryEnum(): string[] {
  const raw = readFileSync(path.resolve(__dirname, "../openapi.yaml"), "utf8");
  const doc = YAML.parse(raw) as OpenApiDoc;
  const enumValues = doc.components?.schemas?.SettingsCategory?.enum;
  if (!Array.isArray(enumValues)) {
    throw new Error(`${CONTRACT_FILE} is missing components.schemas.SettingsCategory.enum`);
  }
  return enumValues;
}

describe("SettingsCategory parity (contract enum vs. live registry categories)", () => {
  it("every category used by a SETTINGS_REGISTRY entry is declared in openapi.yaml's SettingsCategory enum", () => {
    const contractEnum = new Set(loadContractSettingsCategoryEnum());
    const registryCategories = new Set(SETTINGS_REGISTRY.map((e) => e.category));

    const missingFromContract = [...registryCategories].filter((c) => !contractEnum.has(c)).sort();
    expect(
      missingFromContract,
      `categor${missingFromContract.length === 1 ? "y" : "ies"} used by ${REGISTRY_FILE} but absent from ${CONTRACT_FILE}'s SettingsCategory enum: ${missingFromContract.join(", ")}`,
    ).toEqual([]);
  });

  it("openapi.yaml's SettingsCategory enum declares no category unused by any live SETTINGS_REGISTRY entry", () => {
    const contractEnum = loadContractSettingsCategoryEnum();
    const registryCategories = new Set(SETTINGS_REGISTRY.map((e) => e.category));

    const unusedInRegistry = contractEnum.filter((c) => !registryCategories.has(c as (typeof SETTINGS_REGISTRY)[number]["category"]));
    expect(
      unusedInRegistry,
      `categor${unusedInRegistry.length === 1 ? "y" : "ies"} declared in ${CONTRACT_FILE}'s SettingsCategory enum but unused by any ${REGISTRY_FILE} entry: ${unusedInRegistry.join(", ")}`,
    ).toEqual([]);
  });

  it("the contract enum carries no duplicate entries (set semantics above would otherwise hide them)", () => {
    const contractEnum = loadContractSettingsCategoryEnum();
    expect(new Set(contractEnum).size, `duplicate entries in ${CONTRACT_FILE}'s SettingsCategory enum`).toBe(contractEnum.length);
  });
});
