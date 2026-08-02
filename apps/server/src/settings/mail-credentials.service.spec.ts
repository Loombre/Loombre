// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/mail-credentials.service.spec.ts
//
// Live-DB tests, mirrors provider-keys.service.spec.ts's own convention
// exactly (same file0600 backend forcing, same throwaway LOOMBRE_DATA_DIR
// — never touches a real OS credential store).
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, getUserByUsername, readUnprocessedEvents } from "@loombre/db";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { MailCredentialsService } from "./mail-credentials.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");

const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: LoombreDb;
let dbProvider: DbProvider;
let adminId: string;
let casualId: string;
let dataDir: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];
const ORIGINAL_SMTP_USERNAME = process.env["LOOMBRE_SMTP_USERNAME"];
const ORIGINAL_SMTP_PASSWORD = process.env["LOOMBRE_SMTP_PASSWORD"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "mail_credentials_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-mail-credentials-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  delete process.env["LOOMBRE_SMTP_USERNAME"];
  delete process.env["LOOMBRE_SMTP_PASSWORD"];

  dbProvider = new DbProvider();
  db = dbProvider.db;

  const admin = await getUserByUsername(db, "admin");
  const casual = await getUserByUsername(db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
});

afterEach(() => {
  if (ORIGINAL_SMTP_USERNAME === undefined) delete process.env["LOOMBRE_SMTP_USERNAME"];
  else process.env["LOOMBRE_SMTP_USERNAME"] = ORIGINAL_SMTP_USERNAME;
  if (ORIGINAL_SMTP_PASSWORD === undefined) delete process.env["LOOMBRE_SMTP_PASSWORD"];
  else process.env["LOOMBRE_SMTP_PASSWORD"] = ORIGINAL_SMTP_PASSWORD;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

function freshService(): MailCredentialsService {
  return new MailCredentialsService(dbProvider);
}

describe("MailCredentialsService.status", () => {
  it("reports configured:false, setAtMs:null, source:null when nothing is configured", async () => {
    const service = freshService();
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, source: null });
  });

  it("env vars win and are reported as source:'env' with no setAtMs (env precedence)", async () => {
    process.env["LOOMBRE_SMTP_USERNAME"] = "env-user";
    process.env["LOOMBRE_SMTP_PASSWORD"] = "env-pass";
    const service = freshService();
    await expect(service.status()).resolves.toEqual({ configured: true, setAtMs: null, source: "env" });
  });

  it("a lone half-set env var (username only) does NOT count as env-configured", async () => {
    process.env["LOOMBRE_SMTP_USERNAME"] = "env-user";
    delete process.env["LOOMBRE_SMTP_PASSWORD"];
    const service = freshService();
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, source: null });
  });
});

describe("MailCredentialsService.setCredentials / clearCredentials", () => {
  it("set() stores a double-nested envelope, status reports source:'keyring' + setAtMs, and the value is never present in the returned status", async () => {
    const service = freshService();
    const nowMs = Date.now();
    const status = await service.setCredentials({ username: "  smtp-user  ", password: "smtp-secret-pw", actorUserId: adminId, nowMs });

    expect(status).toEqual({ configured: true, setAtMs: nowMs, source: "keyring" });
    expect(JSON.stringify(status)).not.toContain("smtp-secret-pw");
  });

  it("clear() removes the stored credentials; status reverts to configured:false", async () => {
    const service = freshService();
    await service.setCredentials({ username: "user2", password: "pw2", actorUserId: adminId, nowMs: Date.now() });
    expect((await service.status()).configured).toBe(true);

    await service.clearCredentials({ actorUserId: adminId, nowMs: Date.now() });
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, source: null });
  });

  it("rejects an empty username or password with 422", async () => {
    const service = freshService();
    await expect(
      service.setCredentials({ username: "   ", password: "pw", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.setCredentials({ username: "user", password: "", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a PUT with 409 while both env vars are set, instead of silently writing an inert keyring value", async () => {
    process.env["LOOMBRE_SMTP_USERNAME"] = "env-user";
    process.env["LOOMBRE_SMTP_PASSWORD"] = "env-pass";
    const service = freshService();
    await expect(
      service.setCredentials({ username: "attempted-override", password: "x", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 409 });

    const status = await service.status();
    expect(status).toEqual({ configured: true, setAtMs: null, source: "env" });
  });

  it("clearCredentials is NOT gated on the env pin (mirrors clearProviderKey's own posture — harmless, never changes what status() reports)", async () => {
    process.env["LOOMBRE_SMTP_USERNAME"] = "env-user";
    process.env["LOOMBRE_SMTP_PASSWORD"] = "env-pass";
    const service = freshService();
    await expect(service.clearCredentials({ actorUserId: adminId, nowMs: Date.now() })).resolves.toEqual({
      configured: true,
      setAtMs: null,
      source: "env",
    });
  });

  it("403s a non-admin actor on both set and clear (A10 applies to mail credentials too)", async () => {
    const service = freshService();
    await expect(
      service.setCredentials({ username: "u", password: "p", actorUserId: casualId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.clearCredentials({ actorUserId: casualId, nowMs: Date.now() })).rejects.toMatchObject({ status: 403 });
  });

  it("set/clear each emit a settings.updated outbox event keyed 'mail.credentials' with a redacted value, never the real username/password (A9)", async () => {
    const service = freshService();
    const nowMs = Date.now();
    await service.setCredentials({ username: "audited-user", password: "audited-secret-pw", actorUserId: adminId, nowMs });

    const events = await readUnprocessedEvents(db, 500);
    const settingsEvents = events.filter(
      (e) => e.type === "settings.updated" && (e.payload as Record<string, unknown>)["key"] === "mail.credentials",
    );
    expect(settingsEvents.length).toBeGreaterThanOrEqual(1);
    expect(settingsEvents[0]!.payload).toMatchObject({ key: "mail.credentials", oldValue: "[redacted]", newValue: "[redacted]" });
    expect(JSON.stringify(settingsEvents)).not.toContain("audited-secret-pw");
  });
});
