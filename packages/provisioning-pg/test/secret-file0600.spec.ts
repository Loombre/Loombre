// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile0600Backend } from "../src/secret/file0600.js";
import { generateSecret, resolveSecret } from "../src/secret/resolve.js";
import { UnsupportedSecretBackendError } from "../src/errors.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loombre-provisioning-pg-secret-"));
  cleanupDirs.push(dir);
  return dir;
}

// POSIX permission bits are a POSIX concept: Node's chmod on Windows only
// toggles the read-only attribute, so a file written with mode 0o600 reads
// back as 0o666 there (the first windows-latest CI run failed on exactly
// that: "expected 438 to be 384"). The backend's chmod call is correct and
// unchanged — Windows simply does not implement the bits. Confidentiality
// of the superuser secret on Windows rests on the ACLs of the per-user app-
// data directory it lives in, NOT on this mode; see STATE.md's platform-
// limitation note. The assertion is therefore host-aware rather than
// skipped, so the POSIX guarantee stays enforced where it is real.
const IS_WINDOWS = process.platform === "win32";

describe("file0600 backend", () => {
  it("generates a real random secret and writes it with owner-only POSIX bits (POSIX hosts)", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "nested", "superuser.secret");
    const backend = createFile0600Backend();
    const { ref, value } = await backend.generate(keyPath);

    expect(ref).toEqual({ backend: "file0600", key: keyPath });
    expect(value.length).toBeGreaterThan(20);

    const mode = statSync(keyPath).mode & 0o777;
    if (IS_WINDOWS) {
      // No POSIX bits to assert; prove the file exists and is readable back
      // (the round-trip test below covers content) and that nothing made it
      // executable, which Windows DOES surface.
      expect(mode & 0o111).toBe(0);
    } else {
      expect(mode).toBe(0o600);
      expect(mode & 0o077).toBe(0); // no group/other access, stated explicitly
    }
  });

  it("resolve() reads back exactly what generate() wrote", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "s");
    const backend = createFile0600Backend();
    const { value: generated } = await backend.generate(keyPath);
    const resolved = await backend.resolve({ backend: "file0600", key: keyPath });
    expect(resolved).toBe(generated);
  });

  it("two different keys never collide on the same value", async () => {
    const dir = scratchDir();
    const backend = createFile0600Backend();
    const a = await backend.generate(join(dir, "a"));
    const b = await backend.generate(join(dir, "b"));
    expect(a.value).not.toBe(b.value);
  });

  it("generate() is idempotent — a second call for the same key returns the SAME value, not a rotated one", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "s");
    const backend = createFile0600Backend();
    const first = await backend.generate(keyPath);
    const second = await backend.generate(keyPath);
    expect(second.value).toBe(first.value);
  });

  it("resolve() throws a clear error for a key that was never generated", async () => {
    const dir = scratchDir();
    const backend = createFile0600Backend();
    await expect(backend.resolve({ backend: "file0600", key: join(dir, "never-written") })).rejects.toThrow(/not found/);
  });
});

describe("generateSecret/resolveSecret dispatch (the seam other backends land behind)", () => {
  it("file0600 round-trips through the dispatcher", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "s");
    const { ref, value } = await generateSecret("file0600", keyPath);
    expect(await resolveSecret(ref)).toBe(value);
  });

  it("keychain/dpapi/libsecret are not implemented yet — typed error, not a silent no-op or a crash", async () => {
    await expect(generateSecret("keychain", "whatever")).rejects.toThrow(UnsupportedSecretBackendError);
    await expect(generateSecret("dpapi", "whatever")).rejects.toThrow(UnsupportedSecretBackendError);
    await expect(generateSecret("libsecret", "whatever")).rejects.toThrow(UnsupportedSecretBackendError);
    await expect(resolveSecret({ backend: "keychain", key: "x" })).rejects.toThrow(UnsupportedSecretBackendError);
  });
});
