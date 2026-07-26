// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/featured-rotation.ts
//
// Featured-banner rotation state machine (design/phosphor/README.md
// §Screens -> Home + the rotation-spec paragraph): "7s dwell, 260ms
// crossfade on two stacked layers ... pauses on pointer hover and while
// the player, any modal, any bottom sheet, or the command palette is
// open ... manual dots+arrows ... resetting the dwell timer ... hide the
// whole control cluster when the pool has one item ... reduced-motion
// disables auto-advance keeping the dots."
//
// Kept DOM-free and clock-injectable, same pattern as lib/heartbeat.ts's
// HeartbeatScheduler — testable with vi.useFakeTimers(), no React/DOM
// required. `previousIndex`/`crossfading` exist specifically so the
// component can render TWO stacked layers (old index + new index) and
// cross-FADE opacity between them, per the README's explicit "the artwork
// is a gradient/image, so it cannot be transitioned in place — fade two
// stacked layers" instruction (a single element re-pointed at new content
// cannot crossfade).
//
// Ground-truthed open-state signals this lane found (see the freeze
// report for the full ledger): pointer hover is handled by the caller
// (setHoverPaused); the music mini-player's queue drawer is a REAL,
// already-exported global signal (MusicPlayerProvider's queueDrawerOpen)
// wired in as one of the "overlay paused" reasons via setOverlayPaused.
// There is no cross-cutting "any modal/sheet is open" registry anywhere in
// this codebase today (every BottomSheet/SheetOrModal/Modal/PinModal
// manages its own open boolean locally) and no command palette exists yet
// at all (⌘K is unimplemented) — both are real gaps, not this lane's to
// invent a global registry for (that would mean editing shell/player
// files this lane is explicitly barred from touching). "Player open" is
// structurally moot for Home specifically: /watch/{id} is a full route
// navigation away from /home, so Home (and this scheduler) unmounts
// entirely while the player is open — there is nothing to pause.

export interface FeaturedRotationSnapshot {
  activeIndex: number;
  /** The index that was active immediately before this one — null only
   *  until the FIRST transition ever happens. Deliberately never reset
   *  back to null afterwards (even once `crossfading` finishes): the
   *  component keys its "outgoing" stacked layer on this value, and
   *  clearing it would unmount that layer mid-fade (or on every idle
   *  render) instead of just letting its opacity settle at 0 between
   *  fades. `crossfading` alone is the signal for whether that layer
   *  should currently be visible. */
  previousIndex: number | null;
  crossfading: boolean;
}

export interface FeaturedRotationOptions {
  poolLength: number;
  /** Auto-advance dwell time. Default 7000ms (README: "7s dwell"). */
  dwellMs?: number;
  /** Crossfade duration. Default 260ms (README: "260ms opacity crossfade"). */
  crossfadeMs?: number;
  onChange: (snapshot: FeaturedRotationSnapshot) => void;
  /** Injectable for tests; default to the real timer functions. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export class FeaturedRotationScheduler {
  private poolLength: number;
  private readonly dwellMs: number;
  private readonly crossfadeMs: number;
  private readonly onChange: (snapshot: FeaturedRotationSnapshot) => void;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  private activeIndex = 0;
  private previousIndex: number | null = null;
  private crossfading = false;

  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;

  private started = false;
  private hoverPaused = false;
  private overlayPaused = false;
  private reducedMotion = false;

  constructor(options: FeaturedRotationOptions) {
    this.poolLength = options.poolLength;
    this.dwellMs = options.dwellMs ?? 7000;
    this.crossfadeMs = options.crossfadeMs ?? 260;
    this.onChange = options.onChange;
    // BUG (Phosphor W3 fidelity-audit finding): `setTimeout`/`clearTimeout`
    // referenced bare are UNBOUND function values. jsdom's implementation
    // doesn't care what `this` is when they're invoked, so all 48 tests in
    // featured-rotation.test.ts passed even with the bug in place — but a
    // real browser's `window.setTimeout`/`window.clearTimeout` are native
    // functions whose spec requires them to be called with `this ===
    // window` (or at least a Window-branded receiver); called with any
    // other receiver (or none, e.g. `const t = window.setTimeout; t(fn,
    // ms)`, which is exactly what happens once the bare global reference
    // is stored on `this.setTimeoutImpl` and invoked as
    // `this.setTimeoutImpl(...)` — the receiver is `this` scheduler
    // instance, not `window`) throws "Illegal invocation" in real Chrome/
    // Firefox/Safari. Binding to globalThis at capture time fixes it for
    // both the default AND any caller-supplied real-timer function
    // reference (test doubles that pass a plain arrow/closure are
    // unaffected either way, since those never carry a `this` requirement).
    this.setTimeoutImpl = (options.setTimeoutImpl ?? setTimeout).bind(globalThis);
    this.clearTimeoutImpl = (options.clearTimeoutImpl ?? clearTimeout).bind(globalThis);
  }

  getSnapshot(): FeaturedRotationSnapshot {
    return { activeIndex: this.activeIndex, previousIndex: this.previousIndex, crossfading: this.crossfading };
  }

  /** README: "Hide the whole control cluster when the pool has one item" —
   *  exposed so the component's render can gate the dot/arrow cluster off
   *  this SAME source of truth rather than re-deriving it. */
  isControlClusterVisible(): boolean {
    return this.poolLength > 1;
  }

  /** Whichever reasons currently hold the dwell timer paused — pool<=1 and
   *  prefers-reduced-motion both permanently suppress auto-advance (the
   *  dots stay manually operable either way; see next()/prev()/jumpTo()). */
  private dwellSuppressed(): boolean {
    return this.poolLength <= 1 || this.hoverPaused || this.overlayPaused || this.reducedMotion;
  }

  private clearDwellTimer(): void {
    if (this.dwellTimer !== null) {
      this.clearTimeoutImpl(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  private clearCrossfadeTimer(): void {
    if (this.crossfadeTimer !== null) {
      this.clearTimeoutImpl(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  private scheduleDwell(): void {
    this.clearDwellTimer();
    if (!this.started || this.dwellSuppressed()) return;
    this.dwellTimer = this.setTimeoutImpl(() => {
      this.goTo(this.activeIndex + 1);
    }, this.dwellMs);
  }

  /** Moves to `nextIndex` (wrapped into range), starting a crossfade unless
   *  reduced-motion is active (in which case the swap is instant — README:
   *  "reduced-motion disables auto-advance keeping the dots [as manual
   *  nav]", and a manual jump under reduced motion should still not
   *  animate). ALWAYS (re)schedules a fresh dwell period afterwards,
   *  whether this move came from the auto-advance tick or a manual dot/
   *  arrow/jump — the two cases are observably identical (a fresh 7s
   *  window starting now), which is exactly the README's "interacting
   *  resets the dwell timer" for the manual case, and simply "the loop
   *  continues" for the auto-advance case. Also covers a manual click on
   *  the ALREADY-active dot: the index doesn't change, but the dwell
   *  timer still restarts. */
  private goTo(nextIndex: number): void {
    if (this.poolLength === 0) return;
    const wrapped = ((nextIndex % this.poolLength) + this.poolLength) % this.poolLength;

    if (wrapped !== this.activeIndex) {
      this.clearCrossfadeTimer();
      this.previousIndex = this.activeIndex;
      this.activeIndex = wrapped;
      this.crossfading = !this.reducedMotion;
      this.onChange(this.getSnapshot());

      if (this.crossfading) {
        this.crossfadeTimer = this.setTimeoutImpl(() => {
          this.crossfading = false;
          this.onChange(this.getSnapshot());
        }, this.crossfadeMs);
      }
    }

    this.scheduleDwell();
  }

  /** Starts the auto-advance dwell loop (no-op if already started). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleDwell();
  }

  /** Stops everything — call on unmount (Home navigating away, e.g. to the
   *  player route, unmounts this along with the rest of the page). */
  stop(): void {
    this.started = false;
    this.clearDwellTimer();
    this.clearCrossfadeTimer();
  }

  setPoolLength(poolLength: number): void {
    this.poolLength = poolLength;
    if (this.activeIndex >= poolLength) {
      this.activeIndex = 0;
      this.previousIndex = null;
      this.crossfading = false;
      this.clearCrossfadeTimer();
      this.onChange(this.getSnapshot());
    }
    this.scheduleDwell();
  }

  setHoverPaused(paused: boolean): void {
    if (this.hoverPaused === paused) return;
    this.hoverPaused = paused;
    this.scheduleDwell();
  }

  /** Pauses for any "something is open on top of Home" reason this lane
   *  ground-truthed as real (today: the music queue drawer). A future
   *  lane that adds a real cross-cutting modal/sheet/palette-open signal
   *  can drive this same setter — the scheduler doesn't care WHY, only
   *  THAT something wants the dwell suppressed. */
  setOverlayPaused(paused: boolean): void {
    if (this.overlayPaused === paused) return;
    this.overlayPaused = paused;
    this.scheduleDwell();
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    this.scheduleDwell();
  }

  /** Manual next/prev (arrows) — always resets the dwell timer. */
  next(): void {
    this.goTo(this.activeIndex + 1);
  }
  prev(): void {
    this.goTo(this.activeIndex - 1);
  }
  /** Manual dot click — jump straight to `index`, resetting the dwell timer. */
  jumpTo(index: number): void {
    this.goTo(index);
  }
}
