// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/test/ajv-helper.ts — see
// packages/provisioning/test/ajv-helper.ts for the rationale; identical
// pattern, duplicated rather than shared because these are two independent
// leaf packages and neither should depend on the other's test/ tree.

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

export function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}
