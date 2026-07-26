// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/run-cli.spec.ts
//
// CLI-output tests (STATE.md P4.11: "Tests for version derivation + CLI
// output") against the pure runCli() function — no process spawn, so this
// runs the exact same logic bin/loombre.mjs wraps, without needing a build
// step first.

import { describe, expect, it } from "vitest";
import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { runCli } from "../../src/cli/run-cli.js";
import type { DoctorDeps } from "../../src/cli/doctor.js";

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

const BASE_ENV = { DATABASE_URL: "postgres://loombre:loombre@localhost:5442/loombre", PATH: "/usr/bin", HOME: "/home/u" };

describe("runCli — --version", () => {
  it.each(["--version", "-v", "version"])("%s prints exactly `Loombre <LOOMBRE_VERSION_FULL>` and exits 0", (arg) => {
    const result = runCli({ argv: [arg], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([`Loombre ${LOOMBRE_VERSION_FULL}`]);
    expect(result.stderr).toEqual([]);
  });

  it("printed version matches the shape `Loombre <semver>[-dev+<hash>]` (rename R6)", () => {
    const result = runCli({ argv: ["--version"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS });
    expect(result.stdout[0]).toMatch(/^Loombre \d+\.\d+\.\d+(-dev\+[0-9a-f]+|-dev\+unknown)?$/);
  });
});

describe("runCli — --help", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("argv=%j prints help and exits 0", (argv) => {
    const result = runCli({ argv, env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout[0]).toBe("loombre — Loombre media server CLI");
    expect(result.stdout.join("\n")).toContain("doctor");
    expect(result.stdout.join("\n")).toContain("paths");
  });
});

describe("runCli — paths", () => {
  it("prints the resolved platform/data/config lines", () => {
    const result = runCli({
      argv: ["paths"],
      env: { ...BASE_ENV },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([
      "platform:   linux",
      "data dir:   /home/u/.local/share/loombre (default)",
      "config dir: /home/u/.config/loombre (default)",
    ]);
  });

  it("reflects LOOMBRE_DATA_DIR/LOOMBRE_CONFIG_DIR overrides", () => {
    const result = runCli({
      argv: ["paths"],
      env: { ...BASE_ENV, LOOMBRE_DATA_DIR: "/mnt/data", LOOMBRE_CONFIG_DIR: "/mnt/config" },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
    });
    expect(result.stdout[1]).toBe("data dir:   /mnt/data (LOOMBRE_DATA_DIR)");
    expect(result.stdout[2]).toBe("config dir: /mnt/config (LOOMBRE_CONFIG_DIR)");
  });
});

describe("runCli — doctor", () => {
  it("exits 0 and prints PASS when every check is ok", () => {
    const result = runCli({ argv: ["doctor"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.at(-1)).toBe("doctor: PASS");
    expect(result.stdout.some((l) => l.includes("DATABASE_URL"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("ffmpeg"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("ffprobe"))).toBe(true);
    expect(result.stdout.some((l) => l.includes("data directory writability"))).toBe(true);
  });

  it("exits 1 and prints FAIL when a check fails", () => {
    const result = runCli({ argv: ["doctor"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: FAIL_DOCTOR_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.at(-1)).toBe("doctor: FAIL — one or more checks failed");
  });

  it("a warn-only run (e.g. DATABASE_URL unset) still exits 0", () => {
    const result = runCli({
      argv: ["doctor"],
      env: { ...BASE_ENV, DATABASE_URL: undefined },
      nodePlatform: "linux",
      doctorDeps: OK_DOCTOR_DEPS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.some((l) => l.includes("[warn]"))).toBe(true);
  });
});

describe("runCli — unknown command", () => {
  it("exits 1 and points at --help, on stderr not stdout", () => {
    const result = runCli({ argv: ["bogus"], env: BASE_ENV, nodePlatform: "linux", doctorDeps: OK_DOCTOR_DEPS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toContain("unknown command");
    expect(result.stderr.join("\n")).toContain("--help");
  });
});
