// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/crash/report.ts
//
// The redacted crash-report shape (task spec: "JSON: ts, version, platform,
// signal/error name+message+stack"). `kind` distinguishes the two trigger
// paths installGracefulShutdown/installCrashHandlers can hit: an unhandled
// JS exception (`error`) vs. a fatal OS signal this process chose to treat
// as a crash rather than a graceful stop (`signal` — reserved for a future
// caller; today's installCrashHandlers only ever produces `error` reports,
// since SIGTERM/SIGINT/SIGBREAK all take the GRACEFUL shutdown path in
// handlers.ts, not this one).

import { redactFreeText } from "./redact.js";

export interface CrashReportError {
  name: string;
  message: string;
  stack: string | null;
}

export interface CrashReport {
  ts: number;
  version: string;
  platform: NodeJS.Platform;
  kind: "error" | "signal";
  /** Present when kind === "error". */
  error?: CrashReportError;
  /** Present when kind === "signal". */
  signal?: string;
}

export interface BuildCrashReportOptions {
  nowMs: () => number;
  version: string;
  platform: NodeJS.Platform;
  dataDir: string;
}

function toErrorLike(reason: unknown): { name: string; message: string; stack: string | null } {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack ?? null };
  }
  // unhandledRejection can reject with any value at all (a string, a plain
  // object, undefined) — never assume it's an Error.
  return { name: "NonErrorRejection", message: String(reason), stack: null };
}

export function buildCrashReport(reason: unknown, opts: BuildCrashReportOptions): CrashReport {
  const raw = toErrorLike(reason);
  return {
    ts: opts.nowMs(),
    version: opts.version,
    platform: opts.platform,
    kind: "error",
    error: {
      name: redactFreeText(raw.name, opts.dataDir),
      message: redactFreeText(raw.message, opts.dataDir),
      stack: raw.stack === null ? null : redactFreeText(raw.stack, opts.dataDir),
    },
  };
}
