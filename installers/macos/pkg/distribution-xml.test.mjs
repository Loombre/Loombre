#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/distribution-xml.test.mjs
//
// AUD-A5b-001: Distribution.xml.tmpl's hostArchitectures used to be
// hardcoded "arm64" for every build, including the supported --arch=x64
// target — an Intel .pkg would declare itself arm64-only and Installer
// would refuse it on the exact Mac it was built for. Confirmed against
// fafa47f before this fix: rendering the (then-unparameterized) template
// for arch=x64 still produced hostArchitectures="arm64".
//
// This imports build-pkg.mjs's own hostArchitecturesFor/renderDistribution-
// Xml (no reimplemented substitution logic to drift from the real build
// path) and, where the Apple toolchain is present, round-trips the
// rendered XML through the REAL pkgbuild + productbuild + pkgutil —
// proving Installer's own tooling accepts and preserves the value, not
// just that the string looks right.
//
// Run: node --test installers/macos/pkg/distribution-xml.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hostArchitecturesFor, renderDistributionXml } from "../build-pkg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "Distribution.xml.tmpl");

test("hostArchitecturesFor maps build --arch to Apple's own identifiers", () => {
  assert.equal(hostArchitecturesFor("arm64"), "arm64");
  // Apple's attribute value, NOT this script's own --arch spelling.
  assert.equal(hostArchitecturesFor("x64"), "x86_64");
  assert.throws(() => hostArchitecturesFor("armv7"));
});

test("renderDistributionXml declares the ONE architecture the build actually shipped", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  for (const [arch, expected] of [
    ["arm64", "arm64"],
    ["x64", "x86_64"],
  ]) {
    const xml = renderDistributionXml({ template, version: "9.9.9", pkgFilename: "loombre-component.pkg", arch });
    const match = xml.match(/hostArchitectures="([^"]*)"/);
    assert.ok(match, `${arch} build: rendered Distribution.xml has no hostArchitectures attribute`);
    assert.equal(
      match[1],
      expected,
      `${arch} build must declare hostArchitectures="${expected}", got "${match[1]}" — this is the exact ` +
        "AUD-A5b-001 defect: an Intel .pkg declaring arm64 refuses to install on the Mac it was built for",
    );
    assert.ok(!xml.includes("__HOST_ARCHITECTURES__"), `${arch}: unsubstituted placeholder leaked into the rendered XML`);
    assert.ok(!xml.includes("__VERSION__") && !xml.includes("__PKG_FILENAME__"), `${arch}: other placeholders left unsubstituted`);
  }
});

const hasAppleTools =
  process.platform === "darwin" &&
  ["pkgbuild", "productbuild", "pkgutil"].every((bin) => spawnSync("which", [bin]).status === 0);

test(
  "productbuild (the real Apple tool) accepts + preserves hostArchitectures for both arches",
  { skip: hasAppleTools ? false : "pkgbuild/productbuild/pkgutil unavailable on this host (non-macOS or no Xcode CLT)" },
  () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const scratch = mkdtempSync(path.join(tmpdir(), "loombre-distxml-test-"));
    try {
      for (const [arch, expected] of [
        ["arm64", "arm64"],
        ["x64", "x86_64"],
      ]) {
        const root = path.join(scratch, arch, "root");
        const out = path.join(scratch, arch, "out");
        const resources = path.join(scratch, arch, "resources");
        mkdirSync(path.join(root, "opt", "loombre-test"), { recursive: true });
        mkdirSync(out, { recursive: true });
        mkdirSync(resources, { recursive: true });
        writeFileSync(path.join(root, "opt", "loombre-test", "marker.txt"), "test\n");
        for (const f of ["welcome.txt", "readme.txt", "conclusion.txt"]) {
          writeFileSync(path.join(resources, f), `${f}\n`);
        }

        const componentPkg = path.join(out, "loombre-component.pkg");
        const pkgbuildRes = spawnSync("pkgbuild", [
          "--root", root,
          "--identifier", "com.loombre.pkg",
          "--version", "9.9.9",
          "--install-location", "/",
          componentPkg,
        ], { encoding: "utf8" });
        assert.equal(pkgbuildRes.status, 0, `pkgbuild (${arch}) failed:\n${pkgbuildRes.stderr}`);

        const distXml = renderDistributionXml({ template, version: "9.9.9", pkgFilename: "loombre-component.pkg", arch });
        const distXmlPath = path.join(out, "Distribution.xml");
        writeFileSync(distXmlPath, distXml, "utf8");

        const finalPkg = path.join(out, `final-${arch}.pkg`);
        const productbuildRes = spawnSync("productbuild", [
          "--distribution", distXmlPath,
          "--package-path", out,
          "--resources", resources,
          finalPkg,
        ], { encoding: "utf8" });
        assert.equal(productbuildRes.status, 0, `productbuild (${arch}) failed:\n${productbuildRes.stderr}`);

        const expandDir = path.join(scratch, arch, "expanded");
        const expandRes = spawnSync("pkgutil", ["--expand-full", finalPkg, expandDir], { encoding: "utf8" });
        assert.equal(expandRes.status, 0, `pkgutil --expand-full (${arch}) failed:\n${expandRes.stderr}`);

        const shippedDistribution = readFileSync(path.join(expandDir, "Distribution"), "utf8");
        const match = shippedDistribution.match(/hostArchitectures="([^"]*)"/);
        assert.ok(match, `${arch}: productbuild's own output Distribution file has no hostArchitectures attribute`);
        assert.equal(
          match[1],
          expected,
          `${arch}: productbuild round-tripped hostArchitectures as "${match[1]}", expected "${expected}"`,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
