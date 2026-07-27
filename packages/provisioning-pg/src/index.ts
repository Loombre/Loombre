// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/index.ts — public package barrel.

export type { EmbeddedPgPlatform } from "./platform.js";
export { EMBEDDED_PG_PLATFORMS, resolveEmbeddedPgPlatform, isWindowsPlatform } from "./platform.js";

export type { VendorBinaryPaths } from "./vendor-layout.js";
export { resolveVendorBinaryPaths } from "./vendor-layout.js";

export type { VendorBinaries } from "./binaries.js";
export { resolveVendorBinaries } from "./binaries.js";

export { buildServerListenArgs, buildClientConnArgs, buildDatabaseUrl } from "./listen.js";
export { PG_HBA_CONTENTS } from "./hba.js";

export type { GeneratedSecret, SecretBackendImpl } from "./secret/types.js";
export { generateSecret, resolveSecret } from "./secret/resolve.js";
export { createFile0600Backend } from "./secret/file0600.js";

export {
  EMBEDDED_PG_DEFAULT_PORT,
  EMBEDDED_PG_SUPERUSER_USERNAME,
  EMBEDDED_PG_DEFAULT_DATABASE,
} from "./defaults.js";
export type { EmbeddedDiscoveryOptions } from "./discovery.js";
export { embeddedSuperuserSecretPath, resolveEmbeddedDatabaseUrl } from "./discovery.js";

export type { ControlDataProbeResult } from "./corruption.js";
export { classifyControlDataOutput, classifyStartupFailureLog, detectCorruption, formatCorruptDetail } from "./corruption.js";

export type { ProvisioningController } from "./controller.js";

export type {
  EmbeddedPostgresConfig,
  UpgradeOptions,
  UpgradeResult,
  UpgradeSpotCheck,
  UpgradeStepResult,
  SpotCheckResult,
} from "./supervisor.js";
export { EmbeddedPostgres } from "./supervisor.js";

export { externalProvisioningStatus, ExternalPostgresProvisioner } from "./external.js";

export {
  BinaryMissingError,
  BinaryExecutionError,
  ExternalModeInertError,
  UnsupportedSecretBackendError,
  UpgradeStepFailedError,
} from "./errors.js";

// Re-exported for callers' convenience — @loombre/provisioning-pg IS the
// implementation of this frozen contract, so a caller wiring it up should
// not also need a separate `@loombre/provisioning` import for the common
// case of constructing a ProvisioningRequest-shaped config.
export type {
  ListenStrategy,
  ProvisioningState,
  ProvisioningStatus,
  SecretBackend,
  SecretRef,
  UpgradePlan,
  UpgradeStep,
  CorruptionReason,
  CorruptionReport,
} from "@loombre/provisioning";
