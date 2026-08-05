// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCloudflaredBinary } from "./resolve-cloudflared-binary.js";

let scratch: string;
let originalPath: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loombre-cloudflared-resolve-"));
  originalPath = process.env["PATH"];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
});

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

describe("resolveCloudflaredBinary — setting override", () => {
  it("uses the configured path when it is an executable file", () => {
    const bin = join(scratch, "my-cloudflared");
    makeExecutable(bin);
    const result = resolveCloudflaredBinary(bin);
    expect(result).toEqual({ ok: true, binary: { path: bin, source: "setting" } });
  });

  it("trims whitespace around the configured path", () => {
    const bin = join(scratch, "my-cloudflared");
    makeExecutable(bin);
    const result = resolveCloudflaredBinary(`  ${bin}  `);
    expect(result).toEqual({ ok: true, binary: { path: bin, source: "setting" } });
  });

  // Skipped on Windows: there is no POSIX execute bit, so accessSync(_, X_OK)
  // succeeds for any existing regular file — an "exists but not executable"
  // path cannot be manufactured there. The ok:false + detail rejection is
  // still exercised on Windows by the "does not exist at all" test below
  // (accessSync throws ENOENT → not executable → ok:false), so no coverage
  // of resolveCloudflaredBinary's failure path is lost.
  it.skipIf(process.platform === "win32")("fails with a helpful detail when the configured path is not executable", () => {
    const bin = join(scratch, "not-executable");
    writeFileSync(bin, "not a binary");
    const result = resolveCloudflaredBinary(bin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain(bin);
  });

  it("fails with a helpful detail when the configured path does not exist at all", () => {
    const result = resolveCloudflaredBinary(join(scratch, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("not an executable file");
  });
});

describe("resolveCloudflaredBinary — PATH scan fallback", () => {
  it("finds an executable named 'cloudflared' on PATH when no setting is configured", () => {
    const bin = join(scratch, process.platform === "win32" ? "cloudflared.EXE" : "cloudflared");
    makeExecutable(bin);
    process.env["PATH"] = scratch;
    const result = resolveCloudflaredBinary("");
    expect(result).toEqual({ ok: true, binary: { path: bin, source: "path" } });
  });

  it("treats a whitespace-only setting the same as empty (falls through to PATH)", () => {
    const bin = join(scratch, process.platform === "win32" ? "cloudflared.EXE" : "cloudflared");
    makeExecutable(bin);
    process.env["PATH"] = scratch;
    const result = resolveCloudflaredBinary("   ");
    expect(result.ok).toBe(true);
  });

  it("fails with a helpful detail when nothing is configured and PATH has no cloudflared", () => {
    process.env["PATH"] = scratch;
    const result = resolveCloudflaredBinary("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("cloudflared");
      expect(result.detail).toContain("PATH");
    }
  });

  it("never auto-downloads or executes anything — a missing binary is just a typed failure", () => {
    process.env["PATH"] = "";
    expect(() => resolveCloudflaredBinary("")).not.toThrow();
  });
});
