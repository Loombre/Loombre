// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/heartbeat.ts
//
// Progress heartbeat scheduler shared by the video player and music mini
// player: PUT /progress/{itemId} every ~10s while playing, plus immediately
// on pause/seek/unload (docs/PLAYBACK.md §9: "the client progress PUT
// doubles as heartbeat"). Kept DOM-free and clock-injectable so it is
// testable with vi.useFakeTimers() without a real <video>/<audio> element.

export type ProgressState = "unplayed" | "in-progress" | "played";

export interface HeartbeatSnapshot {
  positionMs: number;
  durationMs: number | null;
  state: ProgressState;
}

export interface HeartbeatOptions {
  /** How often to send while actively playing. Default 10s (task spec). */
  intervalMs?: number;
  getSnapshot: () => HeartbeatSnapshot;
  send: (snapshot: HeartbeatSnapshot) => void;
  /** Injectable for tests; defaults to the real timer functions. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

/**
 * `sendBeacon`-style reliability on unload: `navigator.sendBeacon` cannot
 * carry a Bearer header (the progress endpoint needs auth), so this project
 * uses `fetch(..., { keepalive: true })` instead — it keeps the request
 * alive past page teardown same as sendBeacon while still allowing a
 * custom Authorization header. Exported so the caller (VideoPlayer /
 * MusicPlayerProvider) can wire the exact URL + token at unload time; this
 * module only provides the "on visibility/unload, flush now" plumbing.
 */
export class HeartbeatScheduler {
  private readonly intervalMs: number;
  private readonly getSnapshot: () => HeartbeatSnapshot;
  private readonly send: (snapshot: HeartbeatSnapshot) => void;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: HeartbeatOptions) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.getSnapshot = options.getSnapshot;
    this.send = options.send;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Starts the recurring interval. Does NOT send immediately — the caller
   *  already has an up-to-date snapshot at start time (e.g. right after
   *  resume/play begins) and a redundant zero-delay send would just be
   *  duplicate traffic; call `flushNow()` explicitly if an immediate send
   *  is actually wanted (e.g. right after a seek). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = this.setIntervalImpl(() => this.flushNow(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
  }

  /** Sends one heartbeat immediately with the current snapshot — used for
   *  pause/seek/unload per the task spec, in addition to the recurring
   *  interval. Safe to call whether or not the scheduler is running. */
  flushNow(): void {
    this.send(this.getSnapshot());
  }
}
