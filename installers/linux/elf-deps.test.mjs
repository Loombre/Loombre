// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/elf-deps.test.mjs
//
// Unit tests for installers/linux/lib/elf-deps.mjs — the ELF64 reader the
// native-package builders (build-rpm.mjs / build-deb.mjs) use to DERIVE a
// package's shared-library dependencies from the payload instead of
// hand-maintaining a list that rots with every Node/PostgreSQL/ffmpeg pin.
//
// Three fixture sources, so the reader is checked against the spec AND
// against reality without committing a binary:
//   1. a synthetic ELF64 file assembled here from the ELF layout (header,
//      .dynstr, .dynamic, .gnu.version_r, .shstrtab) — deterministic, runs
//      on every OS;
//   2. /bin/ls when it is an ELF64 binary (Linux CI runners; skipped on the
//      macOS/Windows gate legs) — a real linker output;
//   3. the vendored embedded-PostgreSQL `postgres` binary when
//      vendor/embedded-pg/linux-*/ is present locally (skipped otherwise)
//      — the exact payload the builders scan.
//
// Run: node --test installers/linux/elf-deps.test.mjs (or `pnpm installers:test`).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isElf,
  readElfInfo,
  scanPayloadDeps,
  rpmRequiresFromScan,
  debDependsFromScan,
  DEB_SONAME_PACKAGE_MAP,
} from "./lib/elf-deps.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ─────────────────────────────────────────────────────────────────────────
// Synthetic ELF64 writer (little-endian). Only what the reader needs:
// e_ident/e_machine/e_shoff/e_shnum/e_shstrndx, section headers, a
// .dynstr string table, a .dynamic section (DT_NEEDED/DT_SONAME/DT_RUNPATH),
// and an optional .gnu.version_r (SHT_GNU_verneed) block.
// ─────────────────────────────────────────────────────────────────────────

const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_GNU_VERNEED = 0x6ffffffe;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_SONAME = 14n;
const DT_RUNPATH = 29n;

function buildStringTable(strings) {
  // Index 0 is always the empty string.
  const offsets = new Map([["", 0]]);
  const parts = [Buffer.from([0])];
  let cursor = 1;
  for (const s of strings) {
    if (offsets.has(s)) continue;
    offsets.set(s, cursor);
    const b = Buffer.from(s + "\0", "utf8");
    parts.push(b);
    cursor += b.length;
  }
  return { buffer: Buffer.concat(parts), offsets };
}

/**
 * @param {{ machine?: number, needed?: string[], soname?: string|null, runpath?: string|null,
 *           verneed?: Record<string, string[]>, elfClass?: number, endian?: number }} opts
 */
function buildSyntheticElf(opts = {}) {
  const machine = opts.machine ?? 183; // aarch64
  const needed = opts.needed ?? [];
  const soname = opts.soname ?? null;
  const runpath = opts.runpath ?? null;
  const verneed = opts.verneed ?? {};

  const dynstrNames = [...needed, ...(soname ? [soname] : []), ...(runpath ? [runpath] : [])];
  for (const [lib, versions] of Object.entries(verneed)) dynstrNames.push(lib, ...versions);
  const dynstr = buildStringTable(dynstrNames);

  // .dynamic entries: 16 bytes each (d_tag i64, d_val u64).
  const dynEntries = [];
  for (const n of needed) dynEntries.push([DT_NEEDED, BigInt(dynstr.offsets.get(n))]);
  if (soname) dynEntries.push([DT_SONAME, BigInt(dynstr.offsets.get(soname))]);
  if (runpath) dynEntries.push([DT_RUNPATH, BigInt(dynstr.offsets.get(runpath))]);
  dynEntries.push([DT_NULL, 0n]);
  const dynamic = Buffer.alloc(dynEntries.length * 16);
  dynEntries.forEach(([tag, val], i) => {
    dynamic.writeBigInt64LE(tag, i * 16);
    dynamic.writeBigUInt64LE(val, i * 16 + 8);
  });

  // .gnu.version_r: Verneed (16 bytes) followed by its Vernaux entries (16 bytes each).
  const verneedLibs = Object.entries(verneed);
  const verneedParts = [];
  verneedLibs.forEach(([lib, versions], li) => {
    const vn = Buffer.alloc(16);
    vn.writeUInt16LE(1, 0); // vn_version
    vn.writeUInt16LE(versions.length, 2); // vn_cnt
    vn.writeUInt32LE(dynstr.offsets.get(lib), 4); // vn_file
    vn.writeUInt32LE(16, 8); // vn_aux: first Vernaux follows immediately
    const isLast = li === verneedLibs.length - 1;
    vn.writeUInt32LE(isLast ? 0 : 16 + versions.length * 16, 12); // vn_next
    verneedParts.push(vn);
    versions.forEach((v, vi) => {
      const aux = Buffer.alloc(16);
      aux.writeUInt32LE(0xdeadbeef, 0); // vna_hash (unused by the reader)
      aux.writeUInt16LE(0, 4); // vna_flags
      aux.writeUInt16LE(2 + vi, 6); // vna_other
      aux.writeUInt32LE(dynstr.offsets.get(v), 8); // vna_name
      aux.writeUInt32LE(vi === versions.length - 1 ? 0 : 16, 12); // vna_next
      verneedParts.push(aux);
    });
  });
  const verneedBuf = Buffer.concat(verneedParts);

  const shstr = buildStringTable([".dynstr", ".dynamic", ".gnu.version_r", ".shstrtab"]);

  // Layout: [ELF header 64][.dynstr][.dynamic][.gnu.version_r][.shstrtab][section headers]
  const HDR = 64;
  const dynstrOff = HDR;
  const dynamicOff = dynstrOff + dynstr.buffer.length;
  const verneedOff = dynamicOff + dynamic.length;
  const shstrOff = verneedOff + verneedBuf.length;
  const shOff = shstrOff + shstr.buffer.length;

  // Sections: 0 null, 1 .dynstr, 2 .dynamic, 3 .gnu.version_r (optional), 4 .shstrtab
  const sections = [
    { name: "", type: 0, offset: 0, size: 0, link: 0, info: 0, entsize: 0 },
    { name: ".dynstr", type: SHT_STRTAB, offset: dynstrOff, size: dynstr.buffer.length, link: 0, info: 0, entsize: 0 },
    { name: ".dynamic", type: SHT_DYNAMIC, offset: dynamicOff, size: dynamic.length, link: 1, info: 0, entsize: 16 },
  ];
  if (verneedLibs.length > 0) {
    sections.push({ name: ".gnu.version_r", type: SHT_GNU_VERNEED, offset: verneedOff, size: verneedBuf.length, link: 1, info: verneedLibs.length, entsize: 0 });
  }
  const shstrIndex = sections.length;
  sections.push({ name: ".shstrtab", type: SHT_STRTAB, offset: shstrOff, size: shstr.buffer.length, link: 0, info: 0, entsize: 0 });

  const shdrs = Buffer.alloc(sections.length * 64);
  sections.forEach((s, i) => {
    const o = i * 64;
    shdrs.writeUInt32LE(shstr.offsets.get(s.name) ?? 0, o + 0); // sh_name
    shdrs.writeUInt32LE(s.type, o + 4); // sh_type
    shdrs.writeBigUInt64LE(0n, o + 8); // sh_flags
    shdrs.writeBigUInt64LE(0n, o + 16); // sh_addr
    shdrs.writeBigUInt64LE(BigInt(s.offset), o + 24); // sh_offset
    shdrs.writeBigUInt64LE(BigInt(s.size), o + 32); // sh_size
    shdrs.writeUInt32LE(s.link, o + 40); // sh_link
    shdrs.writeUInt32LE(s.info, o + 44); // sh_info
    shdrs.writeBigUInt64LE(1n, o + 48); // sh_addralign
    shdrs.writeBigUInt64LE(BigInt(s.entsize), o + 56); // sh_entsize
  });

  const hdr = Buffer.alloc(HDR);
  hdr.write("\x7fELF", 0, "latin1");
  hdr[4] = opts.elfClass ?? 2; // ELFCLASS64
  hdr[5] = opts.endian ?? 1; // ELFDATA2LSB
  hdr[6] = 1; // EV_CURRENT
  hdr.writeUInt16LE(3, 16); // e_type ET_DYN
  hdr.writeUInt16LE(machine, 18); // e_machine
  hdr.writeUInt32LE(1, 20); // e_version
  hdr.writeBigUInt64LE(0n, 24); // e_entry
  hdr.writeBigUInt64LE(0n, 32); // e_phoff
  hdr.writeBigUInt64LE(BigInt(shOff), 40); // e_shoff
  hdr.writeUInt32LE(0, 48); // e_flags
  hdr.writeUInt16LE(HDR, 52); // e_ehsize
  hdr.writeUInt16LE(0, 54); // e_phentsize
  hdr.writeUInt16LE(0, 56); // e_phnum
  hdr.writeUInt16LE(64, 58); // e_shentsize
  hdr.writeUInt16LE(sections.length, 60); // e_shnum
  hdr.writeUInt16LE(shstrIndex, 62); // e_shstrndx

  return Buffer.concat([hdr, dynstr.buffer, dynamic, verneedBuf, shstr.buffer, shdrs]);
}

// ─────────────────────────────────────────────────────────────────────────
// isElf / readElfInfo
// ─────────────────────────────────────────────────────────────────────────

test("isElf: recognises the magic and rejects everything else", () => {
  assert.equal(isElf(Buffer.from("\x7fELF\x02\x01", "latin1")), true);
  assert.equal(isElf(Buffer.from("#!/usr/bin/env node\n")), false);
  assert.equal(isElf(Buffer.alloc(0)), false);
  assert.equal(isElf(Buffer.from("\x7fEL", "latin1")), false);
});

test("readElfInfo: synthetic aarch64 shared object — NEEDED, SONAME, RUNPATH, verneed", () => {
  const buf = buildSyntheticElf({
    machine: 183,
    needed: ["libc.so.6", "libssl.so.3", "libpq.so.5"],
    soname: "libexample.so.1",
    runpath: "$ORIGIN/../lib",
    verneed: { "libc.so.6": ["GLIBC_2.17", "GLIBC_2.34", "GLIBC_PRIVATE"], "libstdc++.so.6": ["GLIBCXX_3.4.22"] },
  });
  const info = readElfInfo(buf);
  assert.equal(info.elfClass, 64);
  assert.equal(info.machine, "aarch64");
  assert.deepEqual(info.needed, ["libc.so.6", "libssl.so.3", "libpq.so.5"]);
  assert.equal(info.soname, "libexample.so.1");
  assert.equal(info.runpath, "$ORIGIN/../lib");
  assert.deepEqual(
    [...info.versionNeeds.entries()].map(([k, v]) => [k, [...v].sort()]),
    [
      ["libc.so.6", ["GLIBC_2.17", "GLIBC_2.34", "GLIBC_PRIVATE"]],
      ["libstdc++.so.6", ["GLIBCXX_3.4.22"]],
    ],
  );
});

test("readElfInfo: x86_64 executable with no verneed section and no SONAME", () => {
  const buf = buildSyntheticElf({ machine: 62, needed: ["libc.so.6"] });
  const info = readElfInfo(buf);
  assert.equal(info.machine, "x86_64");
  assert.deepEqual(info.needed, ["libc.so.6"]);
  assert.equal(info.soname, null);
  assert.equal(info.runpath, null);
  assert.equal(info.versionNeeds.size, 0);
});

test("readElfInfo: refuses ELF32 and big-endian files with a clear message", () => {
  assert.throws(() => readElfInfo(buildSyntheticElf({ elfClass: 1 })), /ELF64/);
  assert.throws(() => readElfInfo(buildSyntheticElf({ endian: 2 })), /little-endian/);
  assert.throws(() => readElfInfo(Buffer.from("not an elf at all")), /not an ELF/);
});

// ─────────────────────────────────────────────────────────────────────────
// scanPayloadDeps — the payload walk + exclusion rules
// ─────────────────────────────────────────────────────────────────────────

function withTempPayload(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "loombre-elf-scan-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test("scanPayloadDeps: unions NEEDED, subtracts self-provided sonames and the loader, skips excluded dirs and non-ELF files", () => {
  withTempPayload((root) => {
    put(root, "runtime/node/bin/node", buildSyntheticElf({
      needed: ["libstdc++.so.6", "libc.so.6", "ld-linux-aarch64.so.1", "libdl.so.2"],
      verneed: { "libc.so.6": ["GLIBC_2.28"], "libstdc++.so.6": ["GLIBCXX_3.4.21", "CXXABI_1.3.9"] },
    }));
    put(root, "pg/linux-arm64/18.4.0/bin/psql", buildSyntheticElf({
      needed: ["libpq.so.5", "libreadline.so.8", "libc.so.6"],
      runpath: "$ORIGIN/../lib",
      verneed: { "libc.so.6": ["GLIBC_2.34"] },
    }));
    // Bundled libpq: PROVIDED by the payload -> never an external requirement,
    // and — because it declares a SONAME — its own needs still count even
    // though it sits inside the excluded pg/lib directory (libssl below is
    // needed by nothing else in this fixture).
    put(root, "pg/linux-arm64/18.4.0/lib/libpq.so.5.18", buildSyntheticElf({
      soname: "libpq.so.5",
      needed: ["libssl.so.3", "libc.so.6"],
    }));
    // Optional extension module under pg/lib: EXCLUDED from needs entirely
    // (this is the plpython3 case — would otherwise require libpython3.11).
    put(root, "pg/linux-arm64/18.4.0/lib/plpython3.so", buildSyntheticElf({
      needed: ["libpython3.11.so.1.0", "libc.so.6"],
    }));
    // A shared object WITHOUT a SONAME tag is provided under its file name.
    put(root, "lib/worker/node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.3", buildSyntheticElf({
      needed: ["libstdc++.so.6", "libc.so.6"],
      verneed: { "libstdc++.so.6": ["GLIBCXX_3.4.22"] },
    }));
    put(root, "lib/worker/node_modules/@img/sharp-linux-arm64/lib/sharp.node", buildSyntheticElf({
      needed: ["libvips-cpp.so.8.18.3", "libc.so.6"],
    }));
    // Non-ELF files everywhere are ignored, including ones with .so-ish names.
    put(root, "lib/server/dist/main.js", "#!/usr/bin/env node\nconsole.log('hi')\n");
    put(root, "lib/server/node_modules/foo/libfake.so.1", "not really elf");
    put(root, "VERSION", "1.0.0-beta.1\n");

    const scan = scanPayloadDeps(root, {
      excludeDirs: ["pg/linux-arm64/18.4.0/lib"],
      provideFromExcludedDirs: true,
    });

    assert.deepEqual(scan.externalSonames, [
      "libc.so.6",
      "libdl.so.2",
      "libreadline.so.8",
      "libssl.so.3",
      "libstdc++.so.6",
    ].sort());
    // libpq (excluded dir, but still counted as PROVIDED) and libvips (own
    // file name) are self-provided; the loader is dropped; libpython never
    // appears because plpython3.so was excluded.
    assert.deepEqual(scan.provided, ["libpq.so.5", "libvips-cpp.so.8.18.3"]);
    assert.ok(!scan.externalSonames.includes("libpython3.11.so.1.0"));
    assert.ok(!scan.externalSonames.includes("ld-linux-aarch64.so.1"));
    // Version needs are unioned per soname across every scanned file.
    assert.deepEqual(scan.versionNeeds.get("libc.so.6"), ["GLIBC_2.28", "GLIBC_2.34"]);
    assert.deepEqual(scan.versionNeeds.get("libstdc++.so.6"), ["CXXABI_1.3.9", "GLIBCXX_3.4.21", "GLIBCXX_3.4.22"]);
    assert.deepEqual([...scan.machines], ["aarch64"]);
    assert.equal(scan.files.length, 4, "four ELF files scanned (the excluded dir's two are not in files[])");
  });
});

test("scanPayloadDeps: a payload mixing machine types is reported (a wrong-arch tarball must never package silently)", () => {
  withTempPayload((root) => {
    put(root, "a", buildSyntheticElf({ machine: 62, needed: ["libc.so.6"] }));
    put(root, "b", buildSyntheticElf({ machine: 183, needed: ["libc.so.6"] }));
    const scan = scanPayloadDeps(root, {});
    assert.deepEqual([...scan.machines].sort(), ["aarch64", "x86_64"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rpmRequiresFromScan / debDependsFromScan — the mapping layer
// ─────────────────────────────────────────────────────────────────────────

function fakeScan() {
  return {
    externalSonames: ["libc.so.6", "libssl.so.3", "libstdc++.so.6", "libgssapi_krb5.so.2"],
    versionNeeds: new Map([
      ["libc.so.6", ["GLIBC_2.28", "GLIBC_2.34", "GLIBC_PRIVATE"]],
      ["libstdc++.so.6", ["CXXABI_1.3.9", "GLIBCXX_3.4.22"]],
    ]),
    provided: ["libpq.so.5"],
    machines: new Set(["aarch64"]),
    files: [],
  };
}

test("rpmRequiresFromScan: one bare soname Requires per external lib plus one per (lib, symbol version), 64bit-marked, sorted, GLIBC_PRIVATE dropped", () => {
  const reqs = rpmRequiresFromScan(fakeScan());
  assert.deepEqual(reqs, [
    "libc.so.6()(64bit)",
    "libc.so.6(GLIBC_2.28)(64bit)",
    "libc.so.6(GLIBC_2.34)(64bit)",
    "libgssapi_krb5.so.2()(64bit)",
    "libssl.so.3()(64bit)",
    "libstdc++.so.6()(64bit)",
    "libstdc++.so.6(CXXABI_1.3.9)(64bit)",
    "libstdc++.so.6(GLIBCXX_3.4.22)(64bit)",
  ]);
  assert.ok(!reqs.some((r) => r.includes("PRIVATE")));
  assert.ok(!reqs.some((r) => r.startsWith("libpq")), "self-provided libs never become Requires");
});

test("debDependsFromScan: maps sonames to package alternatives, derives the libc6 floor from the max GLIBC version, sorted and deduped", () => {
  const deps = debDependsFromScan(fakeScan());
  assert.ok(deps.includes("libc6 (>= 2.34)"), `libc6 floor missing: ${deps}`);
  assert.ok(deps.includes("libssl3t64 | libssl3"), `t64 alternative missing: ${deps}`);
  assert.ok(deps.includes("libstdc++6"), deps.join(", "));
  assert.ok(deps.includes("libgssapi-krb5-2"), deps.join(", "));
  assert.deepEqual(deps, [...new Set(deps)].sort(), "sorted + unique");
});

test("debDependsFromScan: an external soname with no package mapping FAILS the build naming it (never silently omitted)", () => {
  const scan = fakeScan();
  scan.externalSonames.push("libwhatever.so.9");
  assert.throws(() => debDependsFromScan(scan), /libwhatever\.so\.9/);
});

test("DEB_SONAME_PACKAGE_MAP covers every soname the 2026-09-05 payload probe found outside pg/lib", () => {
  for (const so of [
    "libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1", "libresolv.so.2",
    "libstdc++.so.6", "libgcc_s.so.1", "libcrypto.so.3", "libssl.so.3", "libgssapi_krb5.so.2",
    "liblz4.so.1", "libreadline.so.8", "libxml2.so.2", "libz.so.1", "libzstd.so.1",
  ]) {
    assert.ok(DEB_SONAME_PACKAGE_MAP[so], `no deb package mapping for ${so}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Real binaries (environment-gated — skipped where absent)
// ─────────────────────────────────────────────────────────────────────────

const BIN_LS = "/bin/ls";
const lsIsElf64 = process.platform === "linux" && existsSync(BIN_LS) && (() => {
  const head = readFileSync(BIN_LS).subarray(0, 5);
  return isElf(head) && head[4] === 2;
})();

test("real binary: /bin/ls on a Linux host needs libc.so.6 with at least one GLIBC_ version", { skip: !lsIsElf64 && "no ELF64 /bin/ls here (not Linux)" }, () => {
  const info = readElfInfo(readFileSync(BIN_LS));
  assert.ok(info.needed.includes("libc.so.6"), `NEEDED: ${info.needed}`);
  const glibc = info.versionNeeds.get("libc.so.6") ?? [];
  assert.ok(glibc.some((v) => /^GLIBC_\d/.test(v)), `verneed for libc.so.6: ${glibc}`);
  assert.ok(["x86_64", "aarch64"].includes(info.machine), info.machine);
});

function findVendoredPostgres() {
  const base = path.join(REPO_ROOT, "vendor", "embedded-pg");
  if (!existsSync(base)) return null;
  for (const platform of readdirSync(base)) {
    if (!platform.startsWith("linux-")) continue;
    for (const version of readdirSync(path.join(base, platform))) {
      const candidate = path.join(base, platform, version, "bin", "postgres");
      if (existsSync(candidate)) return { candidate, platform };
    }
  }
  return null;
}
const vendoredPg = findVendoredPostgres();

test("real binary: the vendored Linux postgres needs libssl/libcrypto/libxml2 and GLIBC_2.34 (the floor the docs state)", { skip: !vendoredPg && "vendor/embedded-pg/linux-* not fetched here" }, () => {
  const info = readElfInfo(readFileSync(vendoredPg.candidate));
  for (const so of ["libssl.so.3", "libcrypto.so.3", "libxml2.so.2", "libgssapi_krb5.so.2", "libz.so.1", "libzstd.so.1", "liblz4.so.1"]) {
    assert.ok(info.needed.includes(so), `${vendoredPg.platform} postgres NEEDED lacks ${so}: ${info.needed}`);
  }
  assert.equal(info.runpath, "$ORIGIN/../lib");
  assert.ok([...(info.versionNeeds.get("libc.so.6") ?? [])].includes("GLIBC_2.34"));
  assert.equal(info.machine, vendoredPg.platform === "linux-arm64" ? "aarch64" : "x86_64");
});
