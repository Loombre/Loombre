// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/test/ajv-helper.ts
//
// Not a test file itself (no .spec./.test. in the name — vitest will not
// collect it as a suite). Mirrors the Ajv construction convention already
// used at apps/server/src/common/device-profile-validator.ts (named import,
// allErrors + strict:false) so every fixture spec in this package validates
// the same way real server/worker code eventually will.

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

export function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}
