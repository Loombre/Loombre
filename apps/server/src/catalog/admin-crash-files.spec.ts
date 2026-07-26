// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-crash-files.spec.ts

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_FILE_NAME_PATTERN,
  isValidCrashFileName,
  listCrashFileMetas,
  readCrashFileContent,
} from "./admin-crash-files.js";
import { crashDirPath } from "@loombre/shared";

const dirs: string[] = [];
function makeTmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loombre-admin-crashfiles-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("isValidCrashFileName / CRASH_FILE_NAME_PATTERN (traversal-impossible by construction)", () => {
  it("accepts realistic crash-writer filenames", () => {
    expect(isValidCrashFileName("crash-2026-07-24T12-00-00-000Z-ab12cd.json")).toBe(true);
    expect(isValidCrashFileName("server-boot.log")).toBe(true);
    expect(isValidCrashFileName("a")).toBe(true);
  });

  const hostileNames = [
    "../../etc/passwd",
    "..",
    "../secret",
    "..%2f..%2fetc%2fpasswd",
    "/etc/passwd",
    "a/../../b",
    "..\\..\\windows\\system32",
    ".hidden",
    "",
    "a".repeat(129),
    "with space.log",
    "with\0null.log",
    "with\nnewline.log",
  ];
  for (const hostile of hostileNames) {
    it(`rejects hostile name ${JSON.stringify(hostile)}`, () => {
      expect(isValidCrashFileName(hostile)).toBe(false);
      expect(CRASH_FILE_NAME_PATTERN.test(hostile)).toBe(false);
    });
  }
});

describe("listCrashFileMetas", () => {
  it("returns an empty list when the crashes directory does not exist (no crash has ever happened)", () => {
    const dataDir = makeTmpDataDir();
    expect(listCrashFileMetas(dataDir)).toEqual([]);
  });

  it("lists name+sizeBytes+mtimeMs, newest first", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = crashDirPath(dataDir);
    mkdirSync(crashDir, { recursive: true });

    const olderPath = join(crashDir, "crash-old.json");
    const newerPath = join(crashDir, "crash-new.json");
    writeFileSync(olderPath, "old crash content");
    writeFileSync(newerPath, "newer crash content, longer");

    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    utimesSync(olderPath, oldTime, oldTime);
    utimesSync(newerPath, newTime, newTime);

    const files = listCrashFileMetas(dataDir);
    expect(files.map((f) => f.name)).toEqual(["crash-new.json", "crash-old.json"]);
    expect(files[0]!.sizeBytes).toBe(Buffer.byteLength("newer crash content, longer"));
    expect(files[1]!.sizeBytes).toBe(Buffer.byteLength("old crash content"));
    expect(files[0]!.mtimeMs).toBeGreaterThan(files[1]!.mtimeMs);
  });

  it("skips directories under the crashes dir (only regular files)", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = crashDirPath(dataDir);
    mkdirSync(join(crashDir, "a-subdir"), { recursive: true });
    writeFileSync(join(crashDir, "crash-real.json"), "content");

    const files = listCrashFileMetas(dataDir);
    expect(files.map((f) => f.name)).toEqual(["crash-real.json"]);
  });
});

describe("readCrashFileContent", () => {
  it("reads a real file's content by basename", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = crashDirPath(dataDir);
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, "crash-a.json"), '{"redacted":true}');

    expect(readCrashFileContent(dataDir, "crash-a.json")).toBe('{"redacted":true}');
  });

  it("returns null for a nonexistent file", () => {
    const dataDir = makeTmpDataDir();
    expect(readCrashFileContent(dataDir, "crash-nonexistent.json")).toBeNull();
  });

  it("returns null (never throws) for every hostile name, even if a file with that literal name somehow existed one directory up", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = crashDirPath(dataDir);
    mkdirSync(crashDir, { recursive: true });
    // A real secret OUTSIDE the crashes dir, at the position a traversal
    // attempt would target.
    writeFileSync(join(dataDir, "secret.txt"), "top secret");

    for (const hostile of ["../secret.txt", "..", "../../etc/passwd", "/etc/passwd"]) {
      expect(readCrashFileContent(dataDir, hostile)).toBeNull();
    }
  });

  it("returns null for a directory (not a regular file), even with a pattern-valid name", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = crashDirPath(dataDir);
    mkdirSync(join(crashDir, "not-a-file.json"), { recursive: true });

    expect(readCrashFileContent(dataDir, "not-a-file.json")).toBeNull();
  });
});
