// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/http01-crash-boundary.integration.spec.ts
//
// V1-001 / FW1-A regression (was AUD-A1h-001): an unauthenticated
// `GET /.well-known/acme-challenge/%` used to kill the ENTIRE server
// process. `handle()` had no try/catch anywhere, decodeURIComponent threw a
// URIError synchronously, and because the listener is a raw
// `http.createServer((req, res) => this.handle(req, res))` — not Express —
// that throw escaped as an `uncaughtException` on the whole process. See
// http01-server.ts's header and reports/audit-fafa47f/validated/V1.md#V1-001
// for the full chain.
//
// THE REAL PROOF (not an in-process handle() call): a direct
// `new Http01ChallengeServer().handle(req, res)` unit test would pass even
// with the crash boundary removed, because the throw only becomes fatal by
// propagating through the server's real event emitter — same reasoning
// ../crash/fixtures/throw-entrypoint.ts's suite documents for a deliberate
// crash. So this spawns a REAL child process (fixtures/http01-crash-entrypoint.ts)
// running a REAL listening Http01ChallengeServer with the REAL crash
// handlers installed, and drives it with REAL HTTP requests over loopback.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "http01-crash-entrypoint.ts");

function get(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: rawPath, timeout: 3_000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out waiting for a response")));
  });
}

/** Resolves with the port from the fixture's "PORT=<n>" readiness line on
 *  stdout, or rejects if the child exits/errors before printing it. */
function waitForPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const match = /^PORT=(\d+)$/m.exec(buffered);
      if (match?.[1] !== undefined) {
        child.stdout.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`fixture exited before reporting readiness (code ${String(code)})`)));
    child.once("error", reject);
  });
}

describe("Http01ChallengeServer crash boundary (real child process, real HTTP over loopback)", () => {
  let dataDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "loombre-http01-crash-"));
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "a malformed percent-encoded token 404s instead of killing the server process",
    async () => {
      child = spawn(process.execPath, ["--import", "tsx", FIXTURE, dataDir], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const port = await waitForPort(child);

      // This exact request used to take the whole process down.
      const malformed = await get(port, "/.well-known/acme-challenge/%");
      expect(malformed.status).toBe(404);

      // The process must still be alive AND still serving — a follow-up,
      // known-good request must succeed against the SAME server instance.
      expect(child.exitCode).toBeNull();
      const followUp = await get(port, "/.well-known/acme-challenge/known-token");
      expect(followUp.status).toBe(200);
      expect(followUp.body).toBe("known-key-authorization");
    },
    15_000,
  );
});
