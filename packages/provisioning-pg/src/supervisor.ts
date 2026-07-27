// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/supervisor.ts
//
// EmbeddedPostgres — the class implementing P4.2 against the FROZEN
// @loombre/provisioning data contract. @loombre/provisioning ships TYPES
// only (no method signatures to conform to — verified by reading its full
// source before writing this file), so the shape of provision()/start()/
// stop()/upgrade()/getCurrentProvisioningStatus() below is this lane's own
// design, built to consume/produce exactly those frozen types.
//
// Spawns `postgres` DIRECTLY via child_process.spawn (exec.ts's
// spawnServer), never through `pg_ctl start`'s daemonizing fork — pg_ctl
// forks into the background and returns immediately, which would leave
// this package with no child handle to detect a crash. Holding the real
// child process is what makes "supervised child process" (P4.2's own
// title) literally true rather than aspirational.
//
// ProvisioningState mapping (the closed enum has six members; this
// package's lifecycle needs a "valid data dir, cleanly not running" idea
// that has no dedicated member — documented interpretive choice, flagged
// in this lane's report for lane D's admin UI): a clean stop() leaves
// state 'provisioning' with `detail: "stopped (clean shutdown)"`, the
// closest available member to "initialized but not currently serving".
// 'ready' is reserved for "a live child process that just answered a
// pg_isready health check", never inferred.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, cpSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type {
  ListenStrategy,
  ProvisioningStatus,
  SecretRef,
  UpgradePlan,
  UpgradeStep,
} from "@loombre/provisioning";
import { UPGRADE_STEPS } from "@loombre/provisioning";
import type { VendorBinaries } from "./binaries.js";
import { buildClientConnArgs, buildDatabaseUrl, buildServerListenArgs } from "./listen.js";
import { PG_HBA_CONTENTS } from "./hba.js";
import { generateSecret, resolveSecret } from "./secret/resolve.js";
import { writeOwnerOnlySecretFile } from "./secret/file0600.js";
import { detectCorruption, classifyStartupFailureLog, formatCorruptDetail } from "./corruption.js";
import { runBinary, spawnServer } from "./exec.js";
import { UpgradeStepFailedError, BinaryExecutionError } from "./errors.js";
import { EMBEDDED_PG_DEFAULT_DATABASE, EMBEDDED_PG_SUPERUSER_USERNAME } from "./defaults.js";
import type { ProvisioningController } from "./controller.js";
import { socketScratchBase } from "./scratch-paths.js";

export interface EmbeddedPostgresConfig {
  binaries: VendorBinaries;
  pgMajor: number;
  pgFullVersion: string;
  dataDir: string;
  listenStrategy: ListenStrategy;
  locale: string;
  encoding: "UTF8";
  superuserSecretRef: SecretRef;
  /** @default "loombre" */
  superuserUsername?: string;
  /** The app database ensured to exist once the server is ready.
   *  @default "loombre" */
  database?: string;
  /** Health-poll timeout for start(). @default 20000 */
  startTimeoutMs?: number;
}

export interface UpgradeSpotCheck {
  database: string;
  /** A single-value query, e.g. "SELECT count(*) FROM widgets". */
  query: string;
}

export interface UpgradeStepResult {
  step: UpgradeStep;
  startedAtMs: number;
  finishedAtMs: number;
  detail?: string;
}

export interface SpotCheckResult extends UpgradeSpotCheck {
  before: string;
  after: string;
  matched: boolean;
}

export interface UpgradeOptions {
  toBinaries: VendorBinaries;
  toPgMajor: number;
  toPgFullVersion: string;
  /** Absolute path the pre-upgrade backup is written to (UpgradePlan.backupPath). */
  backupPath: string;
  spotChecks?: UpgradeSpotCheck[];
}

export interface UpgradeResult {
  plan: UpgradePlan;
  stepResults: UpgradeStepResult[];
  spotCheckResults: SpotCheckResult[];
}

// Shared with discovery.ts (the worker-side reader) via defaults.ts —
// see that module's header for why these cannot be private here anymore.
const DEFAULT_USERNAME = EMBEDDED_PG_SUPERUSER_USERNAME;
const DEFAULT_DATABASE = EMBEDDED_PG_DEFAULT_DATABASE;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const HEALTH_POLL_INTERVAL_MS = 150;
const STOP_GRACE_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  return Date.now();
}

export class EmbeddedPostgres implements ProvisioningController {
  private binaries: VendorBinaries;
  private pgMajor: number;
  private pgFullVersion: string;
  private readonly dataDir: string;
  private readonly listenStrategy: ListenStrategy;
  private readonly locale: string;
  private readonly encoding: "UTF8";
  private readonly secretRef: SecretRef;
  private readonly username: string;
  private readonly database: string;
  private readonly startTimeoutMs: number;

  private status: ProvisioningStatus;
  private child: ChildProcess | null = null;
  private expectedExit = false;
  private childLogTail = "";
  private cachedSecretValue: string | null = null;

  constructor(config: EmbeddedPostgresConfig) {
    this.binaries = config.binaries;
    this.pgMajor = config.pgMajor;
    this.pgFullVersion = config.pgFullVersion;
    this.dataDir = config.dataDir;
    this.listenStrategy = config.listenStrategy;
    this.locale = config.locale;
    this.encoding = config.encoding;
    this.secretRef = config.superuserSecretRef;
    this.username = config.superuserUsername ?? DEFAULT_USERNAME;
    this.database = config.database ?? DEFAULT_DATABASE;
    this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

    this.status = { state: "absent", pgVersion: null, dataDir: null, lastCheckMs: nowMs() };
  }

  getCurrentProvisioningStatus(): ProvisioningStatus {
    return { ...this.status };
  }

  getDatabaseUrl(database: string = this.database): string {
    if (this.cachedSecretValue === null) {
      throw new Error("@loombre/provisioning-pg: getDatabaseUrl() called before the superuser secret was resolved (call provision() first).");
    }
    return buildDatabaseUrl(this.listenStrategy, this.username, this.cachedSecretValue, database);
  }

  /**
   * Best-effort, SYNCHRONOUS signal to the supervised child — for a
   * process-exit safety net ONLY (e.g. apps/server/src/bootstrap/
   * provisioning.ts registers this on `process.once('exit', ...)`), never
   * a substitute for `await stop()`'s graceful smart/fast shutdown with
   * its wait-for-exit + escalation ladder. Node's 'exit' event handlers
   * cannot run async code, so this is the most graceful thing possible
   * there: send SIGINT (fast shutdown) and return immediately without
   * waiting to see if it worked.
   */
  killSync(): void {
    if (this.child && this.child.exitCode === null) {
      this.expectedExit = true;
      this.child.kill("SIGINT");
    }
  }

  private async ensureSecretResolved(): Promise<string> {
    if (this.cachedSecretValue !== null) return this.cachedSecretValue;
    this.cachedSecretValue = await resolveSecret(this.secretRef);
    return this.cachedSecretValue;
  }

  private clientArgs(strategy: ListenStrategy = this.listenStrategy): string[] {
    return buildClientConnArgs(strategy);
  }

  // ── provision ────────────────────────────────────────────────────────

  async provision(): Promise<ProvisioningStatus> {
    this.status = { state: "provisioning", pgVersion: null, dataDir: this.dataDir, lastCheckMs: nowMs() };

    const alreadyInitialized = existsSync(join(this.dataDir, "PG_VERSION"));
    if (alreadyInitialized) {
      const report = await detectCorruption({ dataDir: this.dataDir, pinnedMajor: this.pgMajor, binaries: this.binaries });
      if (report) {
        this.status = {
          state: "corrupt",
          pgVersion: null,
          dataDir: this.dataDir,
          lastCheckMs: nowMs(),
          detail: formatCorruptDetail(report.reason, report.detail),
        };
        return this.getCurrentProvisioningStatus();
      }
      // Existing, healthy cluster — idempotent re-provision. Secret is
      // loaded (not regenerated: file0600's generate() is itself
      // idempotent, see secret/file0600.ts, but we don't even call it
      // here — the secret must already exist for this cluster to have
      // been initialized with it in the first place).
      await this.ensureSecretResolved();
      this.status = { state: "provisioning", pgVersion: this.pgFullVersion, dataDir: this.dataDir, lastCheckMs: nowMs() };
      return this.getCurrentProvisioningStatus();
    }

    const generated = await generateSecret(this.secretRef.backend, this.secretRef.key);
    this.cachedSecretValue = generated.value;

    mkdirSync(this.dataDir, { recursive: true });

    const pwfileDir = mkdtempSync(join(tmpdir(), "loombre-pg-pwfile-"));
    const pwfilePath = join(pwfileDir, "pwfile");
    try {
      // The pwfile holds the SAME secret the file0600 backend just stored,
      // so it gets the same owner-only guarantee: `{ mode: 0o600 }` is inert
      // on Windows, where the file would otherwise inherit the ambient Temp
      // directory's DACL for the length of the initdb run.
      writeOwnerOnlySecretFile(pwfilePath, generated.value);
      const result = await runBinary(
        this.binaries.initdb,
        [
          "-D",
          this.dataDir,
          "-U",
          this.username,
          `--pwfile=${pwfilePath}`,
          "-E",
          this.encoding,
          `--locale=${this.locale}`,
          "-A",
          "scram-sha-256",
        ],
        { libDir: this.binaries.libDir, timeoutMs: 60_000 },
      );
      if (result.exitCode !== 0) {
        throw new BinaryExecutionError("initdb", result.exitCode, result.stderr);
      }
    } finally {
      rmSync(pwfileDir, { recursive: true, force: true });
    }

    writeFileSync(join(this.dataDir, "pg_hba.conf"), PG_HBA_CONTENTS);

    this.status = { state: "provisioning", pgVersion: this.pgFullVersion, dataDir: this.dataDir, lastCheckMs: nowMs() };
    return this.getCurrentProvisioningStatus();
  }

  // ── start / health poll ─────────────────────────────────────────────

  private async pollReady(binaries: VendorBinaries, strategy: ListenStrategy, timeoutMs: number, child: ChildProcess | null): Promise<boolean> {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (child && child.exitCode !== null) return false;
      const probe = await runBinary(binaries.pgIsready, this.clientArgs(strategy), { libDir: binaries.libDir, timeoutMs: 5000 }).catch(
        () => ({ stdout: "", stderr: "", exitCode: 2 }),
      );
      if (probe.exitCode === 0) return true;
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    return false;
  }

  private async ensureDatabaseExists(strategy: ListenStrategy = this.listenStrategy): Promise<void> {
    const secret = await this.ensureSecretResolved();
    const checkArgs = [
      ...this.clientArgs(strategy),
      "-U",
      this.username,
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      `SELECT 1 FROM pg_database WHERE datname = '${this.database.replace(/'/g, "''")}'`,
    ];
    const check = await runBinary(this.binaries.psql, checkArgs, { libDir: this.binaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 10_000 });
    if (check.stdout.trim() === "1") return;

    const createArgs = [
      ...this.clientArgs(strategy),
      "-U",
      this.username,
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE "${this.database.replace(/"/g, '""')}"`,
    ];
    const create = await runBinary(this.binaries.psql, createArgs, { libDir: this.binaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 10_000 });
    if (create.exitCode !== 0) {
      throw new BinaryExecutionError("psql (CREATE DATABASE)", create.exitCode, create.stderr);
    }
  }

  async start(): Promise<ProvisioningStatus> {
    if (this.status.state === "absent") {
      throw new Error("@loombre/provisioning-pg: start() called before provision() — nothing to start.");
    }

    await this.ensureSecretResolved();

    const args = ["-D", this.dataDir, ...buildServerListenArgs(this.listenStrategy)];
    const child = spawnServer(this.binaries.postgres, args, { libDir: this.binaries.libDir });
    this.child = child;
    this.expectedExit = false;
    this.childLogTail = "";

    const appendLog = (chunk: Buffer): void => {
      this.childLogTail = (this.childLogTail + chunk.toString("utf8")).slice(-8000);
    };
    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);

    child.on("exit", () => {
      if (this.expectedExit) return;
      // Unexpected exit while we believed we were 'ready' — crash
      // detection (P4.2 "crash-of-child detection"). Fire-and-forget: this
      // handler cannot be awaited by its caller (there is none), so it
      // updates `this.status` asynchronously; getCurrentProvisioningStatus()
      // picks it up on next read.
      void this.handleUnexpectedExit();
    });

    const ready = await this.pollReady(this.binaries, this.listenStrategy, this.startTimeoutMs, child);

    if (!ready) {
      const stillRunning = child.exitCode === null;
      if (stillRunning) {
        this.expectedExit = true;
        child.kill("SIGQUIT");
        await this.waitForExit(child, 5000).catch(() => child.kill("SIGKILL"));
      }
      const report = await detectCorruption({ dataDir: this.dataDir, pinnedMajor: this.pgMajor, binaries: this.binaries });
      const reason = report?.reason ?? classifyStartupFailureLog(this.childLogTail);
      this.status = {
        state: "corrupt",
        pgVersion: null,
        dataDir: this.dataDir,
        lastCheckMs: nowMs(),
        detail: formatCorruptDetail(reason, report?.detail ?? `startup failed\n${this.childLogTail.slice(-2000)}`),
      };
      this.child = null;
      return this.getCurrentProvisioningStatus();
    }

    await this.ensureDatabaseExists();

    this.status = { state: "ready", pgVersion: this.pgFullVersion, dataDir: this.dataDir, lastCheckMs: nowMs() };
    return this.getCurrentProvisioningStatus();
  }

  private async handleUnexpectedExit(): Promise<void> {
    this.child = null;
    const report = await detectCorruption({ dataDir: this.dataDir, pinnedMajor: this.pgMajor, binaries: this.binaries });
    const reason = report?.reason ?? classifyStartupFailureLog(this.childLogTail);
    this.status = {
      state: "corrupt",
      pgVersion: null,
      dataDir: this.dataDir,
      lastCheckMs: nowMs(),
      detail: formatCorruptDetail(reason, report?.detail ?? `postgres exited unexpectedly\n${this.childLogTail.slice(-2000)}`),
    };
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolvePromise();
        return;
      }
      const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for child exit")), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  // ── stop ─────────────────────────────────────────────────────────────

  /** PostgreSQL's own signal convention (docs "Shutting Down the Server"):
   *  SIGTERM = Smart Shutdown, SIGINT = Fast Shutdown, SIGQUIT = Immediate. */
  async stop(mode: "smart" | "fast" = "fast"): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      if (this.status.state === "ready" || this.status.state === "corrupt") {
        this.status = { ...this.status, state: "provisioning", detail: "stopped (no running child)", lastCheckMs: nowMs() };
      }
      return;
    }

    this.expectedExit = true;
    child.kill(mode === "smart" ? "SIGTERM" : "SIGINT");
    try {
      await this.waitForExit(child, STOP_GRACE_TIMEOUT_MS);
    } catch {
      child.kill("SIGQUIT");
      try {
        await this.waitForExit(child, 5000);
      } catch {
        child.kill("SIGKILL");
        await this.waitForExit(child, 5000).catch(() => undefined);
      }
    }
    this.child = null;
    this.status = { state: "provisioning", pgVersion: this.pgFullVersion, dataDir: this.dataDir, lastCheckMs: nowMs(), detail: "stopped (clean shutdown)" };
  }

  // ── upgrade ──────────────────────────────────────────────────────────
  //
  // Executes the FROZEN UpgradePlan.steps order exactly:
  //   stop -> backup -> dumpall -> initdb-new -> restore -> verify -> swap -> restart
  //
  // Design constraint honored (STATE.md P4.2 / this lane's mission): this
  // is boot-time orchestration, NOT a pg-boss job — the queue lives inside
  // the PG being replaced. See packages/provisioning-pg/README.md
  // "Upgrade orchestration" for the full write-up, including why 'dumpall'
  // runs AFTER 'stop' (a brief, PRIVATE re-start of the OLD binaries
  // against the now-quiesced data directory, on a throwaway scratch
  // socket — never the publicly supervised instance) and the
  // jobs-ledger-row deviation (packages/jobs's JobType enum has no
  // upgrade-history member; adding one is out of this package's
  // ownership, documented as a follow-up).

  async upgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
    const fromVersion = this.pgFullVersion;
    const toVersion = opts.toPgFullVersion;
    const stepResults: UpgradeStepResult[] = [];
    const spotCheckResults: SpotCheckResult[] = [];
    const scratchNewDataDir = `${this.dataDir}-upgrading`;
    const dumpFileDir = mkdtempSync(join(tmpdir(), "loombre-pg-upgrade-"));
    const dumpFilePath = join(dumpFileDir, "dumpall.sql");

    this.status = { state: "upgrading", pgVersion: this.pgFullVersion, dataDir: this.dataDir, lastCheckMs: nowMs() };

    const runStep = async <T>(step: UpgradeStep, oldClusterIntact: boolean, fn: () => Promise<T>): Promise<T> => {
      const startedAtMs = nowMs();
      try {
        const result = await fn();
        stepResults.push({ step, startedAtMs, finishedAtMs: nowMs() });
        return result;
      } catch (err) {
        stepResults.push({ step, startedAtMs, finishedAtMs: nowMs(), detail: err instanceof Error ? err.message : String(err) });
        throw new UpgradeStepFailedError(step, oldClusterIntact, err);
      }
    };

    try {
      const secret = await this.ensureSecretResolved();

      await runStep("stop", true, () => this.stop("fast"));

      await runStep("backup", true, async () => {
        rmSync(opts.backupPath, { recursive: true, force: true });
        mkdirSync(dirname(opts.backupPath), { recursive: true });
        cpSync(this.dataDir, opts.backupPath, { recursive: true });
        if (!existsSync(join(opts.backupPath, "PG_VERSION"))) {
          throw new Error(`backup copy at ${opts.backupPath} is missing PG_VERSION — backup did not complete`);
        }
      });

      await runStep("dumpall", true, async () => {
        // socketScratchBase(), not tmpdir(): this dir hosts a real unix
        // socket file, which has a ~104-byte path cap — see
        // scratch-paths.ts header for the real failure this fixes.
        const scratch = mkdtempSync(join(socketScratchBase(), "loombre-pg-old-"));
        const socketDir = join(scratch, "sock");
        mkdirSync(socketDir, { recursive: true });
        const strategy: ListenStrategy = { kind: "unix-socket", socketDir };
        const child = spawnServer(this.binaries.postgres, ["-D", this.dataDir, ...buildServerListenArgs(strategy)], {
          libDir: this.binaries.libDir,
        });
        try {
          const ready = await this.pollReady(this.binaries, strategy, this.startTimeoutMs, child);
          if (!ready) throw new Error("old-binaries scratch instance for dumpall never became ready");

          const dump = await runBinary(
            this.binaries.pgDumpall,
            [...buildClientConnArgs(strategy), "-U", this.username, "-f", dumpFilePath],
            { libDir: this.binaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 120_000 },
          );
          if (dump.exitCode !== 0) throw new BinaryExecutionError("pg_dumpall", dump.exitCode, dump.stderr);

          for (const spotCheck of opts.spotChecks ?? []) {
            const before = await this.runSpotCheckQuery(this.binaries, strategy, secret, spotCheck);
            spotCheckResults.push({ ...spotCheck, before, after: "", matched: false });
          }
        } finally {
          child.kill("SIGINT");
          await this.waitForExit(child, STOP_GRACE_TIMEOUT_MS).catch(() => child.kill("SIGKILL"));
          rmSync(scratch, { recursive: true, force: true });
        }
      });

      await runStep("initdb-new", true, async () => {
        rmSync(scratchNewDataDir, { recursive: true, force: true });
        mkdirSync(scratchNewDataDir, { recursive: true });
        const pwfileDir = mkdtempSync(join(tmpdir(), "loombre-pg-pwfile-"));
        try {
          const pwfilePath = join(pwfileDir, "pwfile");
          writeOwnerOnlySecretFile(pwfilePath, secret);
          const result = await runBinary(
            opts.toBinaries.initdb,
            ["-D", scratchNewDataDir, "-U", this.username, `--pwfile=${pwfilePath}`, "-E", this.encoding, `--locale=${this.locale}`, "-A", "scram-sha-256"],
            { libDir: opts.toBinaries.libDir, timeoutMs: 60_000 },
          );
          if (result.exitCode !== 0) throw new BinaryExecutionError("initdb (new major)", result.exitCode, result.stderr);
        } finally {
          rmSync(pwfileDir, { recursive: true, force: true });
        }
        writeFileSync(join(scratchNewDataDir, "pg_hba.conf"), PG_HBA_CONTENTS);
      });

      const restoreScratch = mkdtempSync(join(socketScratchBase(), "loombre-pg-new-"));
      const restoreSocketDir = join(restoreScratch, "sock");
      mkdirSync(restoreSocketDir, { recursive: true });
      const restoreStrategy: ListenStrategy = { kind: "unix-socket", socketDir: restoreSocketDir };

      await runStep("restore", true, async () => {
        const child = spawnServer(opts.toBinaries.postgres, ["-D", scratchNewDataDir, ...buildServerListenArgs(restoreStrategy)], {
          libDir: opts.toBinaries.libDir,
        });
        try {
          const ready = await this.pollReady(opts.toBinaries, restoreStrategy, this.startTimeoutMs, child);
          if (!ready) throw new Error("new-binaries scratch instance for restore never became ready");

          const dumpSql = readFileSync(dumpFilePath, "utf8");
          const restore = await runBinary(
            opts.toBinaries.psql,
            [...buildClientConnArgs(restoreStrategy), "-U", this.username, "-d", "postgres", "-f", dumpFilePath],
            { libDir: opts.toBinaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 300_000 },
          );
          const unexpectedErrors = restore.stdout
            .split("\n")
            .concat(restore.stderr.split("\n"))
            .filter((line) => line.includes("ERROR:") && !/role .* already exists/i.test(line));
          if (unexpectedErrors.length > 0) {
            throw new Error(`pg_dumpall restore produced unexpected errors:\n${unexpectedErrors.join("\n")}\n(dump had ${dumpSql.length} bytes)`);
          }
        } finally {
          child.kill("SIGINT");
          await this.waitForExit(child, STOP_GRACE_TIMEOUT_MS).catch(() => child.kill("SIGKILL"));
        }
      });

      await runStep("verify", true, async () => {
        const child = spawnServer(opts.toBinaries.postgres, ["-D", scratchNewDataDir, ...buildServerListenArgs(restoreStrategy)], {
          libDir: opts.toBinaries.libDir,
        });
        try {
          const ready = await this.pollReady(opts.toBinaries, restoreStrategy, this.startTimeoutMs, child);
          if (!ready) throw new Error("new-binaries scratch instance for verify never became ready");

          const versionCheck = await runBinary(
            opts.toBinaries.psql,
            [...buildClientConnArgs(restoreStrategy), "-U", this.username, "-d", "postgres", "-t", "-A", "-c", "SHOW server_version"],
            { libDir: opts.toBinaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 10_000 },
          );
          const reportedMajor = Number.parseInt(versionCheck.stdout.trim(), 10);
          if (reportedMajor !== opts.toPgMajor) {
            throw new Error(`verify: new instance reports server_version "${versionCheck.stdout.trim()}", expected major ${opts.toPgMajor}`);
          }

          for (const result of spotCheckResults) {
            const after = await this.runSpotCheckQuery(opts.toBinaries, restoreStrategy, secret, result);
            result.after = after;
            result.matched = after === result.before;
            if (!result.matched) {
              throw new Error(`verify: spot check mismatch on ${result.database} — before="${result.before}" after="${after}" (query: ${result.query})`);
            }
          }
        } finally {
          child.kill("SIGINT");
          await this.waitForExit(child, STOP_GRACE_TIMEOUT_MS).catch(() => child.kill("SIGKILL"));
          rmSync(restoreScratch, { recursive: true, force: true });
        }
      });

      await runStep("swap", false, async () => {
        rmSync(this.dataDir, { recursive: true, force: true });
        try {
          renameSync(scratchNewDataDir, this.dataDir);
        } catch {
          // EXDEV (scratch dir on a different filesystem) fallback.
          cpSync(scratchNewDataDir, this.dataDir, { recursive: true });
          rmSync(scratchNewDataDir, { recursive: true, force: true });
        }
      });

      this.binaries = opts.toBinaries;
      this.pgMajor = opts.toPgMajor;
      this.pgFullVersion = opts.toPgFullVersion;

      await runStep("restart", false, async () => {
        const status = await this.start();
        if (status.state !== "ready") {
          throw new Error(`post-upgrade restart did not reach 'ready' (state=${status.state}, detail=${status.detail ?? "none"})`);
        }
      });
    } finally {
      rmSync(dumpFileDir, { recursive: true, force: true });
    }

    const plan: UpgradePlan = {
      fromVersion,
      toVersion,
      backupPath: opts.backupPath,
      steps: [...UPGRADE_STEPS],
    };

    return { plan, stepResults, spotCheckResults };
  }

  private async runSpotCheckQuery(binaries: VendorBinaries, strategy: ListenStrategy, secret: string, spotCheck: UpgradeSpotCheck): Promise<string> {
    const result = await runBinary(
      binaries.psql,
      [...buildClientConnArgs(strategy), "-U", this.username, "-d", spotCheck.database, "-t", "-A", "-c", spotCheck.query],
      { libDir: binaries.libDir, env: { PGPASSWORD: secret }, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new BinaryExecutionError(`psql (spot check on ${spotCheck.database})`, result.exitCode, result.stderr);
    }
    return result.stdout.trim();
  }
}
