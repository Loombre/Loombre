// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/backends.ts
//
// The single choke-point every caller in this package uses to get a
// SecretBackendImpl — mirrors packages/provisioning-pg/src/secret/
// resolve.ts's backendFor() shape, extended to all four SecretBackend
// members instead of just 'file0600'.

import type { SecretBackend } from "@loombre/provisioning";
import type { SecretBackendImpl } from "./types.js";
import { createFile0600Backend } from "./file0600.js";
import { createNativeKeyringBackend } from "./native-keyring.js";

export function backendFor(backend: SecretBackend, platform: NodeJS.Platform = process.platform): SecretBackendImpl {
  if (backend === "file0600") return createFile0600Backend();
  return createNativeKeyringBackend(backend, platform);
}
