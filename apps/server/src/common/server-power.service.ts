// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/server-power.service.ts
//
// The seam between the admin REST power endpoints (POST /system/restart,
// POST /system/shutdown — catalog/admin.controller.ts) and actually
// killing the process. The controller only ever talks to this service;
// the REAL triggers are armed exclusively by main.ts's direct-entrypoint
// bootstrap (the same place installGracefulShutdown is wired), so every
// embedded context — conformance/e2e suites boot AppModule in-process and
// walk these endpoints with a live admin token — gets a 202 that
// deliberately triggers nothing instead of SIGTERMing the test runner.
// Mirrors the IPC listener's injectable `sendStopSignal` posture
// (ipc/listener.ts).
//
// Restart mechanics (why an exit CODE is the mechanism): every shipped
// supervisor restarts a non-zero exit — launchd KeepAlive
// SuccessfulExit=false (10s throttle), systemd Restart=on-failure (5s),
// the Windows service host mapping a non-zero child exit onto
// ERROR_PROCESS_ABORTED so SCM's recovery actions fire (10s), Docker
// restart:unless-stopped (any exit) — while a CLEAN exit stays down on
// all of them except Docker. RESTART_REQUESTED_EXIT_CODE exists so an
// intentional restart is distinguishable from a crash (exit 1) in
// supervisor logs; installers/windows/service-host LoombreHostedService
// logs it by name. Docker's exception is why shutdown is refused under
// container supervision (see isContainerSupervised).

import { Injectable } from "@nestjs/common";
import type { Response } from "express";

/** The named "this exit is an intentional restart request" code. Non-zero
 *  (every supervisor restarts non-zero) but deliberately NOT 1 (a crash /
 *  failed graceful shutdown), so `service exited with code 86` in launchd/
 *  systemd/service-host logs reads as the admin action it was. Kept in
 *  lockstep with installers/windows/service-host/LoombreServiceHost/
 *  LoombreHostedService.cs (RestartRequestedExitCode) and
 *  docs/ops/power-actions notes. */
export const RESTART_REQUESTED_EXIT_CODE = 86;

export type PowerAction = "restart" | "shutdown";

export interface PowerTriggers {
  /** Begin graceful teardown that ends in exit(RESTART_REQUESTED_EXIT_CODE). */
  restart(): void;
  /** Begin graceful teardown that ends in exit(0) — the stays-down exit. */
  shutdown(): void;
}

@Injectable()
export class ServerPowerService {
  private triggers: PowerTriggers | null = null;

  /** Called once from main.ts after bootstrap. Never called in embedded/
   *  test contexts — that absence IS the test seam. */
  arm(triggers: PowerTriggers): void {
    this.triggers = triggers;
  }

  /** True when the deployment's supervisor restarts the process regardless
   *  of exit code, making an in-process "shutdown" a lie — the shipped
   *  Docker image (Dockerfile runtime stage) sets LOOMBRE_SUPERVISOR=
   *  container precisely so this endpoint can refuse honestly (409)
   *  instead of exiting into an immediate supervisor restart. Read at call
   *  time, not construction, so tests can set/unset the env around a
   *  booted app (LOOMBRE_UPDATE_CHECK precedent, conformance.spec.ts). */
  isContainerSupervised(): boolean {
    return process.env["LOOMBRE_SUPERVISOR"] === "container";
  }

  /** Fires the action only after the 202 has actually been flushed to the
   *  socket (`finish`), so the caller reliably sees the response before
   *  teardown starts — the exact ordering contract handleServerStop pins
   *  in ipc/listener.ts. Unarmed (embedded/test context): logs and does
   *  nothing. */
  scheduleAfterResponse(res: Response, action: PowerAction, requestedBy: string): void {
    res.once("finish", () => {
      if (this.triggers === null) {
        console.log(
          `power: ${action} requested by ${requestedBy} but no triggers are armed (embedded/test context) — no-op`,
        );
        return;
      }
      console.log(`power: ${action} requested by ${requestedBy} over the admin API — beginning graceful ${action}`);
      this.triggers[action]();
    });
  }
}
