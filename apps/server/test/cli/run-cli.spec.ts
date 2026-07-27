// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/run-cli.spec.ts
//
// CLI-output tests (STATE.md P4.11: "Tests for version derivation + CLI
// output") against the pure runCli() function — no process spawn, so this
// runs the exact same logic bin/loombre.mjs wraps, without needing a build
// step first.
//
// B-1 (H2 lane, owner brief): runCli is now ASYNC (Promise<CliResult>) so
// the `admin reset-pin` branch can dynamically `import("@loombre/db")` only
// when it actually runs — every test below now awaits it. adminDeps is a
// required part of RunCliOptions (house doctorDeps pattern); the
// THROWING_ADMIN_DEPS fixture proves the non-admin commands (and admin
// usage-error branches) never even touch it.

import { describe, expect, it, vi } from "vitest";
import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { runCli } from "../../src/cli/run-cli.js";
import type { DoctorDeps } from "../../src/cli/doctor.js";
import type { AdminDeps } from "../../src/cli/admin-reset-pin.js";

const OK_DOCTOR_DEPS: DoctorDeps = {
  isExecutableFile: () => true,
  spawnVersion: () => ({ ok: true, stdout: "ffmpeg version 6.1" }),
  checkWritable: () => ({ exists: true, writable: true, checkedPath: "/data" }),
};

const FAIL_DOCTOR_DEPS: DoctorDeps = {
  isExecutableFile: () => false,
  spawnVersion: () => ({ ok: false, stdout: "" }),
  checkWritable: () => ({ exists: false, writable: false, checkedPath: "/" }),
};

/** Throws on every method — proves a given code path never reaches the DB
 *  or the confirmation prompt at all (used for --version/--help/paths/
 *  doctor, and for admin usage-error branches that should short-circuit
 *  before ever calling connect()/confirm()). */
const THROWING_ADMIN_DEPS: AdminDeps = {
  connect: () => {
    throw new Error("connect() must not be called on this path");
  },
  confirm: () => {
    throw new Error("confirm() must not be called on this path");
  },
  nowMs: () => {
    throw new Error("nowMs() must not be called on this path");
  },
};

const BASE_ENV = { DATABASE_URL: "postgres://loombre:loombre@localhost:5442/loombre", PATH: "/usr/bin", HOME: "/home/u" };

describe("runCli — --version", () => {
  it.each(["--version", "-v", "version"])("%s prints exactly `Loombre <LOOMBRE_VERSION_FULL>` and exits 0", async (arg) => {
    const result = await runCli({ argv: [arg], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([`Loombre ${LOOMBRE_VERSION_FULL}`]);
    expect(result.stderr).toEqual([]);
  });

  it("printed version matches the shape `Loombre <semver>[-dev+<hash>]` (rename R6)", async () => {
    const result = await runCli({ argv: ["--version"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.stdout[0]).toMatch(/^Loombre \d+\.\d+\.\d+(-dev\+[0-9a-f]+|-dev\+unknown)?$/);
  });
});

describe("runCli — --help", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("argv=%j prints help and exits 0", async (argv) => {
    const result = await runCli({ argv, env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout[0]).toBe("loombre — Loombre media server CLI");
    expect(result.stdout.join("\n")).toContain("doctor");
    expect(result.stdout.join("\n")).toContain("paths");
    expect(result.stdout.join("\n")).toContain("admin reset-pin");
    expect(result.stdout.join("\n")).toContain("DATABASE_URL");
  });
});

describe("runCli — paths", () => {
  it("prints the resolved platform/data/config lines", async () => {
    const result = await runCli({
      argv: ["paths"],
      env: { ...BASE_ENV },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
      adminDeps: THROWING_ADMIN_DEPS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([
      "platform:   linux",
      "data dir:   /home/u/.local/share/loombre (default)",
      "config dir: /home/u/.config/loombre (default)",
    ]);
  });

  it("reflects LOOMBRE_DATA_DIR/LOOMBRE_CONFIG_DIR overrides", async () => {
    const result = await runCli({
      argv: ["paths"],
      env: { ...BASE_ENV, LOOMBRE_DATA_DIR: "/mnt/data", LOOMBRE_CONFIG_DIR: "/mnt/config" },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
      adminDeps: THROWING_ADMIN_DEPS,
    });
    expect(result.stdout[1]).toBe("data dir:   /mnt/data (LOOMBRE_DATA_DIR)");
    expect(result.stdout[2]).toBe("config dir: /mnt/config (LOOMBRE_CONFIG_DIR)");
  });
});

describe("runCli — doctor", () => {
  it("exits 0 and prints PASS when every check is ok", async () => {
    const result = await runCli({ argv: ["doctor"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.at(-1)).toBe("doctor: PASS");
    expect(result.stdout.some((l) => l.includes("DATABASE_URL"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("ffmpeg"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("ffprobe"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("data directory writability"))).toBe(true);
  });

  it("exits 1 and prints FAIL when a check fails", async () => {
    const result = await runCli({ argv: ["doctor"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: FAIL_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.at(-1)).toBe("doctor: FAIL — one or more checks failed");
  });

  it("a warn-only run (e.g. DATABASE_URL unset) still exits 0", async () => {
    const result = await runCli({
      argv: ["doctor"],
      env: { ...BASE_ENV, DATABASE_URL: undefined },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
      adminDeps: THROWING_ADMIN_DEPS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.some((l) => l.includes("[warn]"))).toBe(true);
  });
});

describe("runCli — unknown command", () => {
  it("exits 1 and points at --help, on stderr not stdout", async () => {
    const result = await runCli({ argv: ["bogus"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toContain("unknown command");
    expect(result.stderr.join("\n")).toContain("--help");
  });
});

describe("runCli — admin (dispatch only; full reset-pin behavior is apps/server/test/cli/admin-reset-pin.e2e.spec.ts)", () => {
  it("`admin` with no subcommand is a usage error, exit 1, and never touches adminDeps", async () => {
    const result = await runCli({ argv: ["admin"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join("\n")).toContain("reset-pin");
  });

  it("`admin bogus` is an unknown-admin-command usage error, exit 1, and never touches adminDeps", async () => {
    const result = await runCli({ argv: ["admin", "bogus"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("bogus");
  });

  it("`admin reset-pin` with no username is a usage error, exit 1, and never touches adminDeps", async () => {
    const result = await runCli({ argv: ["admin", "reset-pin"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps: THROWING_ADMIN_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("loombre admin reset-pin <username>");
  });

  it("`admin reset-pin <username> <extra>` (too many args) is a usage error, exit 1, and never touches adminDeps", async () => {
    const result = await runCli({
      argv: ["admin", "reset-pin", "casual", "extra-arg"],
      env: BASE_ENV,
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
      adminDeps: THROWING_ADMIN_DEPS,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("loombre admin reset-pin <username>");
  });

  it("`admin reset-pin <username>` DOES reach adminDeps.connect() once argv is well-formed", async () => {
    const connect = vi.fn(() => {
      throw new Error("stop here — this test only proves connect() was reached");
    });
    const adminDeps: AdminDeps = { connect, confirm: async () => true, nowMs: () => 0 };
    await expect(
      runCli({ argv: ["admin", "reset-pin", "casual"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS, adminDeps }),
    ).rejects.toThrow("stop here");
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
