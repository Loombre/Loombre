// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/index.ts — public package barrel.

export { PROVISIONING_CONTRACT_VERSION } from "./contract-version.js";

export { ABSOLUTE_PATH_PATTERN } from "./absolute-path.js";

export type { SecretBackend, SecretRef } from "./secret-ref.js";
export { SECRET_BACKENDS, SECRET_REF_SCHEMA } from "./secret-ref.js";

export type { ListenStrategy } from "./listen-strategy.js";
export {
  LISTEN_STRATEGY_KINDS,
  LISTEN_STRATEGY_SCHEMA,
  LISTEN_STRATEGY_TCP_PORT_MIN,
  LISTEN_STRATEGY_TCP_PORT_MAX,
} from "./listen-strategy.js";

export type { ProvisioningRequest } from "./provisioning-request.js";
export {
  PG_FULL_VERSION_PATTERN,
  PROVISIONING_REQUEST_MIN_PG_MAJOR,
  PROVISIONING_REQUEST_SCHEMA,
} from "./provisioning-request.js";

export type { ProvisioningState, ProvisioningStatus } from "./provisioning-status.js";
export { PROVISIONING_STATES, PROVISIONING_STATUS_SCHEMA } from "./provisioning-status.js";

export type { UpgradeStep, UpgradePlan } from "./upgrade-plan.js";
export {
  UPGRADE_STEPS,
  UPGRADE_PLAN_VERSION_PATTERN,
  UPGRADE_PLAN_SCHEMA,
} from "./upgrade-plan.js";

export type { CorruptionReason, CorruptionReport } from "./corruption-report.js";
export { CORRUPTION_REASONS, CORRUPTION_REPORT_SCHEMA } from "./corruption-report.js";
