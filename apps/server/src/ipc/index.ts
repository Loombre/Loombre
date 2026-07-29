// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/index.ts
//
// The one seam apps/server/src/main.ts wires in — deliverable 2 ("starts
// with the server, after listen"). Everything else in this directory is
// framework-agnostic (listener.ts takes plain IpcListenerDeps); this file
// is the thin NestJS-specific adapter that supplies those deps from a live
// INestApplication, plus the LOOMBRE_IPC_DISABLED / LOOMBRE_DATA_DIR
// kill-switch check (env.ts).
//
// main.ts's own edit stays to exactly one import + one call:
//   import { wireServerIpc } from "./ipc/index.js";
//   ...
//   await wireServerIpc(app, { serverPort: boundPort, serverTlsMode: tlsConfig.mode });

import type { INestApplication } from "@nestjs/common";
import { getWorkerLiveness, listJobsAdmin } from "@loombre/db";
import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import type { ProvisioningStatus } from "@loombre/provisioning";
import { resolveAppPaths } from "../cli/app-paths.js";
import { getProvisioningController } from "../bootstrap/provisioning.js";
import { DbProvider } from "../common/db.provider.js";
import type { TlsMode } from "../tls/config.js";
import { resolveIpcEnablement } from "./env.js";
import { IpcListener, type IpcListenerDeps, type IpcListenerHandle } from "./listener.js";
import type { RecentJobSignal } from "./worker-liveness.js";

export interface WireServerIpcOptions {
  /** The MAIN server's own already-bound HTTP(S) port (not this listener's
   *  own separate ephemeral port) — passed straight through to
   *  web-url.ts's fallback resolution. */
  serverPort: number;
  serverTlsMode: TlsMode;
}

/** Defensive fallback for the (should-not-happen-in-production — real
 *  main.ts always calls bootstrapProvisioning() before wireServerIpc, see
 *  main.ts's bootstrap() ordering — but real in tests / any future
 *  entrypoint that skips it) case where getProvisioningController() is
 *  still null. Orchestrator instruction: "'external' fallback" — reports
 *  state:'external' (@loombre/provisioning's own "Loombre does not manage
 *  this database" state, pgVersion/dataDir both null exactly as that state
 *  requires) rather than 'absent'. NOTE this is a deliberate instruction-
 *  literal choice over this lane's own first-pass reasoning ('absent' —
 *  "provisioning genuinely has not run" — reads as the more semantically
 *  precise member per provisioning-status.ts's own doc comment
 *  distinguishing the two); flagged in this lane's report since it's
 *  unreachable in the real production boot path either way (bootstrap()
 *  order guarantees the controller is already set by the time this ever
 *  runs), so the choice is low-stakes but worth a second look. */
function fallbackProvisioningStatus(): ProvisioningStatus {
  return {
    state: "external",
    pgVersion: null,
    dataDir: null,
    lastCheckMs: Date.now(),
    detail: "bootstrapProvisioning() has not run in this process yet.",
  };
}

/**
 * Starts the IPC listener if enabled (env.ts's kill-switch), else no-ops
 * (returns null) — always logs WHY either way. Call once, after the main
 * server has started listening.
 */
export async function wireServerIpc(
  app: INestApplication,
  opts: WireServerIpcOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IpcListenerHandle | null> {
  const enablement = resolveIpcEnablement(env);
  console.log(`ipc: ${enablement.reason}`);
  if (!enablement.enabled) return null;

  const { dataDir } = resolveAppPaths(process.platform, env);
  const dbProvider = app.get(DbProvider);

  const listener = new IpcListener({
    env,
    dataDir,
    serverPort: opts.serverPort,
    serverTlsMode: opts.serverTlsMode,
    // LOOMBRE_VERSION_FULL (not the bare LOOMBRE_VERSION) — matches
    // packages/controller-ipc/src/process-info.ts's OWN doc comment on
    // ProcessInfo.version ("P4.11: single-sourced from package.json"),
    // which is exactly LOOMBRE_VERSION_FULL's definition (STATE.md P4.11 /
    // packages/shared/src/version.ts), and mirrors GET /system/info's
    // existing "version" field (admin.controller.ts) — the closest
    // existing precedent for "the version to show for this running
    // instance". Flagged in this lane's report either way, since the
    // dispatch brief's own wording named LOOMBRE_VERSION.
    version: LOOMBRE_VERSION_FULL,
    getProvisioningStatus: () => getProvisioningController()?.getCurrentProvisioningStatus() ?? fallbackProvisioningStatus(),
    listRecentJobs: async (): Promise<RecentJobSignal[]> => {
      const page = await listJobsAdmin(dbProvider.db, { limit: 20 });
      return page.rows.map((row) => ({ status: row.status, updatedAtMs: row.updated_at_ms }));
    },
    // Primary worker signal. See packages/db/src/query/worker-liveness.ts
    // for why this reads pg_stat_activity rather than a heartbeat file or
    // the job ledger.
    getWorkerLiveness: () => getWorkerLiveness(dbProvider.db),
  });

  return listener.start();
}

export { IpcListener, type IpcListenerDeps, type IpcListenerHandle };
export { resolveIpcEnablement } from "./env.js";
