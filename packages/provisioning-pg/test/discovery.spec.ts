// SPDX-License-Identifier: AGPL-3.0-only
// The worker-side half of the single-provisioner rule (STATE.md P4.2):
// apps/server provisions and OWNS the embedded postmaster; a sibling
// process discovers the SAME database by reading the same secret the
// provisioner wrote, through the same backend seam. These tests pin the
// discovery contract to the WRITER's own primitives (generateSecret /
// buildDatabaseUrl), so the two halves cannot drift apart silently.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  EMBEDDED_PG_DEFAULT_PORT,
  embeddedSuperuserSecretPath,
  resolveEmbeddedDatabaseUrl,
} from "../src/discovery.js";
import { generateSecret, resolveSecret } from "../src/secret/resolve.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "loombre-discovery-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("embeddedSuperuserSecretPath", () => {
  it("is the exact path apps/server's bootstrap provisions to", () => {
    expect(embeddedSuperuserSecretPath(dataDir)).toBe(join(dataDir, "postgres", "superuser.secret"));
  });
});

describe("resolveEmbeddedDatabaseUrl", () => {
  it("returns null while the provisioner has not written the secret yet", async () => {
    await expect(resolveEmbeddedDatabaseUrl({ dataDir })).resolves.toBeNull();
  });

  it("after the provisioner's own generateSecret, returns the URL the supervisor would hand out", async () => {
    const secretPath = embeddedSuperuserSecretPath(dataDir);
    mkdirSync(dirname(secretPath), { recursive: true });
    await generateSecret("file0600", secretPath);
    const secret = await resolveSecret({ backend: "file0600", key: secretPath });

    const url = await resolveEmbeddedDatabaseUrl({ dataDir });
    expect(url).toBe(
      `postgres://loombre:${encodeURIComponent(secret)}@127.0.0.1:${EMBEDDED_PG_DEFAULT_PORT}/loombre`,
    );
  });

  it("honors a non-default port", async () => {
    const secretPath = embeddedSuperuserSecretPath(dataDir);
    mkdirSync(dirname(secretPath), { recursive: true });
    await generateSecret("file0600", secretPath);

    const url = await resolveEmbeddedDatabaseUrl({ dataDir, port: 55_433 });
    expect(url).toContain("@127.0.0.1:55433/");
  });

  it("URL-encodes a secret containing URL-special characters", async () => {
    const secretPath = embeddedSuperuserSecretPath(dataDir);
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, "p@ss:w/ord?&#\n", { mode: 0o600 });

    const url = await resolveEmbeddedDatabaseUrl({ dataDir });
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/ord?&#");
  });
});
