// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/crash/handlers.ts
//
// The two process-level concerns STATE.md P4.14 groups together:
//   - installCrashHandlers: uncaughtException/unhandledRejection -> a
//     redacted local crash file, then a clean exit(1). "Clean" means we
//     never let Node's own default handler print the RAW (unredacted)
//     stack to stderr afterward — process.exit() inside the listener
//     suppresses that.
//   - installGracefulShutdown: SIGTERM/SIGINT always, SIGBREAK on win32
//     only (Node documents SIGBREAK as Windows-specific — process.on never
//     fires it on POSIX, so registering it unconditionally would be a
//     silent no-op there; gating explicitly documents the intent instead
//     of relying on that platform quirk implicitly). This is the missing
//     half of installers/windows/service-host's CTRL_BREAK_EVENT mechanism
//     (that C#'s own header names this exact gap) — until this handler
//     existed, apps/server had NO signal handling at all, so every stop on
//     every platform hit the timeout-then-kill fallback.
//
// Both are exported separately (not one combined installProcessHandlers())
// because main.ts's TLS branch needs `closeServer` to exist (built from
// bootstrap()'s return value) BEFORE graceful-shutdown handlers can be
// registered, while crash handlers should be installed as early as
// possible — before bootstrapProvisioning() even runs, so a crash during
// boot itself still produces a crash file.

import { buildCrashReport } from "./report.js";
import { writeCrashReport } from "./writer.js";

export interface InstallCrashHandlersOptions {
  dataDir: string;
  version: string;
  /** Log-line prefix only — "@loombre/server" or "@loombre/worker". Purely
   *  cosmetic (which process a shared operator log stream is talking about). */
  processName?: string;
  nowMs?: () => number;
  platform?: NodeJS.Platform;
  /** Test seam — defaults to console.error. */
  log?: (message: string) => void;
  /** Test seam — defaults to process.exit. Real callers never override this. */
  exit?: (code: number) => void;
}

/** Registers uncaughtException/unhandledRejection handlers that write a
 *  redacted crash file then exit(1). Idempotent-safe to call once per
 *  process (main.ts calls it exactly once, at the very top of the direct-
 *  entrypoint branch). */
export function installCrashHandlers(opts: InstallCrashHandlersOptions): void {
  const nowMs = opts.nowMs ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const processName = opts.processName ?? "@loombre";
  const log = opts.log ?? ((message: string) => console.error(message));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const onFatal = (reason: unknown, source: "uncaughtException" | "unhandledRejection"): void => {
    const report = buildCrashReport(reason, { nowMs, version: opts.version, platform, dataDir: opts.dataDir });
    let writtenPath: string | null = null;
    try {
      writtenPath = writeCrashReport(opts.dataDir, report);
    } catch (writeErr) {
      log(`${processName}: FAILED to write crash report for ${source} (${String(writeErr)}) — crashing anyway.`);
    }
    log(
      `${processName}: fatal ${source} — ${report.error?.name ?? "unknown"}: ${report.error?.message ?? ""}` +
        (writtenPath ? ` (redacted report: ${writtenPath})` : ""),
    );
    exit(1);
  };

  process.on("uncaughtException", (err) => onFatal(err, "uncaughtException"));
  process.on("unhandledRejection", (reason) => onFatal(reason, "unhandledRejection"));
}

export type ShutdownSignal = "SIGTERM" | "SIGINT" | "SIGBREAK";

export interface InstallGracefulShutdownOptions {
  /** Performs the actual work (close http server, end the DB pool, stop
   *  embedded provisioning, ...) — main.ts supplies this from bootstrap()'s
   *  return value. Must resolve once shutdown is complete. */
  onShutdown: (signal: ShutdownSignal) => Promise<void>;
  /** Upper bound on how long onShutdown may take before this module gives
   *  up waiting and exits anyway — a hung shutdown must never hang the
   *  process forever (the Windows service host's own GracefulStopTimeoutMs
   *  is the outer safety net; this is an inner one so a plain `kill -TERM`
   *  on macOS/Linux gets the same bounded behavior). */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  processName?: string;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Registers SIGTERM/SIGINT (every platform) and SIGBREAK (win32 only —
 *  Node never emits it elsewhere) to run `onShutdown` exactly once, then
 *  exit(0) on success or exit(1) on failure/timeout. A second signal while
 *  shutdown is already in flight is ignored (not re-entered, not escalated
 *  — an operator holding Ctrl+C is not this module's problem to solve). */
export function installGracefulShutdown(opts: InstallGracefulShutdownOptions): void {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const processName = opts.processName ?? "@loombre";
  const log = opts.log ?? ((message: string) => console.log(message));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;

  const handle = (signal: ShutdownSignal): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${processName}: received ${signal}, shutting down gracefully (timeout ${timeoutMs}ms)`);

    const timeout = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), timeoutMs);
      t.unref();
    });

    Promise.race([opts.onShutdown(signal).then(() => "done" as const), timeout])
      .then((outcome) => {
        if (outcome === "timeout") {
          log(`${processName}: graceful shutdown exceeded ${timeoutMs}ms — exiting anyway.`);
          exit(1);
          return;
        }
        log(`${processName}: graceful shutdown complete.`);
        exit(0);
      })
      .catch((err: unknown) => {
        log(`${processName}: graceful shutdown failed: ${String(err)}`);
        exit(1);
      });
  };

  process.on("SIGTERM", () => handle("SIGTERM"));
  process.on("SIGINT", () => handle("SIGINT"));
  if (platform === "win32") {
    process.on("SIGBREAK", () => handle("SIGBREAK"));
  }
}
