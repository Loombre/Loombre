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
  permissionRemediation,
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

  // ── rc.6 field screenshot: the 403's `detail` was a wall of text with no
  //    way to act on it in-app. permissionRemediation is the scripted,
  //    real-path-templated counterpart the client renders as a copyable
  //    grant flow instead — macOS + _loombre only, since that is the only
  //    installer this can safely be automated for (see the function's own
  //    doc comment for why Linux stays detail-only). ──
  describe("permissionRemediation (scripted ACL grant, macOS + _loombre only)", () => {
    it("names the blocked account and offers a home-traversal + a targeted grant command for a personal-home path", () => {
      const remediation = permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre");
      expect(remediation).not.toBeNull();
      expect(remediation?.summary).toContain("_loombre");
      expect(remediation?.commands).toHaveLength(2);
      expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /Users/ozzy');
      expect(remediation?.commands[1]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/ozzy/Media',
      );
      expect(remediation?.verify).toBe("sudo -u _loombre ls /Users/ozzy/Media");
    });

    it("shell-quotes a requested path containing a space", () => {
      const remediation = permissionRemediation("/Users/ozzy/My Media", "darwin", "_loombre");
      expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /Users/ozzy');
      expect(remediation?.commands[1]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" \'/Users/ozzy/My Media\'',
      );
      expect(remediation?.verify).toBe("sudo -u _loombre ls '/Users/ozzy/My Media'");
    });

    it("shell-quotes a requested path containing a single quote", () => {
      const remediation = permissionRemediation("/Users/ozzy/O'Brien", "darwin", "_loombre");
      expect(remediation?.commands[1]).toBe(
        "chmod +a \"user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit\" '/Users/ozzy/O'\\''Brien'",
      );
    });

    it("skips the traversal command for a non-home path — only the targeted grant is needed", () => {
      const remediation = permissionRemediation("/Volumes/media", "darwin", "_loombre");
      expect(remediation?.commands).toHaveLength(1);
      expect(remediation?.commands[0]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Volumes/media',
      );
    });

    it("skips the traversal command under /Users/Shared — it is world-readable, no traversal grant needed", () => {
      const remediation = permissionRemediation("/Users/Shared/x", "darwin", "_loombre");
      expect(remediation?.commands).toHaveLength(1);
      expect(remediation?.commands[0]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/Shared/x',
      );
    });

    it("returns null off the macOS+_loombre installer (Linux service account, plain dev host)", () => {
      expect(permissionRemediation("/Users/ozzy/Media", "linux", "loombre")).toBeNull();
      expect(permissionRemediation("/Users/ozzy/Media", "darwin", "ozzy")).toBeNull();
      expect(permissionRemediation("/home/ozzy/Media", "linux", "loombre")).toBeNull();
    });

    // ── BLOCKER (code review): a bare personal home has no ancestor left to
    //    traverse into, so the ONLY remaining command would be the
    //    read+inherit grant on the home folder ITSELF — a one-click-copy
    //    command handing the service account recursive read over the
    //    operator's entire home (~/Library, ~/.ssh included). This is the
    //    picker's most likely path: roots -> /Users -> click your username
    //    -> 403 -> this panel. Never script a whole-home grant. ──
    describe("refuses to script a whole-home grant for a bare personal home (finding 1)", () => {
      it("returns null for /Users/ozzy itself", () => {
        expect(permissionRemediation("/Users/ozzy", "darwin", "_loombre")).toBeNull();
      });

      it("returns null for /Users/ozzy/ (trailing slash)", () => {
        expect(permissionRemediation("/Users/ozzy/", "darwin", "_loombre")).toBeNull();
      });
    });

    // ── MAJOR (code review): Desktop/Documents/Downloads are additionally
    //    locked down by TCC, which ACLs cannot lift — only a one-time Full
    //    Disk Access grant can. Emitting a recipe here sends an operator
    //    through copy -> run -> Check again -> still 403, with the UI
    //    having asserted this was the fix. ──
    describe("returns null for TCC-protected home subfolders instead of a recipe that provably fails (finding 3)", () => {
      it("returns null for a path inside /Users/<name>/Documents", () => {
        expect(permissionRemediation("/Users/ozzy/Documents/Movies", "darwin", "_loombre")).toBeNull();
      });

      it("returns null for /Users/<name>/Downloads itself", () => {
        expect(permissionRemediation("/Users/ozzy/Downloads", "darwin", "_loombre")).toBeNull();
      });

      it("control: an ordinary (non-TCC) home subfolder still gets the normal 2-command recipe", () => {
        const remediation = permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre");
        expect(remediation?.commands).toHaveLength(2);
      });
    });

    // ── MINOR (code review): the controller passes the RAW trimmed query
    //    param while listDirectories() normalizes before ever touching the
    //    filesystem — this function must be self-defending regardless of
    //    caller, or a `..` segment can make the EMITTED grant target a
    //    different path than the one actually denied/browsed. ──
    it("normalizes `..` before templating commands, so a traversal path grants the REAL target (finding 8)", () => {
      const remediation = permissionRemediation("/Users/ozzy/../Shared/Media", "darwin", "_loombre");
      expect(remediation?.commands).toHaveLength(1);
      expect(remediation?.commands[0]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/Shared/Media',
      );
      expect(remediation?.commands.join(" ")).not.toContain("/Users/ozzy");
      expect(remediation?.verify).toBe("sudo -u _loombre ls /Users/Shared/Media");
    });

    // ── MINOR (code review): the default macOS volume is case-insensitive,
    //    so /users/ozzy/Media and /Users/SHARED/x are real, reachable
    //    paths, not typos — the Users/Shared (and Desktop/Documents/
    //    Downloads) checks must not silently misclassify them. Emitted
    //    commands preserve the operator's original casing. ──
    describe("case-insensitive Users/Shared segment matching (finding 9)", () => {
      it("still emits the traversal command for a lowercase /users/ozzy/Media, preserving that casing", () => {
        const remediation = permissionRemediation("/users/ozzy/Media", "darwin", "_loombre");
        expect(remediation?.commands).toHaveLength(2);
        expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /users/ozzy');
        expect(remediation?.commands[1]).toBe(
          'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /users/ozzy/Media',
        );
      });

      it("recognizes /Users/SHARED/x as the world-readable Shared folder — no spurious traversal grant", () => {
        const remediation = permissionRemediation("/Users/SHARED/x", "darwin", "_loombre");
        expect(remediation?.commands).toHaveLength(1);
        expect(remediation?.commands[0]).toBe(
          'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/SHARED/x',
        );
      });
    });
  });
});

// ── MINOR (code review): ProblemException used to spread `extensions` LAST,
//    so an extensions object could override the fixed RFC 9457 fields —
//    forbidden(detail, instance, code, { status: 200 }) produced an HTTP 403
//    whose OWN BODY claimed status 200. Exercised here via `forbidden()`,
//    the same factory browseDirectories() (admin.controller.ts) calls to
//    attach `remediation` as an extensions member on the filesystem-
//    permission-denied 403 this file is otherwise all about. ──
describe("problem.exception forbidden() — reserved fields cannot be overridden by extensions (finding 5)", () => {
  it("keeps the real status/detail/instance even when extensions tries to override them", async () => {
    const { forbidden } = await import("../src/gateway/problem.exception.js");
    const exception = forbidden("real detail", "/real/instance", "real-code", {
      status: 200,
      detail: "fake detail",
      instance: "/fake/instance",
      title: "fake title",
      type: "urn:fake",
      remediation: { summary: "s", commands: ["c"], verify: "v" },
    });
    const body = exception.getResponse() as Record<string, unknown>;
    expect(body["status"]).toBe(403);
    expect(body["detail"]).toBe("real detail");
    expect(body["instance"]).toBe("/real/instance");
    expect(body["title"]).toBe("Forbidden");
    expect(body["type"]).toBe("urn:loombre:problem:forbidden");
    // The legitimate additive extension member survives untouched.
    expect(body["remediation"]).toEqual({ summary: "s", commands: ["c"], verify: "v" });
  });
});
