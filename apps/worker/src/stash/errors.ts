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

  /**
   * `explanation` (optional) is prepended to the raw SQLite message when
   * that message would otherwise mislead the admin who reads it —
   * status_detail on library_stash_connections is shown verbatim in the
   * admin UI (FX1), so a bare SQLite string is a user-facing string. The
   * motivating case (R2 audit): opening a WAL-mode database whose
   * DIRECTORY is not writable reports "attempt to write a readonly
   * database", which reads as though Loombre tried to write the user's
   * Stash database — the precise opposite of S2's guarantee. See
   * adapter.ts's explainOpenFailure.
   */
  constructor(path: string, cause: unknown, explanation?: string) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const detail = explanation ? `${explanation} (SQLite reported: ${causeMessage})` : causeMessage;
    super(`stash: could not open "${path}" (direct read-only open and snapshot-copy fallback both failed): ${detail}`);
    this.name = 'StashConnectionUnavailableError';
    this.path = path;
    this.cause = cause;
  }
}
