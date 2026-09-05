// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/lib/elf-deps.mjs
//
// A small, dependency-free ELF64 reader used by the native-package builders
// (installers/linux/build-rpm.mjs, build-deb.mjs) to DERIVE a package's
// shared-library requirements from the payload they are packaging, rather
// than hand-maintaining a list that silently rots every time the Node,
// PostgreSQL, or ffmpeg pin moves (installers/*-manifest.json, the N2/N4
// supported-latest sweeps).
//
// What it reads, per ELF file: DT_NEEDED sonames, DT_SONAME, DT_RUNPATH/
// DT_RPATH, and the GNU symbol-version requirements (.gnu.version_r —
// the `GLIBC_2.34` / `GLIBCXX_3.4.22` strings rpm's own elfdeps turns into
// `libc.so.6(GLIBC_2.34)(64bit)` Requires). Only ELF64 little-endian is
// accepted — both shipped Linux arches (x86_64, aarch64) are exactly that,
// and anything else in a payload is a build error worth surfacing.
//
// Why not rpmbuild's automatic find-requires / dpkg-shlibdeps:
//   - rpm's generators would also emit Requires for every shebang in
//     node_modules (`/usr/bin/python3`, `/bin/sh`, …) and PROVIDES for the
//     bundled libpq.so.5 / libvips under /opt, letting this package satisfy
//     other packages' library dependencies — wrong on both counts.
//   - PostgreSQL's optional extension modules (pg/<platform>/<version>/lib/
//     plpython3.so, pgxml.so, uuid-ossp.so …) link libpython3.11 / libxslt /
//     libossp-uuid. They are dlopen'd only on CREATE EXTENSION, never by the
//     embedded provisioning path, and libpython3.11 exists on no current
//     Fedora. Deriving from them would make the package uninstallable, so
//     callers EXCLUDE that directory from the needs scan while still
//     counting its libpq.so.5 as provided (scanPayloadDeps's
//     excludeDirs / provideFromExcludedDirs).
//   - dpkg-shlibdeps needs the host's shlibs database and a full Debian
//     build environment; the builders run on a macOS dev host and on
//     ubuntu-latest and must produce identical output.
//
// Verified 2026-09-05 against the real 1.0.0-beta.1 linux-arm64 payload
// inside fedora:42 / debian:12 / rockylinux:9 containers (readelf -d / -V):
// the union outside pg/lib is exactly libc/libm/libdl/libpthread/librt/
// libresolv (GLIBC_2.34), libstdc++ (GLIBCXX_3.4.22, CXXABI_1.3.11),
// libgcc_s, libcrypto/libssl (3), libgssapi_krb5, liblz4, libreadline (8),
// libz, libzstd — plus liblzma via the vendored libxml2.so.2 that now sits
// in pg/lib (installers/libxml2-manifest.json), which is why libxml2
// itself is self-provided alongside libpq.so.5 and libvips-cpp.

import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** e_machine → the name rpm/deb tooling uses. Anything else is reported as unknown(N). */
const MACHINE_NAMES = { 62: "x86_64", 183: "aarch64" };

const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_GNU_VERNEED = 0x6ffffffe;

const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_SONAME = 14n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;

/** The dynamic loader is not a library a package Requires — every distro's
 *  glibc ships it, and libc.so.6 is already in the set. */
const LOADER_SONAME_PATTERN = /^ld-linux[-.]|^ld64\.so|^ld\.so/;

/** A shared object is "provided" under its SONAME, or — when it carries no
 *  SONAME tag (sharp's bundled libvips) — under its file name if that looks
 *  like a library. PostgreSQL extension modules (plpython3.so …) have neither
 *  a SONAME nor a lib* name and are correctly NOT counted as provided. */
const LIBRARY_FILENAME_PATTERN = /^lib[^/]*\.so(\.[0-9]+)*$/;

/** @param {Buffer} buf */
export function isElf(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ELF_MAGIC);
}

function readCString(buf, offset, what) {
  if (offset < 0 || offset >= buf.length) throw new Error(`elf-deps: ${what} string offset ${offset} outside the file`);
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.toString("utf8", offset, end);
}

function readSectionHeaders(buf) {
  const shoff = Number(buf.readBigUInt64LE(40));
  const shentsize = buf.readUInt16LE(58);
  const shnum = buf.readUInt16LE(60);
  if (shnum === 0) return [];
  if (shentsize !== 64) throw new Error(`elf-deps: unexpected section header size ${shentsize} (expected 64)`);
  if (shoff + shnum * 64 > buf.length) throw new Error("elf-deps: section header table runs past the end of the file");
  const sections = [];
  for (let i = 0; i < shnum; i += 1) {
    const o = shoff + i * 64;
    sections.push({
      type: buf.readUInt32LE(o + 4),
      offset: Number(buf.readBigUInt64LE(o + 24)),
      size: Number(buf.readBigUInt64LE(o + 32)),
      link: buf.readUInt32LE(o + 40),
      info: buf.readUInt32LE(o + 44),
    });
  }
  return sections;
}

function stringTableFor(buf, sections, section, what) {
  const strtab = sections[section.link];
  if (!strtab || strtab.type !== SHT_STRTAB) throw new Error(`elf-deps: ${what} section links to a non-string-table section`);
  if (strtab.offset + strtab.size > buf.length) throw new Error(`elf-deps: ${what}'s string table runs past the end of the file`);
  return strtab;
}

/**
 * Parse one ELF64 little-endian file.
 *
 * @param {Buffer} buf the whole file
 * @returns {{
 *   elfClass: 64,
 *   machine: string,
 *   needed: string[],
 *   soname: string | null,
 *   runpath: string | null,
 *   versionNeeds: Map<string, Set<string>>,
 * }}
 */
export function readElfInfo(buf) {
  if (!isElf(buf)) throw new Error("elf-deps: not an ELF file");
  if (buf[4] !== 2) throw new Error("elf-deps: only ELF64 is supported (this is an ELF32 file)");
  if (buf[5] !== 1) throw new Error("elf-deps: only little-endian ELF is supported (this file is big-endian)");
  if (buf.length < 64) throw new Error("elf-deps: truncated ELF header");

  const machineCode = buf.readUInt16LE(18);
  const machine = MACHINE_NAMES[machineCode] ?? `unknown(${machineCode})`;
  const sections = readSectionHeaders(buf);

  const needed = [];
  let soname = null;
  let runpath = null;
  const dynamic = sections.find((s) => s.type === SHT_DYNAMIC);
  if (dynamic) {
    const strtab = stringTableFor(buf, sections, dynamic, ".dynamic");
    const entries = Math.floor(dynamic.size / 16);
    if (dynamic.offset + entries * 16 > buf.length) throw new Error("elf-deps: .dynamic runs past the end of the file");
    for (let i = 0; i < entries; i += 1) {
      const o = dynamic.offset + i * 16;
      const tag = buf.readBigInt64LE(o);
      if (tag === DT_NULL) break;
      const val = Number(buf.readBigUInt64LE(o + 8));
      if (tag === DT_NEEDED) needed.push(readCString(buf, strtab.offset + val, "DT_NEEDED"));
      else if (tag === DT_SONAME) soname = readCString(buf, strtab.offset + val, "DT_SONAME");
      else if (tag === DT_RUNPATH) runpath = readCString(buf, strtab.offset + val, "DT_RUNPATH");
      else if (tag === DT_RPATH && runpath === null) runpath = readCString(buf, strtab.offset + val, "DT_RPATH");
    }
  }

  const versionNeeds = new Map();
  const verneed = sections.find((s) => s.type === SHT_GNU_VERNEED);
  if (verneed) {
    const strtab = stringTableFor(buf, sections, verneed, ".gnu.version_r");
    let entryOff = verneed.offset;
    for (let remaining = verneed.info; remaining > 0; remaining -= 1) {
      if (entryOff + 16 > buf.length) throw new Error("elf-deps: .gnu.version_r runs past the end of the file");
      const cnt = buf.readUInt16LE(entryOff + 2);
      const file = readCString(buf, strtab.offset + buf.readUInt32LE(entryOff + 4), "verneed vn_file");
      const auxRel = buf.readUInt32LE(entryOff + 8);
      const next = buf.readUInt32LE(entryOff + 12);
      const versions = versionNeeds.get(file) ?? new Set();
      let auxOff = entryOff + auxRel;
      for (let c = 0; c < cnt; c += 1) {
        if (auxOff + 16 > buf.length) throw new Error("elf-deps: vernaux entry runs past the end of the file");
        versions.add(readCString(buf, strtab.offset + buf.readUInt32LE(auxOff + 8), "vernaux vna_name"));
        const auxNext = buf.readUInt32LE(auxOff + 12);
        if (auxNext === 0) break;
        auxOff += auxNext;
      }
      versionNeeds.set(file, versions);
      if (next === 0) break;
      entryOff += next;
    }
  }

  return { elfClass: 64, machine, needed, soname, runpath, versionNeeds };
}

function readMagic(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    return n === 4 && isElf(head);
  } finally {
    closeSync(fd);
  }
}

function* walkRegularFiles(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // lstat, not stat: a symlinked library is a duplicate of a real file
      // elsewhere in the payload (or dangling) — never follow links.
      const st = lstatSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) yield full;
    }
  }
}

function toPosixRelative(root, full) {
  return path.relative(root, full).split(path.sep).join("/");
}

function providedNameFor(info, relPath) {
  if (info.soname) return info.soname;
  const base = relPath.split("/").at(-1);
  return LIBRARY_FILENAME_PATTERN.test(base) ? base : null;
}

/**
 * Walk a payload tree and derive its external shared-library needs.
 *
 * @param {string} rootDir
 * @param {{ excludeDirs?: string[], provideFromExcludedDirs?: boolean }} [opts]
 *   excludeDirs — payload-relative POSIX paths whose ELF files contribute
 *   nothing to the NEEDED set (PostgreSQL's optional extension modules).
 *   provideFromExcludedDirs (default true) — SONAME-bearing libraries in
 *   those directories (libpq.so.5 lives next to the extension modules)
 *   still count as PROVIDED, and their own NEEDED still count (something
 *   in the payload loads them).
 * @returns {{
 *   externalSonames: string[],
 *   versionNeeds: Map<string, string[]>,
 *   provided: string[],
 *   machines: Set<string>,
 *   files: { path: string, machine: string }[],
 * }}
 */
export function scanPayloadDeps(rootDir, opts = {}) {
  const excludeDirs = (opts.excludeDirs ?? []).map((d) => d.replace(/\\/g, "/").replace(/\/+$/, ""));
  const provideFromExcluded = opts.provideFromExcludedDirs ?? true;

  const needed = new Set();
  const provided = new Set();
  const versionNeeds = new Map();
  const machines = new Set();
  const files = [];

  for (const full of walkRegularFiles(rootDir)) {
    if (!readMagic(full)) continue;
    const rel = toPosixRelative(rootDir, full);
    const excluded = excludeDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
    let info;
    try {
      info = readElfInfo(readFileSync(full));
    } catch (err) {
      throw new Error(`elf-deps: ${rel}: ${err instanceof Error ? err.message : err}`);
    }
    const providedName = providedNameFor(info, rel);
    if (excluded) {
      // Inside an excluded directory only a REAL shared library — one that
      // declares a DT_SONAME (libpq.so.5) — still counts: it is provided,
      // and whatever it links is needed by whoever loads it. Everything
      // else there (extension modules like plpython3.so, pgxs regress
      // binaries) contributes nothing.
      if (!provideFromExcluded || !info.soname) continue;
      provided.add(info.soname);
      for (const so of info.needed) needed.add(so);
      for (const [lib, versions] of info.versionNeeds) {
        const acc = versionNeeds.get(lib) ?? new Set();
        for (const v of versions) acc.add(v);
        versionNeeds.set(lib, acc);
      }
      continue;
    }
    files.push({ path: rel, machine: info.machine });
    machines.add(info.machine);
    if (providedName) provided.add(providedName);
    for (const so of info.needed) needed.add(so);
    for (const [lib, versions] of info.versionNeeds) {
      const acc = versionNeeds.get(lib) ?? new Set();
      for (const v of versions) acc.add(v);
      versionNeeds.set(lib, acc);
    }
  }

  const externalSonames = [...needed]
    .filter((so) => !provided.has(so) && !LOADER_SONAME_PATTERN.test(so))
    .sort();
  const externalSet = new Set(externalSonames);
  const versionNeedsOut = new Map();
  for (const so of externalSonames) {
    const versions = versionNeeds.get(so);
    if (versions && versions.size > 0) versionNeedsOut.set(so, [...versions].sort());
  }
  for (const lib of versionNeeds.keys()) {
    if (!externalSet.has(lib) && !provided.has(lib) && !LOADER_SONAME_PATTERN.test(lib) && needed.has(lib)) {
      versionNeedsOut.set(lib, [...versionNeeds.get(lib)].sort());
    }
  }

  return { externalSonames, versionNeeds: versionNeedsOut, provided: [...provided].sort(), machines, files };
}

/**
 * rpm `Requires:` values in the exact form rpm's own elfdeps generator
 * emits — a bare `soname()(64bit)` per external library plus one
 * `soname(VERSION)(64bit)` per symbol-version dependency. Every rpm-based
 * distro's glibc / libstdc++ / openssl-libs packages Provide these strings
 * (that is how every dynamically linked rpm on the system resolves), so a
 * package built on ubuntu-latest's rpmbuild installs unchanged on Fedora,
 * RHEL 9+, and openSUSE. `*_PRIVATE` versions are glibc-internal and never
 * a Provides, so they are dropped — again exactly what elfdeps does.
 *
 * @param {ReturnType<typeof scanPayloadDeps>} scan
 * @returns {string[]} sorted
 */
export function rpmRequiresFromScan(scan) {
  const out = new Set();
  for (const so of scan.externalSonames) {
    out.add(`${so}()(64bit)`);
    for (const v of scan.versionNeeds.get(so) ?? []) {
      if (/_PRIVATE$/.test(v)) continue;
      out.add(`${so}(${v})(64bit)`);
    }
  }
  return [...out].sort();
}

/**
 * soname → Debian/Ubuntu package expression. Alternatives cover the 64-bit
 * time_t renames Ubuntu 24.04 (and Debian trixie) shipped for a handful of
 * libraries: the `t64` name is listed FIRST so apt on those releases picks
 * the real package, and the pre-rename name second for Debian 12 / Ubuntu
 * 22.04. `libc6` is special-cased: every libc-family soname maps to it and
 * debDependsFromScan attaches the `(>= <max GLIBC_ version>)` floor.
 *
 * An external soname with no entry here FAILS the build (see
 * debDependsFromScan) — a dependency the pipeline does not understand is a
 * packaging problem, not a log line (the same posture as
 * scripts/release/build-manifest.mjs's unrecognised-artifact throw).
 */
export const DEB_SONAME_PACKAGE_MAP = Object.freeze({
  "libc.so.6": "libc6",
  "libm.so.6": "libc6",
  "libdl.so.2": "libc6",
  "libpthread.so.0": "libc6",
  "librt.so.1": "libc6",
  "libresolv.so.2": "libc6",
  "libutil.so.1": "libc6",
  "libstdc++.so.6": "libstdc++6",
  "libgcc_s.so.1": "libgcc-s1 | libgcc1",
  "libatomic.so.1": "libatomic1",
  "libcrypto.so.3": "libssl3t64 | libssl3",
  "libssl.so.3": "libssl3t64 | libssl3",
  "libgssapi_krb5.so.2": "libgssapi-krb5-2",
  "liblz4.so.1": "liblz4-1",
  "libreadline.so.8": "libreadline8t64 | libreadline8",
  "libxml2.so.2": "libxml2",
  "libz.so.1": "zlib1g",
  "libzstd.so.1": "libzstd1",
  "liblzma.so.5": "liblzma5",
});

function maxGlibcVersion(scan) {
  let best = null;
  for (const versions of scan.versionNeeds.values()) {
    for (const v of versions) {
      const m = /^GLIBC_(\d+)\.(\d+)$/.exec(v);
      if (!m) continue;
      const cand = [Number(m[1]), Number(m[2])];
      if (!best || cand[0] > best[0] || (cand[0] === best[0] && cand[1] > best[1])) best = cand;
    }
  }
  return best ? `${best[0]}.${best[1]}` : null;
}

/**
 * Debian `Depends:` entries for the scan — sorted, unique, with the glibc
 * floor derived from the highest GLIBC_x.y symbol version any payload file
 * needs (2.34 for the 2026-09-05 payload, inherited from the PostgreSQL
 * binaries).
 *
 * @param {ReturnType<typeof scanPayloadDeps>} scan
 * @param {Record<string, string>} [map]
 * @returns {string[]}
 */
export function debDependsFromScan(scan, map = DEB_SONAME_PACKAGE_MAP) {
  const unmapped = scan.externalSonames.filter((so) => !map[so]);
  if (unmapped.length > 0) {
    throw new Error(
      `elf-deps: no Debian package mapping for ${unmapped.join(", ")} — the payload now links a library ` +
        "this builder does not know; add it to DEB_SONAME_PACKAGE_MAP (installers/linux/lib/elf-deps.mjs) " +
        "with the right package name for Debian 12+/Ubuntu 22.04+ (and its t64 alternative if renamed).",
    );
  }
  const out = new Set();
  const glibcFloor = maxGlibcVersion(scan);
  for (const so of scan.externalSonames) {
    const expr = map[so];
    out.add(expr === "libc6" && glibcFloor ? `libc6 (>= ${glibcFloor})` : expr);
  }
  return [...out].sort();
}

export { LOADER_SONAME_PATTERN, LIBRARY_FILENAME_PATTERN };
