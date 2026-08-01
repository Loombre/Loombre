// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/errors.ts

/**
 * Thrown by openStashConnection (adapter.ts) when neither a direct
 * read-only open+read NOR the snapshot-copy fallback succeeded within
 * their retry budgets (S2) — e.g. the path does not exist, the volume is
 * unmounted, or the file remained locked past both budgets. Distinct from
 * S3's "unsupported schema" outcome (that one connects successfully and
 * disables deliberately); this one never got a readable connection at
 * all. Callers (connect.ts) map this to
 * library_stash_connections.status = 'unreachable'.
 */
export class StashConnectionUnavailableError extends Error {
  readonly path: string;
  readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`stash: could not open "${path}" (direct read-only open and snapshot-copy fallback both failed): ${causeMessage}`);
    this.name = 'StashConnectionUnavailableError';
    this.path = path;
    this.cause = cause;
  }
}
