// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/error-log-throttle.ts
//
// pg-boss emits one 'error' per failed poll — every couple of seconds —
// for as long as its database is unreachable. On the native Linux
// installs that is exactly what happens while the server (which hosts
// the embedded PostgreSQL) is stopped from the tray: the worker stays up,
// waits, and reconnects when the server returns, and without this the
// worker log filled with an identical stack trace every 2s the whole
// time. Same shape as any log-storm guard: the first occurrence prints in
// full, identical repeats within the window are counted, and the count
// is reported when the message changes or the window elapses.

export interface ErrorLogThrottle {
  /** Returns the line(s) to log for this error, or null to stay silent. */
  record(err: unknown, nowMs: number): string | null;
}

export interface ErrorLogThrottleOptions {
  /** Repeats of the SAME message inside this window are counted, not logged. */
  windowMs?: number;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function createErrorLogThrottle(options: ErrorLogThrottleOptions = {}): ErrorLogThrottle {
  const windowMs = options.windowMs ?? 60_000;
  let lastMessage: string | null = null;
  let lastLoggedAtMs = 0;
  let suppressed = 0;

  return {
    record(err, nowMs) {
      const message = messageOf(err);
      const sameAsLast = message === lastMessage;
      if (sameAsLast && nowMs - lastLoggedAtMs < windowMs) {
        suppressed += 1;
        return null;
      }
      const prefix = suppressed > 0 ? `(previous error repeated ${suppressed} more time${suppressed === 1 ? '' : 's'}) ` : '';
      suppressed = 0;
      lastMessage = message;
      lastLoggedAtMs = nowMs;
      return `${prefix}${message}`;
    },
  };
}
