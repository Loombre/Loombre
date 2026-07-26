// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/test/ajv-helper.ts — see
// packages/provisioning/test/ajv-helper.ts for the rationale.

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

export function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}
