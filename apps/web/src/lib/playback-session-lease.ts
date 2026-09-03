// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-session-lease.ts
//
// gap-F1: keyed, refcounted leases over in-flight POST /playback/sessions
// creates, so React dev StrictMode's effect double-invoke (setup #1 →
// cleanup #1 → setup #2, all synchronous within one commit — long before
// any POST can settle) SHARES one create instead of racing two.
//
// Why the old per-invocation `cancelled` flag was not enough: cleanup for
// invocation #1 always fires before either POST resolves, so `cancelled`
// was deterministically true for twin #1 and false for twin #2 —
// INDEPENDENT of which POST actually won the transcode slot. With
// maxSimultaneousTranscodes = 1 (the shipped default), when twin #1's
// POST took the slot (201) and twin #2's 429'd, the surviving mount
// rendered "Server is at capacity" while twin #1's cancelled-branch
// DELETEd the winning session — every transcode item 429'd with zero real
// load. With slots >= 2 the extra 201 leaked under mount/unmount churn.
//
// The lease model closes both holes:
// - `acquire(key, create)` joins an existing in-flight create for the same
//   key (one POST per mount, StrictMode or not) or starts a new one.
// - `adopt()` marks the result as consumed into component state — session
//   lifecycle ownership moves to the caller (its unmount path DELETEs it);
//   the pool will never end an adopted session.
// - `release()` (effect cleanup) drops this holder. When the LAST holder
//   is gone and nobody adopted, the pool ends the session — at settle time
//   if the create is still in flight (AUD-A4v4-003's orphan case), or
//   immediately if it already settled (closes the microtask window where
//   an unmount lands between the create settling and the holder's `await`
//   resuming — the holder sees `cancelled` and consumes nothing, so the
//   release itself must clean up).
// - A settled entry leaves the key map at once: a session delivered to a
//   holder is that component's to end; the next mount for the same item
//   gets a FRESH create, never a dead session.
//
// The pool is deliberately generic + dependency-injected (idOf/end) so its
// full scenario matrix is unit-testable with zero I/O and zero mocking
// (see playback-session-lease.test.ts; same pattern as relocation-nudge).
// The bound singleton below is the one the video player uses.

import { endPlaybackSession, type CreateSessionResult } from "./playback-session.js";

export interface SessionLease<T> {
  /** Settles with the shared create's result — the same promise for every
   *  lease joined to the same in-flight create. */
  promise: Promise<T>;
  /** The holder consumed an ok result into component state; the pool will
   *  never end this session itself (the caller's unmount path owns it). */
  adopt(): void;
  /** This holder is gone (effect cleanup). Idempotent per lease. */
  release(): void;
}

export interface SessionLeasePool<T> {
  acquire(key: string, create: () => Promise<T>): SessionLease<T>;
  /** Test-isolation hook: forget every entry AND disown in-flight creates
   *  (their settle handlers become no-ops — no orphan-end fires across a
   *  reset boundary, so one test's unresolved create can never call a
   *  later test's `end`). */
  reset(): void;
}

interface LeaseEntry<T> {
  promise: Promise<T>;
  refs: number;
  settled: boolean;
  sessionId: string | null;
  adopted: boolean;
  gen: number;
}

export function createSessionLeasePool<T>(config: {
  /** The created session's id when the result carries a live server row
   *  to clean up, null otherwise (a refusal has nothing to end). */
  idOf(result: T): string | null;
  /** Ends an orphaned session (fire-and-forget, best-effort). */
  end(sessionId: string): void;
}): SessionLeasePool<T> {
  const entries = new Map<string, LeaseEntry<T>>();
  let gen = 0;

  /** Ends the entry's session iff it settled ok, nobody holds or adopted
   *  it, and the pool hasn't been reset since it was created. Nulls the id
   *  so the end can fire at most once per entry. */
  function endIfOrphaned(entry: LeaseEntry<T>): void {
    if (entry.gen !== gen) return;
    if (!entry.settled || entry.adopted || entry.refs > 0) return;
    const id = entry.sessionId;
    if (id === null) return;
    entry.sessionId = null;
    config.end(id);
  }

  return {
    acquire(key, create) {
      let entry = entries.get(key);
      if (!entry) {
        const fresh: LeaseEntry<T> = {
          promise: undefined as unknown as Promise<T>,
          refs: 0,
          settled: false,
          sessionId: null,
          adopted: false,
          gen,
        };
        fresh.promise = create().then(
          (result) => {
            if (entries.get(key) === fresh) entries.delete(key);
            fresh.settled = true;
            fresh.sessionId = config.idOf(result);
            endIfOrphaned(fresh);
            return result;
          },
          (err: unknown) => {
            if (entries.get(key) === fresh) entries.delete(key);
            fresh.settled = true;
            throw err;
          },
        );
        entries.set(key, fresh);
        entry = fresh;
      }
      entry.refs += 1;
      const held = entry;
      let released = false;
      return {
        promise: held.promise,
        adopt() {
          held.adopted = true;
        },
        release() {
          if (released) return;
          released = true;
          held.refs -= 1;
          endIfOrphaned(held);
        },
      };
    },
    reset() {
      gen += 1;
      entries.clear();
    },
  };
}

// ── The player's bound singleton ─────────────────────────────────────────
// Module-scope on purpose: StrictMode twins are one component instance,
// but rapid unmount/remount churn (route bounces) creates NEW instances
// whose creates must also join/clean up coherently — a useRef pool would
// only cover the twins.

const playbackSessionLeases = createSessionLeasePool<CreateSessionResult>({
  idOf: (result) => (result.ok ? result.session.id : null),
  end: (sessionId) => {
    void endPlaybackSession(sessionId);
  },
});

/** One create per (item, pinned media file) — `startMs` is deliberately
 *  NOT part of the key: a deep-link offset changes where playback starts,
 *  not which session the server should mint. */
export function playbackSessionLeaseKey(itemId: string, mediaFileId?: string, subtitleStreamIndex?: number | null): string {
  // d3-aq3 (verify/gap-F1): the separator is a NUL *escape*, never a raw
  // NUL byte. Written literally, `.gitattributes` (`* text=auto`) detects
  // the file as BINARY: this whole module landed with no reviewable diff,
  // no blame, and invisible to `git grep` and every grep gate. The
  // character itself is still the right separator (it cannot occur in a
  // UUID, so no two distinct pairs can collide) — only its spelling
  // changes; scripts/grep-gates.mjs pass (d) now fails any raw NUL byte in
  // tracked source.
  // A subtitle pin (PlanRequest.selection.subtitleStreamIndex) mints a
  // DIFFERENT session: the pinned re-create must never join the unpinned
  // session's still-in-flight create. No pin (undefined/null) keeps the
  // pre-pin key byte-for-byte; same escaped-NUL separator as above.
  const pin = subtitleStreamIndex === undefined || subtitleStreamIndex === null ? "" : `\u0000sub:${subtitleStreamIndex}`;
  return `${itemId}\u0000${mediaFileId ?? ""}${pin}`;
}

export function acquirePlaybackSessionLease(
  key: string,
  create: () => Promise<CreateSessionResult>,
): SessionLease<CreateSessionResult> {
  return playbackSessionLeases.acquire(key, create);
}

/** Test-isolation hook (component suites): see SessionLeasePool.reset. */
export function resetPlaybackSessionLeases(): void {
  playbackSessionLeases.reset();
}
