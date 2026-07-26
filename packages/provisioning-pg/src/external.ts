// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/external.ts
//
// External-PG mode (D1 "external PG via env var" — DATABASE_URL set):
// every mutating call is inert + throws a typed error, proven both
// directions in test/external.spec.ts. getCurrentProvisioningStatus()
// always reports 'external' (never inferred from an absent dataDir — see
// @loombre/provisioning's provisioning-status.ts header for why that
// distinction matters) and getDatabaseUrl() is a pure passthrough of the
// caller-supplied DATABASE_URL (a read, not a mutation — never inert).

import type { ProvisioningStatus } from "@loombre/provisioning";
import { ExternalModeInertError } from "./errors.js";
import type { ProvisioningController } from "./controller.js";

export function externalProvisioningStatus(): ProvisioningStatus {
  return { state: "external", pgVersion: null, dataDir: null, lastCheckMs: Date.now() };
}

export class ExternalPostgresProvisioner implements ProvisioningController {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  async provision(): Promise<ProvisioningStatus> {
    throw new ExternalModeInertError("provision");
  }

  async start(): Promise<ProvisioningStatus> {
    throw new ExternalModeInertError("start");
  }

  async stop(): Promise<void> {
    throw new ExternalModeInertError("stop");
  }

  getCurrentProvisioningStatus(): ProvisioningStatus {
    return externalProvisioningStatus();
  }

  getDatabaseUrl(): string {
    return this.databaseUrl;
  }
}
