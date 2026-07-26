// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createFile0600Backend } from "../src/secret/file0600.js";
import { currentUserPrincipal } from "../src/secret/windows-acl.js";
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

// The backend makes ONE guarantee — owner-only access — expressed
// differently per platform, so the assertions are host-aware rather than
// skipped (see src/secret/file0600.ts's header):
//
//   POSIX   — 0600 mode bits.
//   Windows — POSIX bits do not exist (chmod only toggles the read-only
//             attribute; stat() reports 0o666, which is what the first
//             windows-latest CI run failed on: "expected 438 to be 384"),
//             so the guarantee is an explicit owner-only DACL instead.
//             The Windows branch below is the CI assertion that the ACL we
//             set is the ACL actually on disk.
const IS_WINDOWS = process.platform === "win32";

/** icacls output for one file, minus its trailing summary line. */
function readAcl(path: string): string {
  return execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true });
}

describe("file0600 backend", () => {
  it("generates a real random secret and writes it owner-only (0600 on POSIX; owner-only DACL on Windows)", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "nested", "superuser.secret");
    const backend = createFile0600Backend();
    const { ref, value } = await backend.generate(keyPath);

    expect(ref).toEqual({ backend: "file0600", key: keyPath });
    expect(value.length).toBeGreaterThan(20);

    if (IS_WINDOWS) {
      const acl = readAcl(keyPath);

      // (1) Inheritance stripped: icacls marks inherited ACEs "(I)". After
      //     /inheritance:r there must be none — this is what keeps broad
      //     parent-directory grants off the secret.
      expect(acl, acl).not.toMatch(/\(I\)/);

      // (2) No broad principals survived.
      expect(acl, acl).not.toMatch(/BUILTIN\\Users/i);
      expect(acl, acl).not.toMatch(/\bEveryone\b/i);
      expect(acl, acl).not.toMatch(/Authenticated Users/i);

      // (3) Exactly ONE ACE, granting full control. icacls prints the path
      //     and first ACE on line 1, then one ACE per continuation line,
      //     then a summary line. ACEs are matched POSITIVELY on the
      //     "principal:(FLAGS)" shape rather than by filtering the summary
      //     out by its English text, so this does not depend on the
      //     runner's display language.
      const aceLines = acl
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /:\([A-Z]/.test(l));
      expect(aceLines, acl).toHaveLength(1);
      expect(aceLines[0], acl).toMatch(/:\(F\)$/);

      // (4) That one ACE belongs to the account this process runs as.
      const principal = currentUserPrincipal();
      const bareName = principal.startsWith("*") ? userInfo().username : principal;
      expect(aceLines[0]!.toLowerCase(), acl).toContain(bareName.toLowerCase());
    } else {
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(mode & 0o077).toBe(0); // no group/other access, stated explicitly
    }
  });

  it.runIf(IS_WINDOWS)("re-asserts the owner-only DACL on the idempotent path (repairs a secret written before the hardening landed)", async () => {
    const dir = scratchDir();
    const keyPath = join(dir, "superuser.secret");
    const backend = createFile0600Backend();
    const first = await backend.generate(keyPath);

    // Simulate a pre-hardening file by granting a broad principal:
    // BUILTIN\Users by its well-known SID (S-1-5-32-545), so this does not
    // depend on the runner's display language OR on the temp directory
    // happening to carry inheritable ACEs.
    execFileSync("icacls", [keyPath, "/grant", "*S-1-5-32-545:(R)"], { encoding: "utf8", windowsHide: true });
    expect(readAcl(keyPath)).toMatch(/BUILTIN\\Users|S-1-5-32-545/i);

    const second = await backend.generate(keyPath);
    expect(second.value).toBe(first.value); // content untouched

    const acl = readAcl(keyPath);
    expect(acl, acl).not.toMatch(/BUILTIN\\Users|S-1-5-32-545/i); // broad grant revoked
    expect(acl.split(/\r?\n/).filter((l) => /:\([A-Z]/.test(l.trim())), acl).toHaveLength(1);
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
