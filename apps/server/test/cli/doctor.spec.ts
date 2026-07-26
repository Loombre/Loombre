// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/doctor.spec.ts
//
// Unit tests for apps/server/src/cli/doctor.ts against FAKE DoctorDeps —
// never touches the real filesystem/PATH/process table (mission spec:
// "read-only checks only", and this suite proves the logic without even
// depending on ffmpeg being installed on the test runner).

import { describe, expect, it } from "vitest";
import { runDoctorChecks, type DoctorDeps, type DoctorEnv } from "../../src/cli/doctor.js";

function fakeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    isExecutableFile: () => false,
    spawnVersion: () => ({ ok: false, stdout: "" }),
    checkWritable: () => ({ exists: true, writable: true, checkedPath: "/data" }),
    ...overrides,
  };
}

const BASE_ENV: DoctorEnv = {
  DATABASE_URL: "postgres://loombre:loombre@localhost:5442/loombre",
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
};

describe("runDoctorChecks — DATABASE_URL", () => {
  it("ok when set to a valid postgres:// URL", () => {
    const [dbCheck] = runDoctorChecks(BASE_ENV, fakeDeps(), "linux", "/data");
    expect(dbCheck?.status).toBe("ok");
    expect(dbCheck?.message).toContain("postgres:");
  });

  it("warn when unset (dev default note)", () => {
    const [dbCheck] = runDoctorChecks({ ...BASE_ENV, DATABASE_URL: undefined }, fakeDeps(), "linux", "/data");
    expect(dbCheck?.status).toBe("warn");
    expect(dbCheck?.message).toMatch(/dev default/);
  });

  it("fail on a malformed URL", () => {
    const [dbCheck] = runDoctorChecks({ ...BASE_ENV, DATABASE_URL: "not-a-url" }, fakeDeps(), "linux", "/data");
    expect(dbCheck?.status).toBe("fail");
  });

  it("fail on a non-postgres scheme", () => {
    const [dbCheck] = runDoctorChecks(
      { ...BASE_ENV, DATABASE_URL: "mysql://u:p@localhost/db" },
      fakeDeps(),
      "linux",
      "/data",
    );
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.message).toMatch(/mysql:/);
  });
});

describe("runDoctorChecks — ffmpeg/ffprobe resolution", () => {
  it("fail when neither the env override nor PATH resolves the binary", () => {
    const results = runDoctorChecks(BASE_ENV, fakeDeps(), "linux", "/data");
    const ffmpeg = results.find((r) => r.name === "ffmpeg");
    expect(ffmpeg?.status).toBe("fail");
    expect(ffmpeg?.message).toMatch(/not found/);
  });

  it("ok when the env override points at an executable that responds to -version", () => {
    const results = runDoctorChecks(
      { ...BASE_ENV, LOOMBRE_FFMPEG: "/opt/ffmpeg/ffmpeg" },
      fakeDeps({
        isExecutableFile: (candidate) => candidate === "/opt/ffmpeg/ffmpeg",
        spawnVersion: (bin) =>
          bin === "/opt/ffmpeg/ffmpeg" ? { ok: true, stdout: "ffmpeg version 6.1\n..." } : { ok: false, stdout: "" },
      }),
      "linux",
      "/data",
    );
    const ffmpeg = results.find((r) => r.name === "ffmpeg");
    expect(ffmpeg?.status).toBe("ok");
    expect(ffmpeg?.message).toContain("env");
    expect(ffmpeg?.message).toContain("ffmpeg version 6.1");
  });

  it("fail when the env override does not point at an executable file", () => {
    const results = runDoctorChecks(
      { ...BASE_ENV, LOOMBRE_FFPROBE: "/nope/ffprobe" },
      fakeDeps({ isExecutableFile: () => false }),
      "linux",
      "/data",
    );
    const ffprobe = results.find((r) => r.name === "ffprobe");
    expect(ffprobe?.status).toBe("fail");
    expect(ffprobe?.message).toContain("LOOMBRE_FFPROBE");
  });

  it("resolves via PATH scan when no env override is set", () => {
    const results = runDoctorChecks(
      BASE_ENV,
      fakeDeps({
        isExecutableFile: (candidate) => candidate === "/usr/bin/ffmpeg",
        spawnVersion: () => ({ ok: true, stdout: "ffmpeg version 6.1" }),
      }),
      "linux",
      "/data",
    );
    const ffmpeg = results.find((r) => r.name === "ffmpeg");
    expect(ffmpeg?.status).toBe("ok");
    expect(ffmpeg?.message).toContain("path");
  });

  it("warn when resolved but -version fails to run (corrupt/incompatible binary)", () => {
    const results = runDoctorChecks(
      { ...BASE_ENV, LOOMBRE_FFMPEG: "/opt/ffmpeg" },
      fakeDeps({
        isExecutableFile: (candidate) => candidate === "/opt/ffmpeg",
        spawnVersion: () => ({ ok: false, stdout: "" }),
      }),
      "linux",
      "/data",
    );
    const ffmpeg = results.find((r) => r.name === "ffmpeg");
    expect(ffmpeg?.status).toBe("warn");
  });

  it("windows: uses ; delimiter and PATHEXT extensions for the PATH scan", () => {
    const results = runDoctorChecks(
      { PATH: "C:\\ffmpeg\\bin;C:\\other", PATHEXT: ".EXE;.CMD" },
      fakeDeps({
        isExecutableFile: (candidate) => candidate === "C:\\ffmpeg\\bin\\ffmpeg.EXE",
        spawnVersion: () => ({ ok: true, stdout: "ffmpeg version 6.1" }),
      }),
      "win32",
      "C:\\data",
    );
    const ffmpeg = results.find((r) => r.name === "ffmpeg");
    expect(ffmpeg?.status).toBe("ok");
  });
});

describe("runDoctorChecks — data directory writability", () => {
  it("ok when the directory already exists and is writable", () => {
    const results = runDoctorChecks(
      BASE_ENV,
      fakeDeps({ checkWritable: () => ({ exists: true, writable: true, checkedPath: "/data" }) }),
      "linux",
      "/data",
    );
    const dir = results.find((r) => r.name === "data directory writability");
    expect(dir?.status).toBe("ok");
    expect(dir?.message).toMatch(/exists and is writable/);
  });

  it("ok (not yet created) when the directory doesn't exist but its writable ancestor does", () => {
    const results = runDoctorChecks(
      BASE_ENV,
      fakeDeps({ checkWritable: () => ({ exists: false, writable: true, checkedPath: "/home/u" }) }),
      "linux",
      "/home/u/.local/share/loombre",
    );
    const dir = results.find((r) => r.name === "data directory writability");
    expect(dir?.status).toBe("ok");
    expect(dir?.message).toMatch(/does not exist yet/);
  });

  it("fail when the nearest existing ancestor is not writable", () => {
    const results = runDoctorChecks(
      BASE_ENV,
      fakeDeps({ checkWritable: () => ({ exists: false, writable: false, checkedPath: "/root" }) }),
      "linux",
      "/root/loombre",
    );
    const dir = results.find((r) => r.name === "data directory writability");
    expect(dir?.status).toBe("fail");
  });
});
