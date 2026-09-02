// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-directories.spec.ts
//
// Real filesystem, real temp trees — the module's whole job is to describe
// a filesystem accurately, and a mocked fs would only prove the mock.
// Windows path behaviour is covered by injecting the platform, since every
// platform-specific bug this project has shipped hid precisely in the gap
// between "works on the dev host" and "works on the other OS".

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DirectoryBrowseError,
  listDirectories,
  listRoots,
  permissionDeniedDetail,
  permissionRemediation,
  notFoundDetail,
  fsTypeFromMounts,
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
  describe("permissionDeniedDetail (403 detail tailored to the actual service account — and to the path)", () => {
    const generic = "The server does not have permission to read that directory.";

    it("names _loombre and points at /Volumes + /Users/Shared for the macOS installer", () => {
      const detail = permissionDeniedDetail("/Users/ozzy", "darwin", "_loombre", false);
      expect(detail).toContain("_loombre");
      expect(detail).toContain("/Volumes");
      expect(detail).toContain("/Users/Shared");
    });

    describe("Linux installer (systemd units, service account loombre)", () => {
      it("explains ProtectHome for anything under /home, /root or /run/user — no folder permission can help", () => {
        for (const p of ["/home", "/home/ozzy/Media", "/root/media", "/run/user/1000/gvfs"]) {
          const detail = permissionDeniedDetail(p, "linux", "loombre", false);
          expect(detail).toContain("ProtectHome");
          expect(detail).toContain("bind-mount");
          expect(detail).not.toContain("setfacl");
        }
      });

      it("does not mistake /homeless or /rooted for the protected roots", () => {
        expect(permissionDeniedDetail("/homeless/x", "linux", "loombre", false)).not.toContain("ProtectHome");
        expect(permissionDeniedDetail("/rooted/x", "linux", "loombre", false)).not.toContain("ProtectHome");
      });

      it("explains the private per-user mount root for /media/<user>/…", () => {
        const detail = permissionDeniedDetail("/media/ozzy/USB/Movies", "linux", "loombre", false);
        expect(detail).toContain("/media/ozzy");
        expect(detail).toContain("private");
        expect(detail).toContain("setfacl");
      });

      it("points at setfacl — never chown — for any other folder", () => {
        const detail = permissionDeniedDetail("/srv/media", "linux", "loombre", false);
        expect(detail).toContain("loombre");
        expect(detail).toContain("setfacl");
        expect(detail).not.toContain("ProtectHome");
        expect(detail).not.toContain("chown -R");
      });

      it("talks about mount ownership, not systemd, inside a container", () => {
        const detail = permissionDeniedDetail("/media/library", "linux", "loombre", true);
        expect(detail).toContain("bind mount");
        expect(detail).not.toContain("ProtectHome");
      });
    });

    describe("Windows installer (services run as LocalSystem, which userInfo() reports as SYSTEM)", () => {
      it("explains mapped drives and computer-account share access", () => {
        const detail = permissionDeniedDetail("\\\\nas\\media", "win32", "SYSTEM", false);
        expect(detail).toContain("LocalSystem");
        expect(detail).toContain("UNC");
        expect(detail).toContain("computer's account");
      });

      it("matches the account name case-insensitively", () => {
        expect(permissionDeniedDetail("D:\\Media", "win32", "system", false)).toContain("LocalSystem");
      });
    });

    it("stays generic when not running as an installer service account (dev host, Windows desktop, root)", () => {
      expect(permissionDeniedDetail("/x", "darwin", "ozzy", false)).toBe(generic);
      expect(permissionDeniedDetail("C:\\x", "win32", "ozzy", false)).toBe(generic);
      expect(permissionDeniedDetail("/x", "linux", "root", false)).toBe(generic);
      expect(permissionDeniedDetail("/x", "linux", "", false)).toBe(generic);
    });
  });

  // ── A path the service cannot even see is not always "missing": under
  //    LocalSystem a drive letter mapped in the operator's sign-in session
  //    does not exist for the service, and a share may refuse the computer
  //    account — both surface as ENOENT and used to read "No such
  //    directory on the server." ──
  describe("notFoundDetail (404 detail — Windows service account cases)", () => {
    const generic = "No such directory on the server.";

    it("explains a mapped drive letter LocalSystem cannot see, when the drive root does not exist for the service", () => {
      const detail = notFoundDetail("Z:\\Media\\Movies", "win32", "SYSTEM", () => false);
      expect(detail).toContain("Z:");
      expect(detail).toContain("LocalSystem");
      expect(detail).toContain("UNC");
    });

    it("probes the drive ROOT, not the requested path", () => {
      const probe = vi.fn(() => true);
      notFoundDetail("z:/Media/Movies", "win32", "SYSTEM", probe);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith("Z:\\");
    });

    it("stays generic for a drive the service CAN see — the folder is simply missing", () => {
      expect(notFoundDetail("D:\\Media\\Missing", "win32", "SYSTEM", () => true)).toBe(generic);
    });

    it("explains computer-account share access for a UNC path the service could not open", () => {
      const detail = notFoundDetail("\\\\nas\\media\\Movies", "win32", "SYSTEM", () => true);
      expect(detail).toContain("\\\\nas\\media");
      expect(detail).toContain("computer's account");
    });

    it("stays generic off the Windows service account", () => {
      expect(notFoundDetail("Z:\\Media", "win32", "ozzy", () => false)).toBe(generic);
      expect(notFoundDetail("/home/ozzy/Missing", "linux", "loombre", () => false)).toBe(generic);
      expect(notFoundDetail("/Users/ozzy/Missing", "darwin", "_loombre", () => false)).toBe(generic);
    });
  });

  describe("fsTypeFromMounts (deepest mount containing the path, from /proc/self/mounts text)", () => {
    const MOUNTS = [
      "/dev/root / ext4 rw,relatime 0 0",
      "/dev/sdb1 /media/ozzy/USB vfat rw,uid=1000,dmask=0077 0 0",
      "nas:/export /mnt/nas nfs4 rw 0 0",
      "/dev/sdc1 /mnt/nas\\040two ext4 rw 0 0",
      "",
      "garbage-line",
    ].join("\n");

    it("picks the deepest mount point that contains the path", () => {
      expect(fsTypeFromMounts(MOUNTS, "/media/ozzy/USB/Movies")).toBe("vfat");
      expect(fsTypeFromMounts(MOUNTS, "/media/ozzy/USB")).toBe("vfat");
      expect(fsTypeFromMounts(MOUNTS, "/media/ozzy")).toBe("ext4");
      expect(fsTypeFromMounts(MOUNTS, "/mnt/nas/x")).toBe("nfs4");
      expect(fsTypeFromMounts(MOUNTS, "/srv/media")).toBe("ext4");
    });

    it("does not treat /mnt/nasty as inside /mnt/nas, and unescapes octal-encoded spaces in mount points", () => {
      expect(fsTypeFromMounts(MOUNTS, "/mnt/nasty/x")).toBe("ext4");
      expect(fsTypeFromMounts(MOUNTS, "/mnt/nas two/x")).toBe("ext4");
    });

    it("returns null when no mount matches or the text is empty", () => {
      expect(fsTypeFromMounts("", "/srv/media")).toBeNull();
      expect(fsTypeFromMounts("garbage", "/srv/media")).toBeNull();
    });
  });

  // ── rc.6 field screenshot: the 403's `detail` was a wall of text with no
  //    way to act on it in-app. permissionRemediation is the scripted,
  //    real-path-templated counterpart the client renders as a copyable
  //    grant flow instead — macOS + _loombre only, since that is the only
  //    installer this can safely be automated for (see the function's own
  //    doc comment for why Linux stays detail-only). ──
  describe("permissionRemediation (scripted ACL grant, macOS + _loombre only)", () => {
    // The traversal probe is injected at every call site: its default reads
    // the REAL filesystem as the test runner's own account, and /Users/ozzy
    // is traversable on the owner's Mac but does not exist on CI — the
    // recipe's command count would differ by host.
    const NOT_TRAVERSABLE = (): boolean => false;
    const TRAVERSABLE = (): boolean => true;

    it("names the blocked account and offers a home-traversal + a targeted grant command for a personal-home path", () => {
      const remediation = permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre", NOT_TRAVERSABLE);
      expect(remediation).not.toBeNull();
      expect(remediation?.summary).toContain("_loombre");
      expect(remediation?.commands).toHaveLength(2);
      expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /Users/ozzy');
      expect(remediation?.commands[1]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/ozzy/Media',
      );
      expect(remediation?.verify).toBe("sudo -u _loombre ls /Users/ozzy/Media");
      // The scope note says what the grant exposes — and that the traversal
      // half reveals nothing inside the home folder.
      expect(remediation?.note).toContain("/Users/ozzy");
      expect(remediation?.note).toContain("nothing else in your home folder");
      // The native-helper handoff (menubar app's loombre://grant scheme):
      // the same recipe, as a URL the app re-validates and applies with a
      // consent dialog. `traverse` rides along only when the home cannot be
      // walked yet — exactly when command 1 is emitted.
      expect(remediation?.nativeGrantUrl).toBe(
        "loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMedia&traverse=%2FUsers%2Fozzy",
      );
    });

    // ── The two-step picker flow: once step 1 (the names-only grant on the
    //    home folder, below) has been run, the service account CAN already
    //    walk through the home, and repeating the traversal grant would
    //    tell the operator to run a command they have already run. The
    //    probe answers as the account the server runs as. ──
    describe("home-traversal command is skipped once the service account can already walk the home", () => {
      it("emits only the targeted grant when the probe says the home is traversable", () => {
        const remediation = permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre", TRAVERSABLE);
        expect(remediation?.commands).toHaveLength(1);
        expect(remediation?.commands[0]).toBe(
          'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/ozzy/Media',
        );
        expect(remediation?.note).not.toContain("/Users/ozzy ");
        expect(remediation?.note).toContain("nothing else in your home folder");
        expect(remediation?.nativeGrantUrl).toBe("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMedia");
      });

      it("probes exactly the home folder, and never for a path outside a personal home", () => {
        const probe = vi.fn(() => false);
        permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre", probe);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledWith("/Users/ozzy");

        probe.mockClear();
        permissionRemediation("/Volumes/media", "darwin", "_loombre", probe);
        permissionRemediation("/Users/Shared/x", "darwin", "_loombre", probe);
        permissionRemediation("/Users/ozzy", "darwin", "_loombre", probe);
        expect(probe).not.toHaveBeenCalled();
      });
    });

    it("shell-quotes a requested path containing a space", () => {
      const remediation = permissionRemediation("/Users/ozzy/My Media", "darwin", "_loombre", NOT_TRAVERSABLE);
      expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /Users/ozzy');
      expect(remediation?.commands[1]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" \'/Users/ozzy/My Media\'',
      );
      expect(remediation?.verify).toBe("sudo -u _loombre ls '/Users/ozzy/My Media'");
    });

    it("shell-quotes a requested path containing a single quote", () => {
      const remediation = permissionRemediation("/Users/ozzy/O'Brien", "darwin", "_loombre", NOT_TRAVERSABLE);
      expect(remediation?.commands[1]).toBe(
        "chmod +a \"user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit\" '/Users/ozzy/O'\\''Brien'",
      );
    });

    it("skips the traversal command for a non-home path — only the targeted grant is needed", () => {
      const remediation = permissionRemediation("/Volumes/media", "darwin", "_loombre", NOT_TRAVERSABLE);
      expect(remediation?.commands).toHaveLength(1);
      expect(remediation?.commands[0]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Volumes/media',
      );
      expect(remediation?.note).toContain("everything added to it later");
      expect(remediation?.note).not.toContain("home folder");
      expect(remediation?.nativeGrantUrl).toBe("loombre://grant?v=1&scope=read&path=%2FVolumes%2Fmedia");
    });

    it("percent-encodes the path in the native grant URL, so spaces and '&' cannot split the query", () => {
      const remediation = permissionRemediation("/Users/ozzy/My Media & More", "darwin", "_loombre", TRAVERSABLE);
      expect(remediation?.nativeGrantUrl).toBe(
        "loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMy%20Media%20%26%20More",
      );
    });

    it("skips the traversal command under /Users/Shared — it is world-readable, no traversal grant needed", () => {
      const remediation = permissionRemediation("/Users/Shared/x", "darwin", "_loombre", NOT_TRAVERSABLE);
      expect(remediation?.commands).toHaveLength(1);
      expect(remediation?.commands[0]).toBe(
        'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/Shared/x',
      );
    });

    it("returns null off the installers' service accounts (plain dev host, Windows desktop)", () => {
      expect(permissionRemediation("/Users/ozzy/Media", "darwin", "ozzy")).toBeNull();
      expect(permissionRemediation("/srv/media", "linux", "ozzy")).toBeNull();
      expect(permissionRemediation("D:\\Media", "win32", "ozzy")).toBeNull();
      // Windows services run as LocalSystem, which reads every local volume;
      // a share is a share-permission question, not an ACL recipe.
      expect(permissionRemediation("\\\\nas\\media", "win32", "SYSTEM")).toBeNull();
    });

    // ── A bare personal home is the picker's most likely path: roots ->
    //    /Users -> click your username -> 403. It is also the ONLY path the
    //    picker can lead to for home-folder media, because listing the home
    //    is exactly what is denied — so refusing this case outright (the
    //    previous behaviour) left the whole grant flow unreachable in
    //    practice (FPG-1). The recipe here honours the underlying
    //    constraint — never script a whole-home read — without refusing: a
    //    NON-inheriting list+search grant on the home reveals only the
    //    names directly inside it (700 folders — Library, .ssh, Documents…
    //    — stay closed), and the media folder's own read grant follows as a
    //    second step once it can be clicked. ──
    describe("bare personal home: a names-only listing grant, never a whole-home read (step 1 of 2)", () => {
      it("emits a single non-inheriting list+search grant on the home folder itself", () => {
        const remediation = permissionRemediation("/Users/ozzy", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation).not.toBeNull();
        expect(remediation?.summary).toContain("_loombre");
        expect(remediation?.commands).toEqual(['chmod +a "user:_loombre allow list,search" /Users/ozzy']);
        expect(remediation?.verify).toBe("sudo -u _loombre ls /Users/ozzy");
        expect(remediation?.nativeGrantUrl).toBe("loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fozzy");
      });

      it("never grants read, execute, or the inherit flags on the home folder", () => {
        const remediation = permissionRemediation("/Users/ozzy", "darwin", "_loombre", NOT_TRAVERSABLE);
        const joined = remediation?.commands.join(" ") ?? "";
        expect(joined).not.toContain("read");
        expect(joined).not.toContain("execute");
        expect(joined).not.toContain("inherit");
      });

      it("says the grant reveals names only and that the media folder's grant is the next step", () => {
        const remediation = permissionRemediation("/Users/ozzy", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.note).toContain("names");
        expect(remediation?.note).toContain("next step");
      });

      it("treats /Users/ozzy/ (trailing slash) as the same bare home", () => {
        const remediation = permissionRemediation("/Users/ozzy/", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.commands).toEqual(['chmod +a "user:_loombre allow list,search" /Users/ozzy']);
      });

      it("shell-quotes a home folder name containing a space", () => {
        const remediation = permissionRemediation("/Users/o zzy", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.commands).toEqual(["chmod +a \"user:_loombre allow list,search\" '/Users/o zzy'"]);
        expect(remediation?.verify).toBe("sudo -u _loombre ls '/Users/o zzy'");
      });
    });

    // ── MAJOR (code review): Desktop/Documents/Downloads are additionally
    //    locked down by TCC, which ACLs cannot lift — only a one-time Full
    //    Disk Access grant can. Emitting a recipe here sends an operator
    //    through copy -> run -> Check again -> still 403, with the UI
    //    having asserted this was the fix. ──
    describe("returns null for TCC-protected home subfolders instead of a recipe that provably fails (finding 3)", () => {
      it("returns null for a path inside /Users/<name>/Documents", () => {
        expect(permissionRemediation("/Users/ozzy/Documents/Movies", "darwin", "_loombre", NOT_TRAVERSABLE)).toBeNull();
      });

      it("returns null for /Users/<name>/Downloads itself", () => {
        expect(permissionRemediation("/Users/ozzy/Downloads", "darwin", "_loombre", NOT_TRAVERSABLE)).toBeNull();
      });

      it("control: an ordinary (non-TCC) home subfolder still gets the normal 2-command recipe", () => {
        const remediation = permissionRemediation("/Users/ozzy/Media", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.commands).toHaveLength(2);
      });
    });

    // ── MINOR (code review): the controller passes the RAW trimmed query
    //    param while listDirectories() normalizes before ever touching the
    //    filesystem — this function must be self-defending regardless of
    //    caller, or a `..` segment can make the EMITTED grant target a
    //    different path than the one actually denied/browsed. ──
    it("normalizes `..` before templating commands, so a traversal path grants the REAL target (finding 8)", () => {
      const remediation = permissionRemediation("/Users/ozzy/../Shared/Media", "darwin", "_loombre", NOT_TRAVERSABLE);
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
        const remediation = permissionRemediation("/users/ozzy/Media", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.commands).toHaveLength(2);
        expect(remediation?.commands[0]).toBe('chmod +a "user:_loombre allow search" /users/ozzy');
        expect(remediation?.commands[1]).toBe(
          'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /users/ozzy/Media',
        );
      });

      it("recognizes /Users/SHARED/x as the world-readable Shared folder — no spurious traversal grant", () => {
        const remediation = permissionRemediation("/Users/SHARED/x", "darwin", "_loombre", NOT_TRAVERSABLE);
        expect(remediation?.commands).toHaveLength(1);
        expect(remediation?.commands[0]).toBe(
          'chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/SHARED/x',
        );
      });
    });

    // ── Linux installer: the same flow, scripted with POSIX ACLs. setfacl is
    //    additive and revocable, unlike the chown -R the install guide used
    //    to prescribe (which takes the files away from the operator). What
    //    is NOT scripted: anything under systemd's ProtectHome roots (an
    //    inaccessible mount no ACL can lift), filesystems without POSIX
    //    ACLs (setfacl would just fail), and containers (host-side fix). ──
    describe("Linux installer: a setfacl recipe (additive, revocable — never chown)", () => {
      const EXT4 = (): string | null => "ext4";
      const UNKNOWN_FS = (): string | null => null;
      const PASSABLE = (): boolean => true;
      const NOT_CONTAINER = false;

      it("emits traverse-only grants for the blocked ancestors, then a recursive read + default-ACL grant on the folder", () => {
        // /media/ozzy is the desktop's private per-user mount root — the
        // first ancestor the service cannot pass through; everything below
        // it is unreachable for the probe and is granted traversal too.
        const canTraverse = (p: string): boolean => p === "/media";
        const r = permissionRemediation("/media/ozzy/USB/Movies", "linux", "loombre", canTraverse, NOT_CONTAINER, EXT4);
        expect(r?.summary).toContain("loombre");
        expect(r?.commands).toEqual([
          "sudo setfacl -m u:loombre:x /media/ozzy /media/ozzy/USB",
          "sudo setfacl -R -m u:loombre:rX,d:u:loombre:rX /media/ozzy/USB/Movies",
        ]);
        expect(r?.verify).toBe("sudo -u loombre ls /media/ozzy/USB/Movies");
        expect(r?.note).toContain("/media/ozzy");
        expect(r?.note).toContain("Operation not supported");
        // No native helper on Linux — the commands are the whole recipe.
        expect(r?.nativeGrantUrl).toBeUndefined();
      });

      it("stops probing at the first blocked ancestor — deeper ones are unreachable regardless", () => {
        const probe = vi.fn((p: string) => p === "/media");
        permissionRemediation("/media/ozzy/USB/Movies", "linux", "loombre", probe, NOT_CONTAINER, EXT4);
        expect(probe.mock.calls.map((c) => c[0])).toEqual(["/media", "/media/ozzy"]);
      });

      it("omits the traversal command when every ancestor is already passable", () => {
        const r = permissionRemediation("/srv/media", "linux", "loombre", PASSABLE, NOT_CONTAINER, EXT4);
        expect(r?.commands).toEqual(["sudo setfacl -R -m u:loombre:rX,d:u:loombre:rX /srv/media"]);
        expect(r?.note).not.toContain("pass through");
      });

      it("shell-quotes paths with spaces, and normalizes a trailing slash away", () => {
        const r = permissionRemediation("/srv/My Media/", "linux", "loombre", PASSABLE, NOT_CONTAINER, EXT4);
        expect(r?.commands).toEqual(["sudo setfacl -R -m u:loombre:rX,d:u:loombre:rX '/srv/My Media'"]);
        expect(r?.verify).toBe("sudo -u loombre ls '/srv/My Media'");
      });

      it("never scripts anything under ProtectHome's hidden roots — no ACL can lift a systemd mount", () => {
        expect(permissionRemediation("/home/ozzy/Media", "linux", "loombre", PASSABLE, NOT_CONTAINER, EXT4)).toBeNull();
        expect(permissionRemediation("/root/media", "linux", "loombre", PASSABLE, NOT_CONTAINER, EXT4)).toBeNull();
        expect(permissionRemediation("/run/user/1000/gvfs/x", "linux", "loombre", PASSABLE, NOT_CONTAINER, EXT4)).toBeNull();
      });

      it("returns null on filesystems without POSIX ACLs (FAT/exFAT/NTFS/FUSE/network) — setfacl would only fail", () => {
        for (const fs of ["vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "fuse.sshfs", "cifs", "nfs", "nfs4"]) {
          expect(permissionRemediation("/media/ozzy/USB", "linux", "loombre", PASSABLE, NOT_CONTAINER, () => fs)).toBeNull();
        }
      });

      it("still offers the recipe when the filesystem type cannot be determined", () => {
        expect(permissionRemediation("/srv/media", "linux", "loombre", PASSABLE, NOT_CONTAINER, UNKNOWN_FS)).not.toBeNull();
      });

      it("returns null inside a container — the fix is on the host", () => {
        expect(permissionRemediation("/media/library", "linux", "loombre", PASSABLE, true, EXT4)).toBeNull();
      });

      it("returns null off the installer's service account", () => {
        expect(permissionRemediation("/srv/media", "linux", "root", PASSABLE, NOT_CONTAINER, EXT4)).toBeNull();
        expect(permissionRemediation("/srv/media", "linux", "ozzy", PASSABLE, NOT_CONTAINER, EXT4)).toBeNull();
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
