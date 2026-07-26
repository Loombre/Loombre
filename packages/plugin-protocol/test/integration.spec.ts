// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/integration.spec.ts
//
// Boots BOTH reference plugins (examples/lpp-reference-provider,
// examples/lpp-discord-notifier) as real child processes on EPHEMERAL
// ports (listen(0) only — hard environment rule: never touch a fixed
// port), and runs the full `runLppConformance` suite against each
// programmatically. This is the mission's exit proof: "Both must pass
// their conformance suites."
//
// The notifier check additionally proves the "actually POSTs to the
// configured URL" requirement: a tiny local ephemeral HTTP server stands
// in for the webhook, and the test asserts it received exactly one
// forwarded message — from the conformance suite's valid-signature batch
// only, since the tampered-body/stale-timestamp batches must be rejected
// by the notifier BEFORE it ever reads the batch to forward anything
// (proving the "SHOULD" checks are genuinely enforced by this reference
// implementation, not just tolerated as warnings).
//
// No fixed ports, no docker, no shared dev database — every server here is
// a plain `node` child process bound to 127.0.0.1:0.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runLppConformance } from "../src/conform/run.js";
import { generateLppSigningSecret } from "../src/signature.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

interface SpawnedServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnNodeServer(scriptPath: string, env: NodeJS.ProcessEnv): Promise<SpawnedServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: dirname(scriptPath),
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let settled = false;
    const stderrChunks: string[] = [];

    const onStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(stdoutBuffer);
      if (match && !settled) {
        settled = true;
        const port = Number(match[1]);
        resolve({
          child,
          baseUrl: `http://127.0.0.1:${port}`,
          stop: () =>
            new Promise<void>((res) => {
              child.once("exit", () => res());
              child.kill();
            }),
        });
      }
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${scriptPath} exited before listening (code ${code}): ${stderrChunks.join("")}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${scriptPath} did not print LISTENING within 5000ms: ${stderrChunks.join("")}`));
      }
    }, 5000);
  });
}

interface FakeWebhook {
  baseUrl: string;
  received: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

function startFakeWebhook(): Promise<FakeWebhook> {
  return new Promise((resolve) => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          received.push({});
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const spawned: SpawnedServer[] = [];
const webhooks: FakeWebhook[] = [];

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((s) => s.stop()));
  await Promise.all(webhooks.splice(0).map((w) => w.stop()));
});

describe("lpp-reference-provider conformance (real child process, ephemeral port)", () => {
  it("passes the full LPP conformance suite", async () => {
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-reference-provider", "server.mjs"), {});
    spawned.push(server);

    const report = await runLppConformance(server.baseUrl, {});

    const failing = report.suites.flatMap((s) => s.checks.filter((c) => c.severity === "fail"));
    expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.suites.map((s) => s.suite)).toEqual(["envelope", "metadata-provider"]);
  }, 15_000);
});

describe("lpp-discord-notifier conformance (real child process, ephemeral port)", () => {
  it("passes the full LPP conformance suite and forwards exactly the valid-signature batch to the configured webhook", async () => {
    const signingSecret = generateLppSigningSecret();
    const webhook = await startFakeWebhook();
    webhooks.push(webhook);

    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-discord-notifier", "server.mjs"), {
      LOOMBRE_LPP_SIGNING_SECRET: signingSecret,
    });
    spawned.push(server);

    const report = await runLppConformance(server.baseUrl, {
      signingSecret,
      secrets: { webhookUrl: webhook.baseUrl },
    });

    const failing = report.suites.flatMap((s) => s.checks.filter((c) => c.severity === "fail"));
    expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.suites.map((s) => s.suite)).toEqual(["envelope", "event-subscriber"]);

    // The reference notifier genuinely enforces both SHOULD-level checks
    // (tampered body, stale timestamp), so none of them should have
    // degraded to "warn" here — every check in the event-subscriber suite
    // passed outright.
    const eventSuite = report.suites.find((s) => s.suite === "event-subscriber");
    expect(eventSuite?.checks.every((c) => c.severity === "pass")).toBe(true);

    // Exactly one batch (the valid-signature one) should have been
    // forwarded — the tampered/stale batches must be rejected before the
    // notifier ever reads far enough to forward anything.
    expect(webhook.received).toHaveLength(1);
    expect(String(webhook.received[0]?.content ?? "")).toContain("item.added");
  }, 15_000);

  it("without a signing secret, degrades to a warn (no fail) rather than crashing", async () => {
    const signingSecret = generateLppSigningSecret();
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-discord-notifier", "server.mjs"), {
      LOOMBRE_LPP_SIGNING_SECRET: signingSecret,
    });
    spawned.push(server);

    const report = await runLppConformance(server.baseUrl, {});
    const eventSuite = report.suites.find((s) => s.suite === "event-subscriber");
    expect(eventSuite?.checks).toEqual([
      expect.objectContaining({ id: "event-subscriber.signature.skipped", severity: "warn" }),
    ]);
    expect(report.ok).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// L-7 fix wave: both reference plugins are the dev-kit TEMPLATE — an
// unauthenticated oversized POST must never OOM/crash them (before this
// fix, the request body was buffered with no cap at all, BEFORE signature
// verification for the notifier), and every non-2xx response (incl. 404)
// must be application/problem+json per spec §5.
// ---------------------------------------------------------------------------

function postOversizedBody(baseUrl: string, path: string, totalBytes: number): Promise<{ errored: boolean }> {
  return new Promise((resolve) => {
    const parsed = new URL(path, baseUrl);
    const req = httpRequest(
      parsed,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        // If the server somehow answered normally, that is itself a
        // finding (the cap did not engage) — drain and report "not errored".
        res.on("data", () => {});
        res.on("end", () => resolve({ errored: false }));
      },
    );
    req.on("error", () => resolve({ errored: true }));
    // Stream well past the 2 MiB cap in chunks, mirroring ssrf.spec.ts's
    // own streaming-oversize convention — never a single giant buffer.
    const chunk = Buffer.alloc(64 * 1024, 65);
    let written = 0;
    const writeMore = () => {
      if (req.destroyed || req.writableEnded) return;
      if (written >= totalBytes) {
        req.end();
        return;
      }
      written += chunk.length;
      req.write(chunk, writeMore);
    };
    writeMore();
  });
}

function getReturns404ProblemJson(baseUrl: string, path: string): Promise<{ status: number; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, baseUrl), { method: "GET" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("L-7 fix wave: both reference plugins cap the request body and use problem+json for 404", () => {
  it("lpp-reference-provider: an oversized POST is rejected (connection reset) BEFORE OOMing the process, which stays alive and responsive", async () => {
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-reference-provider", "server.mjs"), {});
    spawned.push(server);

    const { errored } = await postOversizedBody(server.baseUrl, "/lpp/provider/search", 8 * 1024 * 1024);
    expect(errored).toBe(true);

    // The process is still alive and answers a normal request afterward —
    // proof this was a clean cap, not a crash.
    const report = await runLppConformance(server.baseUrl, {});
    expect(report.ok).toBe(true);
  }, 15_000);

  it("lpp-reference-provider: 404 is application/problem+json", async () => {
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-reference-provider", "server.mjs"), {});
    spawned.push(server);
    const { status, contentType } = await getReturns404ProblemJson(server.baseUrl, "/no/such/route");
    expect(status).toBe(404);
    expect(contentType).toContain("application/problem+json");
  }, 15_000);

  it("lpp-discord-notifier: an oversized POST to /lpp/events is rejected BEFORE signature verification, process stays alive", async () => {
    const signingSecret = generateLppSigningSecret();
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-discord-notifier", "server.mjs"), {
      LOOMBRE_LPP_SIGNING_SECRET: signingSecret,
    });
    spawned.push(server);

    const { errored } = await postOversizedBody(server.baseUrl, "/lpp/events", 8 * 1024 * 1024);
    expect(errored).toBe(true);

    const report = await runLppConformance(server.baseUrl, { signingSecret });
    expect(report.ok).toBe(true);
  }, 15_000);

  it("lpp-discord-notifier: 404 is application/problem+json", async () => {
    const signingSecret = generateLppSigningSecret();
    const server = await spawnNodeServer(join(REPO_ROOT, "examples", "lpp-discord-notifier", "server.mjs"), {
      LOOMBRE_LPP_SIGNING_SECRET: signingSecret,
    });
    spawned.push(server);
    const { status, contentType } = await getReturns404ProblemJson(server.baseUrl, "/no/such/route");
    expect(status).toBe(404);
    expect(contentType).toContain("application/problem+json");
  }, 15_000);
});
