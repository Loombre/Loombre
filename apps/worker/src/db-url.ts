// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/db-url.ts
//
// The worker's side of STATE.md P4.2's single-provisioner rule: this
// process NEVER provisions a database. Resolution order:
//
//   1. DATABASE_URL set               -> use it verbatim (external mode /
//                                        operator override — always wins).
//   2. LOOMBRE_DATA_DIR set           -> installed embedded mode: poll
//      (installers set it, dev doesn't)  @loombre/provisioning-pg's
//                                        discovery seam until apps/server's
//                                        provisioner has written the
//                                        superuser secret, then use the
//                                        reconstructed URL.
//   3. neither                        -> the dev-checkout compose fallback
//                                        (docker-compose.dev.yml's :5442),
//                                        byte-identical to the historical
//                                        default.
//
// The bounded poll (not infinite) is deliberate: on timeout the caller
// exits nonzero and the SERVICE MANAGER's restart policy governs the
// retry cadence — same posture as index.ts's waitForDatabaseReady.

import { resolveEmbeddedDatabaseUrl } from "@loombre/provisioning-pg";

export const DEV_FALLBACK_DATABASE_URL = "postgres://loombre:loombre@localhost:5442/loombre";

export interface WorkerDatabaseUrlEnv {
  DATABASE_URL?: string | undefined;
  LOOMBRE_DATA_DIR?: string | undefined;
  LOOMBRE_EMBEDDED_PG_PORT?: string | undefined;
}

export interface ResolveWorkerDatabaseUrlOptions {
  timeoutMs?: number;
  intervalMs?: number;
  log?: (message: string) => void;
}

export async function resolveWorkerDatabaseUrl(
  env: WorkerDatabaseUrlEnv,
  options: ResolveWorkerDatabaseUrlOptions = {},
): Promise<string> {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const dataDir = env.LOOMBRE_DATA_DIR?.trim();
  if (!dataDir) {
    return DEV_FALLBACK_DATABASE_URL;
  }

  const { timeoutMs = 120_000, intervalMs = 2_000, log = console.error } = options;
  const portEnv = env.LOOMBRE_EMBEDDED_PG_PORT?.trim();
  const port = portEnv ? Number.parseInt(portEnv, 10) : undefined;

  const deadline = Date.now() + timeoutMs;
  let waitingLogged = false;
  for (;;) {
    const url = await resolveEmbeddedDatabaseUrl(port === undefined ? { dataDir } : { dataDir, port });
    if (url !== null) {
      return url;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `worker: no embedded-database credentials appeared under '${dataDir}' within ${timeoutMs}ms. ` +
          "Single-provisioner rule (STATE.md P4.2): only apps/server provisions the embedded PostgreSQL — " +
          "start the Loombre server service first (it writes the credentials this worker discovers), " +
          "or set DATABASE_URL to an external PostgreSQL instance.",
      );
    }
    if (!waitingLogged) {
      log(
        `worker: waiting for the server's embedded-database credentials under '${dataDir}' ` +
          "(single-provisioner rule — apps/server writes them at first provision) …",
      );
      waitingLogged = true;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
}
