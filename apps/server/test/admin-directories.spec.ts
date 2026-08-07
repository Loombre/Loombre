// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-directories.spec.ts
//
// Real filesystem, real temp trees — the module's whole job is to describe
// a filesystem accurately, and a mocked fs would only prove the mock.
// Windows path behaviour is covered by injecting the platform, since every
// platform-specific bug this project has shipped hid precisely in the gap
// between "works on the dev host" and "works on the other OS".

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DirectoryBrowseError,
  listDirectories,
  listRoots,
  permissionDeniedDetail,
} from "../src/catalog/admin-directories.js";

describe("admin-directories", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "loombre-browse-"));
    mkdirSync(path.join(root, "Movies"));
    mkdirSync(path.join(root, "apples"));
    mkdirSync(path.join(root, "Zebra"));
    mkdirSync(path.join(root, ".hidden"));
    writeFileSync(path.join(root, "notes.txt"), "not a directory");
    symlinkSync(path.join(root, "Movies"), path.join(root, "link-to-movies"), "dir");
    symlinkSync(path.join(root, "does-not-exist"), path.join(root, "broken-link"), "dir");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists only directories — never files", () => {
    const listing = listDirectories(root);
    const names = listing.entries.map((e) => e.name);
    expect(names).toContain("Movies");
    // The single most important assertion in this file: this endpoint must
    // never disclose files, only directory names.
    expect(names).not.toContain("notes.txt");
  });

  it("follows symlinks that point at directories, and skips broken ones", () => {
    const names = listDirectories(root).entries.map((e) => e.name);
    // Symlinked directories are real media layouts (/Volumes, mount farms);
    // refusing them would make ordinary setups unbrowsable.
    expect(names).toContain("link-to-movies");
    expect(names).not.toContain("broken-link");
  });

  it("sorts case-insensitively, the way a file manager does", () => {
    const names = listDirectories(root).entries.map((e) => e.name);
    const relevant = names.filter((n) => ["apples", "Movies", "Zebra"].includes(n));
    expect(relevant).toEqual(["apples", "Movies", "Zebra"]);
  });

  it("returns absolute, ready-to-use paths so the client never joins segments itself", () => {
    const entry = listDirectories(root).entries.find((e) => e.name === "Movies");
    expect(entry?.path).toBe(path.join(root, "Movies"));
    expect(path.isAbsolute(entry?.path ?? "")).toBe(true);
  });

  it("reports the parent for navigation, and null at a filesystem root", () => {
    expect(listDirectories(root).parent).toBe(path.dirname(root));
    // dirname("/") === "/", which would render an "up" control that goes
    // nowhere — null lets the client hide it.
    expect(listDirectories("/").parent).toBeNull();
  });

  it("rejects a relative path instead of resolving it against the server's cwd", () => {
    // The server's working directory differs between installers (a service's
    // cwd is not a shell's) and the operator cannot see it, so resolving
    // against it would be unpredictable rather than convenient.
    expect(() => listDirectories("relative/path")).toThrow(DirectoryBrowseError);
    try {
      listDirectories("relative/path");
    } catch (err) {
      expect((err as DirectoryBrowseError).failure.kind).toBe("not-absolute");
    }
  });

  it("rejects a path containing a NUL byte", () => {
    try {
      listDirectories(`${root}\0/etc`);
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as DirectoryBrowseError).failure.kind).toBe("not-absolute");
    }
  });

  it("distinguishes missing from not-a-directory", () => {
    try {
      listDirectories(path.join(root, "nope"));
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as DirectoryBrowseError).failure.kind).toBe("not-found");
    }
    try {
      listDirectories(path.join(root, "notes.txt"));
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as DirectoryBrowseError).failure.kind).toBe("not-a-directory");
    }
  });

  it("normalizes `..` before reading, so the reported path matches what was listed", () => {
    const listing = listDirectories(path.join(root, "Movies", ".."));
    expect(listing.path).toBe(root);
  });

  describe("windows semantics (platform injected — these paths do not exist on the test host)", () => {
    it("treats a drive-letter path as absolute and a POSIX path as not", () => {
      // path.win32.isAbsolute("/foo") is TRUE, so this asserts the win32
      // helpers are genuinely in play rather than the host's.
      expect(() => listDirectories("C:\\Media", "win32")).toThrow(
        // The path is absolute but does not exist on this host, so it must
        // fail as not-found — NOT as not-absolute.
        DirectoryBrowseError,
      );
      try {
        listDirectories("C:\\Media", "win32");
      } catch (err) {
        expect((err as DirectoryBrowseError).failure.kind).toBe("not-found");
      }
      try {
        listDirectories("Media\\Movies", "win32");
      } catch (err) {
        expect((err as DirectoryBrowseError).failure.kind).toBe("not-absolute");
      }
    });

    it("offers drive letters as roots", () => {
      const listing = listRoots("win32", (p) => p === "C:\\" || p === "D:\\");
      expect(listing.entries.map((e) => e.path)).toEqual(["C:\\", "D:\\"]);
      expect(listing.path).toBeNull();
      expect(listing.parent).toBeNull();
    });
  });

  it("offers only roots that actually exist", () => {
    // A dead-end root is worse than an absent one.
    const listing = listRoots("linux", (p) => p === "/" || p === "/mnt");
    expect(listing.entries.map((e) => e.path)).toEqual(["/", "/mnt"]);
  });

  // ── The macOS field report: /Users lists fine, but every home dir inside
  //    it is 700/750 and the _loombre daemon dead-ends on it with a 403.
  //    The listing must SAY so up front instead of inviting the click. ──
  describe("readable flag", () => {
    // chmod-based unreadability cannot be simulated on Windows, and root
    // (some container CI) reads through 000 modes regardless.
    const canSimulateDenial =
      process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

    it("marks ordinary directories readable", () => {
      const entry = listDirectories(root).entries.find((e) => e.name === "Movies");
      expect(entry?.readable).toBe(true);
    });

    it.runIf(canSimulateDenial)(
      "lists a directory it cannot open with readable:false instead of omitting or failing",
      () => {
        const sealed = path.join(root, "sealed");
        mkdirSync(sealed);
        chmodSync(sealed, 0o000);
        try {
          const entry = listDirectories(root).entries.find((e) => e.name === "sealed");
          // Present — hiding it would misrepresent the filesystem — but
          // honestly marked as a dead end.
          expect(entry).toBeDefined();
          expect(entry?.readable).toBe(false);
        } finally {
          chmodSync(sealed, 0o755);
          rmSync(sealed, { recursive: true, force: true });
        }
      },
    );

    it("flags roots through the same probe (injected, like `exists`)", () => {
      const listing = listRoots(
        "linux",
        (p) => p === "/" || p === "/mnt",
        (p) => p !== "/mnt",
      );
      expect(listing.entries).toEqual([
        { name: "/", path: "/", readable: true },
        { name: "/mnt", path: "/mnt", readable: false },
      ]);
    });
  });

  // ── The other half of the field report: the 403's detail said nothing
  //    actionable. The server knows which service account it runs as and
  //    what the installer's posture is — the detail should say what to DO. ──
  describe("permissionDeniedDetail (403 detail tailored to the actual service account)", () => {
    it("names _loombre and points at /Volumes + /Users/Shared for the macOS installer", () => {
      const detail = permissionDeniedDetail("darwin", "_loombre");
      expect(detail).toContain("_loombre");
      expect(detail).toContain("/Volumes");
      expect(detail).toContain("/Users/Shared");
    });

    it("explains the systemd sandbox for the Linux installer's service account", () => {
      const detail = permissionDeniedDetail("linux", "loombre", false);
      expect(detail).toContain("loombre");
      expect(detail).toContain("ProtectHome");
    });

    it("talks about mount ownership, not systemd, inside a container", () => {
      const detail = permissionDeniedDetail("linux", "loombre", true);
      expect(detail).toContain("mount");
      expect(detail).not.toContain("ProtectHome");
    });

    it("stays generic when not running as an installer service account (dev, Windows)", () => {
      const generic = "The server does not have permission to read that directory.";
      expect(permissionDeniedDetail("darwin", "ozzy")).toBe(generic);
      expect(permissionDeniedDetail("win32", "SYSTEM")).toBe(generic);
      expect(permissionDeniedDetail("linux", "root", false)).toBe(generic);
    });
  });
});
