// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/index.ts
//
// Public barrel for @loombre/plugin-protocol — the LPP v1 frozen wire
// contract. Consumers (lanes W2-W5: host core, both capability
// integrations, admin UI) import types/schemas/constants from this package
// root only; nothing under src/ is a private implementation detail apart
// from src/generate (build-time only, see package.json's "generate" script)
// and src/conform's CLI wiring (src/conform/cli.ts is a script entry point,
// not a library export — everything else in src/conform IS exported below
// for programmatic use, e.g. the integration test in test/).

export * from "./version.js";
export * from "./enums.js";
export * from "./json-schema-subset.js";
export * from "./headers.js";
export * from "./problem.js";
export * from "./signature.js";
export * from "./envelope.js";
export * from "./capabilities/index.js";

export * from "./conform/types.js";
export * from "./conform/run.js";
