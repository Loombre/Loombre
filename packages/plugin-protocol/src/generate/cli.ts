#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/generate/cli.ts
//
// `pnpm --filter @loombre/plugin-protocol run generate` — regenerates
// spec/lpp-v1.md and spec/schemas/lpp-v1.schemas.json from src/. Run this
// after any change to a schema in src/ and commit the result; the drift
// tests (test/json-schema-drift.spec.ts, test/spec-doc-drift.spec.ts) fail
// CI if the committed artifacts disagree with a fresh run of this script.

import { writeLppGeneratedArtifacts, LPP_JSON_SCHEMA_PATH, LPP_SPEC_MARKDOWN_PATH } from "./write.js";

writeLppGeneratedArtifacts();
console.log(`generated ${LPP_SPEC_MARKDOWN_PATH}`);
console.log(`generated ${LPP_JSON_SCHEMA_PATH}`);
