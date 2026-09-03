// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/transcode-admission.ts
//
// THE transcode admission gate (docs/PLAYBACK.md §9: "Concurrency: global
// semaphore = `maxSimultaneousTranscodes`; admission beyond it fails the
// session create with a typed 429"). §9 says semaphore, so it has to BE
// one: counting active transcode sessions and then inserting the new row
// as two independent awaits is a check-then-act race — two POSTs arriving
// together (two devices in a household, a client double-submit, two users)
// both read `activeCount < cap` before either has inserted, and both get
// in. On the Tier-0 default cap of 2 (resolve-policy.ts, SPF-8) that means
// three-plus concurrent ffmpeg pipelines on hardware sized for two, which
// is exactly the outcome this gate exists to prevent — and nothing
// downstream re-checks: apps/worker/src/transcode/config.ts documents that
// its own generous job concurrency is deliberate BECAUSE create-time
// admission is authoritative.
//
// So the count AND the insert run inside one critical section here,
// serialized against every other non-direct-play create in this process.
// Direct-play never enters the gate at all (§9: "direct-play sessions
// bypass all of this") — it occupies no slot and must not queue behind a
// transcode admission.
//
// SPF-9 admission-time reclamation: a request that meets the cap gets ONE
// chance, still inside this same critical section, to reclaim a slot from
// a viewer who paused and walked away (the optional `reclaim` callback —
// see TranscodeAdmissionRequest below) before it is refused. This never
// touches an ACTIVE session — only a heartbeat-suspended one is eligible
// at the packages/db layer — so the A5 law ("no setting/admission decision
// may drop an active playback session") holds exactly as before.
//
// Process-local, deliberately: the server ships as ONE Node process per
// instance (docker-compose.prod.yml's single `server` container running
// the image's default CMD, the bundled installers' single service; nothing
// forks or clusters it, and the worker never creates sessions). Were the
// server ever run multi-process against one database, this gate would have
// to move into packages/db as a `pg_advisory_xact_lock`-guarded
// count+insert transaction (the pattern query/identity.ts already uses for
// first-admin creation) — CLAUDE.md invariant 4 puts all locking SQL there,
// never in a controller.

export interface TranscodeAdmissionRequest<T> {
  /** Resolved `policy.maxSimultaneousTranscodes` for THIS request (Addendum A/A5: read fresh, at admission time). */
  cap: number;
  countActive: () => Promise<number>;
  create: () => Promise<T>;
  /**
   * SPF-9 admission-time reclamation: called ONLY when `countActive() >=
   * cap`, still inside this gate's serialized critical section. Should
   * attempt to end the single stalest heartbeat-suspended transcode
   * session (packages/db's evictStalestSuspendedTranscodeSession) and
   * resolve `true` if one was actually reclaimed, `false` otherwise
   * (nothing eligible). A `true` result triggers ONE recount — the gate
   * still only admits if the count is now below `cap`, never assumes the
   * reclaim alone was sufficient (a slower caller may have taken the freed
   * slot between the reclaim and the recount in theory, though in practice
   * nothing else creates sessions outside this same serialized chain).
   * Omitted entirely: behavior is identical to before SPF-9 (a request at
   * the cap is refused, no eviction attempted).
   */
  reclaim?: () => Promise<boolean>;
}

export type TranscodeAdmissionResult<T> = { admitted: true; created: T } | { admitted: false };

export class TranscodeAdmissionGate {
  /** Tail of the serialized chain; never rejects, so one failed admission cannot wedge the gate. */
  private tail: Promise<void> = Promise.resolve();

  async admit<T>(request: TranscodeAdmissionRequest<T>): Promise<TranscodeAdmissionResult<T>> {
    const attempt = this.tail.then(() => this.attempt(request));
    this.tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  private async attempt<T>(request: TranscodeAdmissionRequest<T>): Promise<TranscodeAdmissionResult<T>> {
    let activeCount = await request.countActive();
    if (activeCount >= request.cap && request.reclaim) {
      // Still inside the critical section: a concurrent admission cannot
      // observe a stale count between this reclaim and the recount below,
      // because nothing else in this process reaches the gate outside
      // `this.tail`'s serialized chain.
      const reclaimed = await request.reclaim();
      if (reclaimed) activeCount = await request.countActive();
    }
    if (activeCount >= request.cap) return { admitted: false };
    // Inside the critical section on purpose: the slot is only really taken
    // once the row exists, so the next admission must wait for the insert,
    // not just for the count.
    return { admitted: true, created: await request.create() };
  }
}

/**
 * One gate per server process — module-level rather than a Nest provider so
 * it stays a true process-wide semaphore even if something ever stands up a
 * second Nest application in-process (both would share the same database,
 * so they must share the same slot count).
 */
export const transcodeAdmissionGate = new TranscodeAdmissionGate();
