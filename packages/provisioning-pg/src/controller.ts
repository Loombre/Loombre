// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/controller.ts
//
// The shared surface apps/server's bootstrap seam programs against,
// whichever mode it ends up with — EmbeddedPostgres (supervisor.ts) or
// ExternalPostgresProvisioner (external.ts). `upgrade` is deliberately NOT
// part of this shared surface: it is an embedded-only operation invoked
// explicitly by boot-time orchestration when a major-version bump is
// detected, never called polymorphically.

import type { ProvisioningStatus } from "@loombre/provisioning";

export interface ProvisioningController {
  provision(): Promise<ProvisioningStatus>;
  start(): Promise<ProvisioningStatus>;
  stop(mode?: "smart" | "fast"): Promise<void>;
  getCurrentProvisioningStatus(): ProvisioningStatus;
  getDatabaseUrl(database?: string): string;
}
