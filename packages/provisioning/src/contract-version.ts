// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/contract-version.ts
//
// Version of the ProvisioningInterface contract itself — distinct from the
// pinned PostgreSQL version carried inside a ProvisioningRequest, and from
// this package's own package.json semver. Bump this on any breaking change
// to a type/schema in this package; callers on either side of the seam
// (installer lanes I1-I4 <-> the embedded-PG lane B) can compare it to
// detect drift, the same way @loombre/controller-ipc's
// CONTROLLER_IPC_CONTRACT_VERSION lets a newer controller detect an older
// server.

export const PROVISIONING_CONTRACT_VERSION = 1 as const;
