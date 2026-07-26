// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed probe-pipeline errors. A missing ffprobe/ffmpeg binary, a spawn
 * failure, a timeout, or malformed output are all ordinary, expected
 * conditions in a deployed system (P1.9 spirit: absence must be a clean,
 * reportable condition, never a crash at import time or an unhandled
 * rejection with an opaque stack). Every failure mode surfaces as one typed
 * class with a closed `code` discriminant, so callers can `if
 * (err instanceof ProbeError)` and branch on `err.code` instead of
 * string-matching messages.
 */

export type ProbeErrorCode =
  | "binary-not-found"
  | "spawn-failed"
  | "timeout"
  | "nonzero-exit"
  | "invalid-json"
  | "unsupported-container";

export class ProbeError extends Error {
  readonly code: ProbeErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ProbeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.details = details;
  }
}
