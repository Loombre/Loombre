// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/manual-provider.spec.ts
//
// Real filesystem, real fs.watch, real debounce timing — no fakes. Proves
// LOOMBRE_TLS_MODE=manual's hot-reload actually reacts to a file change
// (both a plain overwrite and a certbot-style rename-over-the-path swap).

import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSelfSignedCert, type SelfSignedCert } from "./test-support/self-signed-cert.js";
import { readManualCertificate, watchManualCertificate } from "./manual-provider.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("readManualCertificate", () => {
  let dir: string;
  let cert: SelfSignedCert;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loombre-manual-tls-"));
    cert = generateSelfSignedCert("read.loombre.test");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    cert.cleanup();
  });

  it("reads cert+key (and ca, when present) as utf8", () => {
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, cert.cert);
    writeFileSync(keyPath, cert.key);
    expect(readManualCertificate({ certPath, keyPath })).toEqual({ cert: cert.cert, key: cert.key });

    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, cert.cert);
    expect(readManualCertificate({ certPath, keyPath, caPath })).toEqual({ cert: cert.cert, key: cert.key, ca: cert.cert });
  });
});

describe("watchManualCertificate: real fs.watch, real debounce", () => {
  let dir: string;
  let certA: SelfSignedCert;
  let certB: SelfSignedCert;
  let certPath: string;
  let keyPath: string;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loombre-manual-watch-"));
    certA = generateSelfSignedCert("a.loombre.test");
    certB = generateSelfSignedCert("b.loombre.test");
    certPath = join(dir, "cert.pem");
    keyPath = join(dir, "key.pem");
    writeFileSync(certPath, certA.cert);
    writeFileSync(keyPath, certA.key);
  });
  afterEach(() => {
    stop?.();
    rmSync(dir, { recursive: true, force: true });
    certA.cleanup();
    certB.cleanup();
  });

  it("fires onChange with the freshly re-read material after a plain overwrite", async () => {
    const changes: string[] = [];
    stop = watchManualCertificate({ certPath, keyPath }, (material) => changes.push(material.cert), { debounceMs: 30 });

    await sleep(50); // let the watcher actually attach before we mutate
    writeFileSync(certPath, certB.cert);
    writeFileSync(keyPath, certB.key);

    await vi_waitFor(() => changes.length > 0, 3000);
    expect(changes.at(-1)).toBe(certB.cert);
  });

  it("fires onChange after a certbot-style rename-over-the-path swap", async () => {
    const changes: string[] = [];
    stop = watchManualCertificate({ certPath, keyPath }, (material) => changes.push(material.cert), { debounceMs: 30 });

    await sleep(50);
    const newCertPath = join(dir, "cert.pem.new");
    const newKeyPath = join(dir, "key.pem.new");
    writeFileSync(newCertPath, certB.cert);
    writeFileSync(newKeyPath, certB.key);
    renameSync(newCertPath, certPath);
    renameSync(newKeyPath, keyPath);

    await vi_waitFor(() => changes.length > 0, 3000);
    expect(changes.at(-1)).toBe(certB.cert);
  });

  it("debounces rapid successive writes into a single reload", async () => {
    const changes: string[] = [];
    stop = watchManualCertificate({ certPath, keyPath }, (material) => changes.push(material.cert), { debounceMs: 100 });

    await sleep(50);
    writeFileSync(certPath, certB.cert);
    writeFileSync(keyPath, certA.key); // still A's key for a moment — a torn pair
    await sleep(10);
    writeFileSync(keyPath, certB.key); // now consistent

    await vi_waitFor(() => changes.length > 0, 3000);
    // Debounce should have collapsed the burst into exactly one reload.
    expect(changes.length).toBe(1);
    expect(changes[0]).toBe(certB.cert);
  });

  it("stop() closes the watchers — no further onChange calls after stopping", async () => {
    const changes: string[] = [];
    stop = watchManualCertificate({ certPath, keyPath }, (material) => changes.push(material.cert), { debounceMs: 20 });
    await sleep(50);
    stop();
    stop = undefined;

    writeFileSync(certPath, certB.cert);
    writeFileSync(keyPath, certB.key);
    await sleep(200);
    expect(changes).toEqual([]);
  });
});

/** Small polling helper — vitest doesn't ship a generic waitFor, and this
 *  suite's assertions are all "eventually true" against real fs events. */
async function vi_waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}
