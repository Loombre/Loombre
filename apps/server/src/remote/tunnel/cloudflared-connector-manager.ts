// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/cloudflared-connector-manager.ts
//
// STATE.md R4/RG7 (T2, Batch-2): the REAL supervised-cloudflared-child
// ConnectorManager — connector-manager.ts's own header names this lane
// exactly as the one to replace remote.module.ts's NoopConnectorManager
// binding ("T2 ... replaces this binding with the real supervised-
// cloudflared-child implementation").
//
// Composed from three existing precedents, per RG7's own wording:
//   - packages/provisioning-pg/src/supervisor.ts's EmbeddedPostgres shape
//     (spawn DIRECTLY via child_process, never a daemonizing wrapper — a
//     live child handle is what makes "supervised" literally true; a
//     crash-detecting `exit` listener distinguishes an expected stop from
//     an unexpected one).
//   - apps/worker/src/transcode/process.ts's spawnFfmpegRun handle
//     semantics (injectable `spawnFn`, process-group detach on POSIX so
//     the whole group can be signaled, SIGTERM -> short grace timeout ->
//     SIGKILL, a bounded output ring buffer readable before AND after
//     exit).
//   - apps/worker/src/plugin-delivery/backoff.ts's computeBackoffMs full-
//     jitter exponential backoff (reimplemented locally in
//     compute-backoff-ms.ts — see that file's header), keyed off
//     `restartCount`, which is PROCESS-LIFETIME-scoped (not persisted to
//     the DB — RG7 reserves no migration for connector state, unlike
//     plugin_delivery_cursors.consecutive_failures, which survives a
//     worker restart by design).
//
// The four pure pieces this class composes each live in their own file
// with their own spec, matching this directory's existing granularity
// (tunnel-provider.ts / cloudflare-tunnel-provider.ts / tunnel-token.
// service.ts are separate files despite being tightly related): resolve-
// cloudflared-binary.ts (binary resolution), cloudflared-log-signals.ts
// (readiness/connection-lost line classification), compute-backoff-ms.ts
// (restart pacing), line-ring-buffer.ts (bounded logsTail backing store).
//
// ── Invocation (V-SEC input, mission-mandated to document loudly) ──────
// `cloudflared tunnel --no-autoupdate run`, with the connector credential
// passed via the `TUNNEL_TOKEN` environment variable, NEVER as a `--token`
// argv value. Ground-truthed against Cloudflare's own docs (Tunnel run
// parameters page): `--token`'s documented alternative is exactly the
// `TUNNEL_TOKEN` env var, "eliminating the need to include it in the
// command arguments" — cloudflared's own words. `argv` is readable by ANY
// local user via a plain `ps aux`/`ps -ef` on a shared machine; an env var
// is only readable by the SAME user (or root) via `/proc/<pid>/environ`
// (Linux) or a platform-equivalent PRIVILEGED inspection — a materially
// narrower exposure. This is the best available posture without a
// credentials-FILE indirection (`--token-file`/`TUNNEL_TOKEN_FILE`,
// cloudflared 2025.4.0+ — adds a 0600-file-on-disk-plus-cleanup surface
// for no additional secrecy over the env var on the platforms this repo
// ships; env wins). There is NO argv-based fallback path in this
// implementation — nothing to loudly document for V-SEC beyond this note.
//
// `--no-autoupdate` (a documented cloudflared global flag, placed between
// `tunnel` and `run` per Cloudflare's own examples): cloudflared's OWN
// background self-update-and-restart behavior is disabled — this
// supervisor already owns process lifecycle (restart-on-crash via backoff
// below); letting cloudflared silently replace the pinned binary file out
// from under an operator's install and restart itself outside this
// supervisor's crash-accounting would both double-count as an unexplained
// "crash" here AND defeat the "no auto-download, ever" posture RG7 states
// for OUR OWN binary acquisition — the same caution extended to
// cloudflared's own update mechanism.
//
// ── Health-state machine (RG7) ──────────────────────────────────────────
// `stopped` -> `starting` (spawned, awaiting the readiness line) ->
// `healthy` (readiness line seen, process alive) is the happy path.
// `healthy` -> `unhealthy`: cloudflared logs a recognized connection-lost
// line (its own edge connections drop/retry internally — cloudflared does
// NOT exit for this, so this is NOT a crash, no restart is scheduled) ->
// back to `healthy` on the next readiness line. Any -> `backoff`: the
// child process actually EXITED unexpectedly, OR a spawn/binary-resolution
// attempt failed — both collapse to the SAME "this attempt failed, retry
// with a growing delay" handling (see spawnNewSession's own comment for
// why binary-resolution failure is deliberately folded into the backoff
// loop rather than thrown from start()). `restartCount` increments,
// computeBackoffMs schedules a respawn, `backoffMs` is populated for
// exactly this state (T1's own ConnectorHealth.backoffMs doc comment:
// "non-null only while state === 'backoff'"). `stop()` from ANY state
// (including a pending `backoff` timer) lands on `stopped` with the
// pending restart timer cleared.
//
// Cancellation safety: every async callback (a child's 'exit'/'error'
// event, a pending restart timer) captures the CURRENT `sessionId` at the
// moment it is registered and no-ops if `this.sessionId` has since moved
// on — start()/stop() both mint a fresh sessionId immediately. This is the
// ONE mechanism that makes "stop() during backoff cancels the pending
// restart", "a stale exit event from a just-replaced child never triggers
// a phantom restart", and "start() while already running cleanly replaces
// the old session" all correct without needing to separately track "was
// this exit expected" — a session that is no longer current is, by
// definition, never acted on.
//
// nowMs()/random() are both injected (`options.nowMs`/`options.random`,
// default Date.now/Math.random) — RG7's own "nowMs() is the seam"
// instruction — so computeBackoffMs's jitter and every `sinceMs` timestamp
// are deterministic under test. `setTestDeps()` mirrors cloudflare-
// tunnel-provider.ts's own identical seam (CloudflareTunnelProviderDeps/
// setTestDeps): e2e specs boot the real AppModule and only get a live
// instance from `app.get(ConnectorManager)` AFTER Nest has already
// resolved it, so swapping deps post-construction is the only seam
// available there; unit tests instead construct this class directly
// (`new CloudflaredConnectorManager(fakeSettingsService, {spawnFn: ...})`),
// bypassing Nest entirely, exactly like cloudflare-tunnel-provider.spec.ts.
//
// ── onStateChange (WG3, R4/RG7 gap closure) ─────────────────────────────
// transitionTo() is the ONE place every state change in this class already
// flows through — onStateChange listeners are notified from there, and
// ONLY when `previous !== next` (a call that re-enters the SAME state,
// e.g. stopInternal() on an already-stopped manager, never fires a
// listener). apps/server/src/remote/tunnel/tunnel-connector-state-event.
// service.ts is the ONE production listener: it translates via
// remote-tunnel.service.ts's mapConnectorStateToContract and writes the
// frozen tunnel.connector.state event through the outbox. A listener that
// throws is caught and logged here — a bug in event-writing code must
// never take down the connector's own state machine.

import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Injectable, Optional } from "@nestjs/common";
import { SettingsService } from "../../settings/settings.service.js";
import { classifyCloudflaredLogLine } from "./cloudflared-log-signals.js";
import { computeBackoffMs } from "./compute-backoff-ms.js";
import { ConnectorManager, type ConnectorHealth, type ConnectorStartConfig, type ConnectorState, type ConnectorStateChange } from "./connector-manager.js";
import { LineRingBuffer } from "./line-ring-buffer.js";
import { resolveCloudflaredBinary } from "./resolve-cloudflared-binary.js";

export type SpawnFn = typeof nodeSpawn;

/** SIGTERM-to-SIGKILL escalation window (stop()) — mirrors apps/worker/
 *  src/transcode/process.ts's GRACEFUL_TERM_TIMEOUT_MS shape; a larger
 *  default (cloudflared gracefully draining active tunnel connections on
 *  SIGTERM is a slower, network-bound shutdown than ffmpeg's local encode
 *  loop) — UNPINNED, injectable via `options.stopGraceTimeoutMs` for fast
 *  deterministic tests. */
const DEFAULT_STOP_GRACE_TIMEOUT_MS = 5_000;

export interface CloudflaredConnectorManagerOptions {
  /** Defaults to node:child_process's real `spawn` — injectable so unit
   *  tests can substitute a fake child process (spawnFfmpegRun precedent),
   *  and so e2e/integration tests can redirect the REAL spawn target at a
   *  tiny Node stub script (apps/server/test/support/cloudflared-stub.mjs)
   *  while everything else (args, env, signals) stays production-real. */
  spawnFn?: SpawnFn;
  /** Injectable clock — RG7's own "nowMs() is the seam" instruction. */
  nowMs?: () => number;
  /** Injectable jitter source for computeBackoffMs — tests pin this for
   *  deterministic backoff values. */
  random?: () => number;
  /** SIGTERM-to-SIGKILL escalation window — see DEFAULT_STOP_GRACE_TIMEOUT_MS. */
  stopGraceTimeoutMs?: number;
}

/** Process-group signal delivery — byte-for-byte the same shape as
 *  apps/worker/src/transcode/process.ts's own killProcessGroup (POSIX:
 *  negative pid targets the whole group so cloudflared's own child
 *  processes, if any, are signaled too; win32: plain process.kill, no
 *  process groups). Reimplemented locally — apps/server never imports
 *  apps/worker code (see resolve-cloudflared-binary.ts's header). */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The REAL ConnectorManager implementation (RG7). Constructed via Nest DI
 * with SettingsService (remote.module.ts's `{ provide: ConnectorManager,
 * useClass: CloudflaredConnectorManager }` binding) — the second
 * constructor parameter is a plain options object, `@Optional()` so Nest
 * injects `undefined` for it rather than trying (and failing) to resolve a
 * DI token for a non-class type (identical posture to cloudflare-tunnel-
 * provider.ts's own `@Optional() deps` parameter — see that file's
 * header). Tests construct this directly, bypassing Nest entirely.
 */
@Injectable()
export class CloudflaredConnectorManager implements ConnectorManager {
  private child: ChildProcess | null = null;
  private state: ConnectorState = "stopped";
  private lastError: string | null = null;
  private restartCount = 0;
  private backoffMs: number | null = null;
  private sinceMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private startConfig: ConnectorStartConfig | null = null;
  /** Bumped on every start()/stop() — every async callback (a child's
   *  exit/error event, a pending restart timer) captures this at
   *  registration time and no-ops if it no longer matches, so a stale
   *  callback from a session that has since been replaced or stopped can
   *  never act — see this file's header, "Cancellation safety". */
  private sessionId = "";

  private readonly ring = new LineRingBuffer();
  /** WG3: onStateChange listeners — see this file's header. */
  private readonly stateChangeListeners: Array<(change: ConnectorStateChange) => void> = [];

  constructor(
    private readonly settingsService: SettingsService,
    @Optional() private options: CloudflaredConnectorManagerOptions = {},
  ) {
    this.sinceMs = this.nowMsFn();
  }

  /** Test-only seam — see this file's header. Production code never calls
   *  this. */
  setTestDeps(options: CloudflaredConnectorManagerOptions): void {
    this.options = options;
  }

  private get spawnFn(): SpawnFn {
    return this.options.spawnFn ?? nodeSpawn;
  }
  private get nowMsFn(): () => number {
    return this.options.nowMs ?? Date.now;
  }
  private get randomFn(): () => number {
    return this.options.random ?? Math.random;
  }
  private get stopGraceTimeoutMs(): number {
    return this.options.stopGraceTimeoutMs ?? DEFAULT_STOP_GRACE_TIMEOUT_MS;
  }

  async start(config: ConnectorStartConfig): Promise<void> {
    // Idempotent-safe: replacing an already-running session (e.g. a
    // hostname change) cleanly tears the old one down first rather than
    // leaking a second child process.
    await this.stopInternal();

    this.startConfig = config;
    this.restartCount = 0;
    this.lastError = null;
    this.spawnNewSession(config);
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  health(): ConnectorHealth {
    return {
      state: this.state,
      lastError: this.lastError,
      restartCount: this.restartCount,
      sinceMs: this.sinceMs,
      backoffMs: this.state === "backoff" ? this.backoffMs : null,
    };
  }

  logsTail(limit: number): string[] {
    return this.ring.tail(limit);
  }

  /** WG3 — see this file's header, "onStateChange". */
  onStateChange(listener: (change: ConnectorStateChange) => void): void {
    this.stateChangeListeners.push(listener);
  }

  // ── internal state machine ──────────────────────────────────────────

  private transitionTo(next: ConnectorState): void {
    const previous = this.state;
    this.state = next;
    this.sinceMs = this.nowMsFn();
    if (previous === next) return; // re-entering the same state is not a transition — no listener call
    const change: ConnectorStateChange = { previousState: previous, newState: next, changedAtMs: this.sinceMs };
    for (const listener of this.stateChangeListeners) {
      try {
        listener(change);
      } catch (err) {
        console.error(`CloudflaredConnectorManager: onStateChange listener threw (${previous} -> ${next}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private effectiveCloudflaredPathSetting(): string {
    try {
      const effective = this.settingsService.getEffective("remote.cloudflaredPath");
      return typeof effective?.value === "string" ? effective.value : "";
    } catch {
      // Never-throws posture, same as remote-posture.service.ts's own
      // safeEffectiveString — a settings-resolution hiccup must not crash
      // the connector supervisor.
      return "";
    }
  }

  private handleLine(line: string): void {
    const signal = classifyCloudflaredLogLine(line);
    if (signal === "ready") {
      if (this.state === "starting" || this.state === "unhealthy") {
        this.restartCount = 0;
        this.lastError = null;
        this.transitionTo("healthy");
      }
    } else if (signal === "connection-lost") {
      if (this.state === "healthy") {
        this.lastError = `cloudflared reported a lost connection: ${line.trim()}`;
        this.transitionTo("unhealthy");
      }
    }
  }

  /**
   * Spawns one attempt. Binary-resolution failure is deliberately folded
   * into the SAME crash/backoff retry loop as a process crash, rather than
   * thrown out of start() — RemoteTunnelService.enableRemoteTunnel calls
   * connectorManager.start() AFTER the Cloudflare tunnel/DNS route are
   * already provisioned and the credential already stored, with no
   * try/catch around the call; a throw here would leave those real
   * external resources orphaned against a remote_tunnel_state row that
   * never got written as enabled=true (the staged-commit write happens
   * AFTER this call). Never throwing means start() always succeeds
   * immediately from that caller's point of view — an unresolvable binary
   * is instead surfaced honestly via health() (backoffMs non-null,
   * lastErrorMessage populated) and self-heals the moment an admin fixes
   * PATH or remote.cloudflaredPath, on the very next retry.
   */
  private spawnNewSession(config: ConnectorStartConfig): void {
    const sessionId = randomUUID();
    this.sessionId = sessionId;
    this.transitionTo("starting");

    const resolved = resolveCloudflaredBinary(this.effectiveCloudflaredPathSetting());
    if (!resolved.ok) {
      this.handleAttemptFailed(sessionId, resolved.detail);
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnFn(resolved.binary.path, ["tunnel", "--no-autoupdate", "run"], {
        env: { ...process.env, TUNNEL_TOKEN: config.credential },
        stdio: ["ignore", "pipe", "pipe"],
        // Process-group detach on POSIX only (spawnFfmpegRun precedent) —
        // lets stop()'s SIGTERM/SIGKILL signal cloudflared's whole group.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this.handleAttemptFailed(sessionId, `failed to spawn cloudflared: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.ring.push(chunk.toString("utf8"), (line) => this.handleLine(line)));
    child.stderr?.on("data", (chunk: Buffer) => this.ring.push(chunk.toString("utf8"), (line) => this.handleLine(line)));

    child.once("error", (err: Error) => {
      if (this.sessionId !== sessionId) return;
      this.child = null;
      this.handleAttemptFailed(sessionId, `cloudflared failed to spawn: ${err.message}`);
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.sessionId !== sessionId) return;
      this.child = null;
      this.handleAttemptFailed(sessionId, `cloudflared exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });
  }

  /** A crash, a spawn failure, or a binary-resolution failure — never a
   *  deliberate stop() (stopInternal() mints a NEW sessionId before ever
   *  touching the child, so a stop()-triggered exit event's captured
   *  sessionId is already stale by the time this would otherwise fire —
   *  see this file's header, "Cancellation safety"). Schedules a restart
   *  at a growing full-jitter backoff. */
  private handleAttemptFailed(sessionId: string, detail: string): void {
    if (this.sessionId !== sessionId) return; // superseded by a newer start()/stop() — never act
    this.lastError = detail;
    this.restartCount += 1;
    const delayMs = computeBackoffMs(this.restartCount, this.randomFn);
    this.backoffMs = delayMs;
    this.transitionTo("backoff");

    const timer = setTimeout(() => {
      this.restartTimer = null;
      if (this.sessionId !== sessionId || this.startConfig === null) return; // stopped/replaced meanwhile
      this.spawnNewSession(this.startConfig);
    }, delayMs);
    timer.unref?.();
    this.restartTimer = timer;
  }

  private async stopInternal(): Promise<void> {
    this.sessionId = randomUUID(); // invalidates every in-flight timer/handler from the old session
    this.startConfig = null;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.transitionTo("stopped");
      return;
    }

    const pid = child.pid;
    if (pid !== undefined) killProcessGroup(pid, "SIGTERM");

    const exitedGracefully = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.stopGraceTimeoutMs);
        t.unref?.();
      }),
    ]);

    if (!exitedGracefully) {
      if (pid !== undefined) killProcessGroup(pid, "SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => resolve(), this.stopGraceTimeoutMs);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.transitionTo("stopped");
  }
}
