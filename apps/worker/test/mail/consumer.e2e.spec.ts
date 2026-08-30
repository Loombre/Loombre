// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/mail/consumer.e2e.spec.ts
//
// Optional mail transport run (E5/E6/M7) — drives the REAL nodemailer
// transport (mailSendConsumerHandler's default createTransport, injected
// here only to layer a self-signed-cert override for the STARTTLS cases —
// see createTestTransport's own comment) against an in-process SMTP
// server (smtp-server, nodemailer's own sibling package, MIT-0 — devDep
// only, never shipped). No real network, no real mail provider — proves
// the whole render -> connect -> auth -> DATA pipeline end to end.
//
// A live DB is still required: mailSendConsumerHandler resolves effective
// mail.* settings via loadWorkerEffectiveSettings (a real server_settings
// read) even though every test below writes those settings directly via
// `db`, never through the admin HTTP surface.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { upsertServerSettingAndEmit } from "@loombre/db";
import { resolveLinkSealingSecret, sealLinkToken } from "@loombre/secrets";
import { mailSendConsumerHandler, type MailTransporter } from "../../src/mail/consumer.js";
import { makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

/** Test-only transport factory: layers `tls: {rejectUnauthorized: false}`
 *  on top of buildTransportOptions' output so a STARTTLS handshake against
 *  smtp-server's pregenerated (self-signed, long-expired) localhost cert
 *  succeeds — production code (consumer.ts's default createTransport)
 *  never does this; a real deployment talks to a real mail server with a
 *  real certificate. */
function createTestTransport(options: SMTPTransport.Options): MailTransporter {
  return nodemailer.createTransport({ ...options, tls: { rejectUnauthorized: false } }) as unknown as MailTransporter;
}

let actorUserId: string;

async function setMailSettings(db: ReturnType<typeof makeDb>, values: Record<string, unknown>) {
  const now = Date.now();
  for (const [key, value] of Object.entries(values)) {
    await upsertServerSettingAndEmit(db, { key, value, actorUserId, nowMs: now });
  }
}

describe("mail-send consumer (E5/E6/M7) — real nodemailer against an in-process SMTP server", () => {
  const dbHandle = makeDb();

  beforeAll(async () => {
    resetSchema();
    // upsertServerSettingAndEmit requires an actorUserId (users(id) FK) —
    // this suite writes settings directly (never through the admin HTTP
    // surface), so it creates its own throwaway actor row rather than
    // running the full seed script this file doesn't otherwise need.
    const raw = makeRawClient();
    await raw.connect();
    const result = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, is_admin, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      ["mail-consumer-test-actor", "mail-consumer-test-actor@example.invalid", "x", true, Date.now()],
    );
    actorUserId = result.rows[0]!.id;
    await raw.end();
  });

  afterAll(async () => {
    await dbHandle.destroy();
  });

  describe("success delivery — 'none' security (unauthenticated, plain)", () => {
    let server: SMTPServer;
    let port: number;
    let received: { envelope: { from: string; to: string[] }; message: string } | null = null;

    beforeEach(async () => {
      received = null;
      server = new SMTPServer({
        disabledCommands: ["AUTH", "STARTTLS"],
        onData(stream, session, callback) {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            received = { envelope: { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address) }, message: Buffer.concat(chunks).toString("utf8") };
            callback(null, "Message accepted");
          });
        },
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });
      const address = server.server.address();
      port = typeof address === "object" && address ? address.port : 0;

      await setMailSettings(dbHandle, {
        "mail.smtpHost": "127.0.0.1",
        "mail.smtpPort": port,
        "mail.smtpSecurity": "none",
        "mail.fromAddress": "server@loombre.test",
        "mail.fromName": "Loombre Test",
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("delivers the invite template from a SEALED link (MRV-R1): unsealed at send time, actionUrl built from the CURRENT network.publicUrl (trailing slash stripped); correct envelope/headers, both HTML+text bodies present, zero external resources", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "loombre-mail-link-test-"));
      const env = { ...process.env, LOOMBRE_SMTP_USERNAME: "", LOOMBRE_SMTP_PASSWORD: "", LOOMBRE_SECRET_BACKEND: "file0600", LOOMBRE_DATA_DIR: dataDir };
      // The server half, exactly as mail-dispatch.service.ts performs it:
      // read-or-create the shared sealing key, seal the live token — the
      // payload below carries ONLY the sealed form.
      const sealingSecret = await resolveLinkSealingSecret({ key: join(dataDir, "secrets", "mail-link-sealing-key"), env });
      const sealed = sealLinkToken(sealingSecret, "tok123");
      expect(sealed).not.toContain("tok123");
      await setMailSettings(dbHandle, { "network.publicUrl": "https://loombre.example.com/" });
      const handler = mailSendConsumerHandler({ db: dbHandle, env });

      try {
        await handler(
          { templateId: "invite", to: "recipient@loombre.test", params: { displayName: "Ozzy" }, link: { kind: "claim", sealedToken: sealed } },
          { jobId: "job-success-1" },
        );
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }

      expect(received).not.toBeNull();
      expect(received!.envelope.from).toBe("server@loombre.test");
      expect(received!.envelope.to).toEqual(["recipient@loombre.test"]);
      expect(received!.message).toMatch(/Subject: You're invited to Loombre/i);
      expect(received!.message).toMatch(/Content-Type: text\/html/i);
      expect(received!.message).toMatch(/Content-Type: text\/plain/i);
      expect(received!.message).toContain("https://loombre.example.com/claim/tok123");
      // Zero OTHER http(s) URLs anywhere in the raw message (E7).
      // MIME quoted-printable encoding soft-wraps long lines with a
      // trailing "=\r\n" (removed here before scanning, mirroring what a
      // real QP decoder does — undecoded, a soft break can slice a URL in
      // two at an arbitrary column and produce a spurious short match).
      const dequoted = received!.message.replace(/=\r?\n/g, "");
      const urls = [...new Set((dequoted.match(/https?:\/\/[^\s"'<>=]+/g) ?? []))];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url).toBe("https://loombre.example.com/claim/tok123");
      }
    });

    it("delivers the test template with no params at all", async () => {
      const handler = mailSendConsumerHandler({ db: dbHandle });
      await handler({ templateId: "test", to: "recipient2@loombre.test", params: {} }, { jobId: "job-success-2" });
      expect(received).not.toBeNull();
      expect(received!.message).toMatch(/Subject: Loombre test email/i);
    });

    it("fails a linked template that arrives WITHOUT a sealed link — params can never smuggle an actionUrl back in", async () => {
      const handler = mailSendConsumerHandler({ db: dbHandle, env: { ...process.env, LOOMBRE_SMTP_USERNAME: "", LOOMBRE_SMTP_PASSWORD: "" } });
      await expect(
        handler({ templateId: "password-reset", to: "recipient@loombre.test", params: { actionUrl: "https://smuggled.example.com/reset/x" } }, { jobId: "job-no-link" }),
      ).rejects.toThrow(/requires a sealed link/);
      expect(received).toBeNull();
    });
  });

  describe("success delivery — 'starttls' security", () => {
    let server: SMTPServer;
    let port: number;
    let received: string | null = null;

    beforeEach(async () => {
      received = null;
      server = new SMTPServer({
        disabledCommands: ["AUTH"],
        onData(stream, _session, callback) {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            received = Buffer.concat(chunks).toString("utf8");
            callback(null, "Message accepted");
          });
        },
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });
      const address = server.server.address();
      port = typeof address === "object" && address ? address.port : 0;

      await setMailSettings(dbHandle, {
        "mail.smtpHost": "127.0.0.1",
        "mail.smtpPort": port,
        "mail.smtpSecurity": "starttls",
        "mail.fromAddress": "server@loombre.test",
        "mail.fromName": "Loombre Test",
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("upgrades to TLS via STARTTLS and delivers the message (sealed reset link)", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "loombre-mail-link-starttls-"));
      const env = { ...process.env, LOOMBRE_SMTP_USERNAME: "", LOOMBRE_SMTP_PASSWORD: "", LOOMBRE_SECRET_BACKEND: "file0600", LOOMBRE_DATA_DIR: dataDir };
      const sealingSecret = await resolveLinkSealingSecret({ key: join(dataDir, "secrets", "mail-link-sealing-key"), env });
      const sealed = sealLinkToken(sealingSecret, "abc");
      await setMailSettings(dbHandle, { "network.publicUrl": "https://loombre.example.com" });
      const handler = mailSendConsumerHandler({ db: dbHandle, env, createTransport: createTestTransport });
      try {
        await handler({ templateId: "password-reset", to: "recipient@loombre.test", params: {}, link: { kind: "reset", sealedToken: sealed } }, { jobId: "job-starttls-1" });
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
      expect(received).not.toBeNull();
      expect(received).toMatch(/Subject: Reset your Loombre password/i);
      expect(received!.replace(/=\r?\n/g, "")).toContain("https://loombre.example.com/reset/abc");
    });
  });

  describe("auth-failure fixture (permanent)", () => {
    let server: SMTPServer;
    let port: number;

    beforeEach(async () => {
      server = new SMTPServer({
        disabledCommands: ["STARTTLS"],
        onAuth(_auth, _session, callback) {
          const err = new Error("535 5.7.8 Authentication failed: invalid credentials") as Error & { responseCode?: number };
          err.responseCode = 535;
          callback(err);
        },
        onData(_stream, _session, callback) {
          callback(null, "Message accepted");
        },
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });
      const address = server.server.address();
      port = typeof address === "object" && address ? address.port : 0;

      await setMailSettings(dbHandle, {
        "mail.smtpHost": "127.0.0.1",
        "mail.smtpPort": port,
        "mail.smtpSecurity": "none",
        "mail.fromAddress": "server@loombre.test",
        "mail.fromName": "Loombre Test",
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("throws with the server's REAL error string preserved verbatim (E6/M6: the eventual mail.failed event carries this exact message)", async () => {
      const handler = mailSendConsumerHandler({
        db: dbHandle,
        env: { ...process.env, LOOMBRE_SMTP_USERNAME: "wrong-user", LOOMBRE_SMTP_PASSWORD: "wrong-pass" },
      });

      await expect(
        handler({ templateId: "test", to: "recipient@loombre.test", params: {} }, { jobId: "job-auth-fail" }),
      ).rejects.toThrow(/Authentication failed/);
    });
  });

  describe("retry behavior: a transient failure followed by a re-invocation that succeeds", () => {
    let server: SMTPServer;
    let port: number;
    let attempt = 0;
    let received: string | null = null;

    beforeEach(async () => {
      attempt = 0;
      received = null;
      server = new SMTPServer({
        disabledCommands: ["AUTH", "STARTTLS"],
        onRcptTo(_address, _session, callback) {
          attempt += 1;
          if (attempt === 1) {
            const err = new Error("450 4.2.1 Mailbox temporarily unavailable") as Error & { responseCode?: number };
            err.responseCode = 450;
            return callback(err);
          }
          callback();
        },
        onData(stream, _session, callback) {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            received = Buffer.concat(chunks).toString("utf8");
            callback(null, "Message accepted");
          });
        },
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });
      const address = server.server.address();
      port = typeof address === "object" && address ? address.port : 0;

      await setMailSettings(dbHandle, {
        "mail.smtpHost": "127.0.0.1",
        "mail.smtpPort": port,
        "mail.smtpSecurity": "none",
        "mail.fromAddress": "server@loombre.test",
        "mail.fromName": "Loombre Test",
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("first invocation fails (transient); a second re-invocation (simulating pg-boss's retry re-dispatch) succeeds — the handler is stateless/re-callable", async () => {
      const handler = mailSendConsumerHandler({ db: dbHandle });

      await expect(
        handler({ templateId: "test", to: "recipient@loombre.test", params: {} }, { jobId: "job-retry" }),
      ).rejects.toThrow(/Mailbox temporarily unavailable/);
      expect(received).toBeNull();

      await handler({ templateId: "test", to: "recipient@loombre.test", params: {} }, { jobId: "job-retry" });
      expect(received).not.toBeNull();
    });
  });

  describe("timeout behavior", () => {
    // A genuine "black hole" TCP server (raw net, not smtp-server): accepts
    // the connection and then says NOTHING, ever — smtp-server itself
    // always sends its 220 greeting immediately on connect (a `banner`
    // option only appends optional text to that greeting, it can't be used
    // to suppress it), so it cannot construct this fixture. This is the
    // only reliable way to exercise nodemailer's greetingTimeout.
    let server: import("node:net").Server;
    let port: number;

    beforeEach(async () => {
      const net = await import("node:net");
      server = net.createServer((socket) => {
        socket.on("error", () => {});
        // Deliberately: no data ever written, connection never closed.
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;

      await setMailSettings(dbHandle, {
        "mail.smtpHost": "127.0.0.1",
        "mail.smtpPort": port,
        "mail.smtpSecurity": "none",
        "mail.fromAddress": "server@loombre.test",
        "mail.fromName": "Loombre Test",
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("a hard connection/greeting timeout fails the send within the bounded window, never hangs forever", async () => {
      function createShortTimeoutTransport(options: SMTPTransport.Options): MailTransporter {
        return nodemailer.createTransport({ ...options, connectionTimeout: 300, greetingTimeout: 300, socketTimeout: 300 }) as unknown as MailTransporter;
      }
      const handler = mailSendConsumerHandler({ db: dbHandle, createTransport: createShortTimeoutTransport });

      const start = Date.now();
      await expect(
        handler({ templateId: "test", to: "recipient@loombre.test", params: {} }, { jobId: "job-timeout" }),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(5000);
    });
  });

  describe("unconfigured mail (mail.smtpHost/fromAddress unset)", () => {
    it("throws a clear error rather than attempting to connect anywhere", async () => {
      await setMailSettings(dbHandle, { "mail.smtpHost": "", "mail.fromAddress": "" });
      const handler = mailSendConsumerHandler({ db: dbHandle });
      await expect(
        handler({ templateId: "test", to: "recipient@loombre.test", params: {} }, { jobId: "job-unconfigured" }),
      ).rejects.toThrow(/not configured/);
    });
  });
});
