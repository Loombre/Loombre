// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/errors.ts
//
// Typed error classes this package throws. Every one carries enough
// structured detail for a caller to `instanceof`-branch rather than parse
// a message string — mirrors the "typed reason enum, prose is supplementary
// only" discipline @loombre/provisioning's CorruptionReport itself follows.

/** Thrown when a required binary (postgres/initdb/pg_ctl/psql/pg_isready/
 *  pg_controldata/pg_dumpall) is missing from the resolved vendor directory
 *  — always points the caller at scripts/fetch-embedded-pg.mjs rather than
 *  failing with a bare ENOENT. */
export class BinaryMissingError extends Error {
  readonly binaryName: string;
  readonly expectedPath: string;

  constructor(binaryName: string, expectedPath: string) {
    super(
      `@loombre/provisioning-pg: required binary "${binaryName}" not found at ${expectedPath}. ` +
        `Run: node scripts/fetch-embedded-pg.mjs --platform host (see that script's --help for --pg-version/--vendor-dir).`,
    );
    this.name = "BinaryMissingError";
    this.binaryName = binaryName;
    this.expectedPath = expectedPath;
  }
}

/**
 * External-PG mode (docs/PLAN.md D1 "external PG via env var";
 * @loombre/provisioning's ProvisioningStatus 'external' state doc comment):
 * every mutating call on an external-mode provisioner throws this
 * immediately, before touching any filesystem/process state. Provisioning
 * must never attempt initdb/upgrade/repair against a database Loombre does
 * not own.
 */
export class ExternalModeInertError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `@loombre/provisioning-pg: ${operation}() is inert in external-PG mode (DATABASE_URL is set) — ` +
        `Loombre never provisions, supervises, or upgrades a database it does not own.`,
    );
    this.name = "ExternalModeInertError";
    this.operation = operation;
  }
}

/**
 * A SecretBackend other than 'file0600' was requested. keychain/dpapi/
 * libsecret land in Wave 2 (P4.7/G1) — see packages/provisioning-pg/README.md
 * "Secrets" section for the exact seam this error marks.
 */
export class UnsupportedSecretBackendError extends Error {
  readonly backend: string;

  constructor(backend: string) {
    super(
      `@loombre/provisioning-pg: SecretBackend "${backend}" is not implemented yet — only "file0600" ships in Wave 1. ` +
        `keychain/dpapi/libsecret are P4.7 Wave-2 (G1) work behind this same SecretRef seam.`,
    );
    this.name = "UnsupportedSecretBackendError";
    this.backend = backend;
  }
}

/** A step in the frozen UpgradePlan.steps sequence failed. Carries enough
 *  of the in-progress result for the caller to decide whether the OLD
 *  cluster is still safely startable (true for every step before 'swap' —
 *  see this package's README "Upgrade failure recovery" section). */
export class UpgradeStepFailedError extends Error {
  readonly step: string;
  readonly oldClusterIntact: boolean;

  constructor(step: string, oldClusterIntact: boolean, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `@loombre/provisioning-pg: upgrade step "${step}" failed: ${causeMessage}. ` +
        (oldClusterIntact
          ? "The OLD data directory has not been touched (failure occurred before the 'swap' step) — it can still be started with the OLD binaries."
          : "The OLD data directory may have been modified or replaced — recover from the pre-upgrade backup."),
    );
    this.name = "UpgradeStepFailedError";
    this.step = step;
    this.oldClusterIntact = oldClusterIntact;
    this.cause = cause;
  }
}

/** A shell-out to a bundled binary exited non-zero and the caller has no
 *  more specific typed error to raise for that failure. */
export class BinaryExecutionError extends Error {
  readonly binaryName: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(binaryName: string, exitCode: number | null, stderr: string) {
    super(`@loombre/provisioning-pg: ${binaryName} exited ${exitCode ?? "(signal)"}: ${stderr.trim().slice(0, 2000)}`);
    this.name = "BinaryExecutionError";
    this.binaryName = binaryName;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Windows-only: the owner-only DACL could not be applied to a secret file.
 *  Raised INSTEAD of leaving the secret readable under inherited
 *  permissions — a provisioning run that cannot make the confidentiality
 *  guarantee stops loudly rather than silently downgrading it. */
export class SecretAclError extends Error {
  readonly filePath: string;
  readonly principal: string;

  constructor(filePath: string, principal: string, cause?: unknown) {
    super(
      `@loombre/provisioning-pg: could not apply an owner-only DACL to the secret at ${filePath} ` +
        `(principal ${principal}). Windows has no POSIX mode bits, so this ACL IS the file's confidentiality ` +
        `guarantee — refusing to continue with the secret under inherited permissions. ` +
        `Check that icacls is on PATH and that the volume supports ACLs (NTFS, not FAT32/exFAT).`,
    );
    this.name = "SecretAclError";
    this.filePath = filePath;
    this.principal = principal;
    this.cause = cause;
  }
}
