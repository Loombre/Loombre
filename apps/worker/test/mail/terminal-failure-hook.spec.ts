// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/mail/terminal-failure-hook.spec.ts
//
// Optional mail transport run (E6/M6) — live-DB test for the 'mail-send'
// job's onTerminalFailure hook, independent of pg-boss/the job queue
// entirely (same "test the seam, not the whole worker process" split
// apps/worker/test/probe/terminal-failure-hook.spec.ts uses).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailTerminalFailureHook } from "../../src/mail/terminal-failure-hook.js";
import { makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

describe("createMailTerminalFailureHook (E6/M6)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
  });

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  it("writes an admin-only mail.failed event carrying the REAL smtp error verbatim (E6's deliberate deviation from probe.failed's closed-code posture, M6)", async () => {
    const hook = createMailTerminalFailureHook(dbHandle);
    const jobId = "018f0007-0000-7000-8000-000000000101";
    const error = new Error("535 5.7.8 Authentication failed: invalid credentials");

    await hook({ templateId: "invite", to: "someone@example.com", params: {} }, error, jobId);

    const result = await raw.query<{ payload: { templateId: string; to: string; smtpError: string; jobId: string } }>(
      "SELECT payload FROM events WHERE type = 'mail.failed' AND payload->>'jobId' = $1",
      [jobId],
    );
    expect(result.rows).toHaveLength(1);
    const payload = result.rows[0]!.payload;
    expect(payload.templateId).toBe("invite");
    expect(payload.to).toBe("someone@example.com");
    expect(payload.smtpError).toBe("535 5.7.8 Authentication failed: invalid credentials");
    expect(payload.jobId).toBe(jobId);
  });

  it("maps a non-Error thrown value to its String() form (defensive default)", async () => {
    const hook = createMailTerminalFailureHook(dbHandle);
    const jobId = "018f0007-0000-7000-8000-000000000102";

    await hook({ templateId: "test", to: "x@example.com", params: {} }, "a raw string failure", jobId);

    const result = await raw.query<{ payload: { smtpError: string } }>(
      "SELECT payload FROM events WHERE type = 'mail.failed' AND payload->>'jobId' = $1",
      [jobId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.payload.smtpError).toBe("a raw string failure");
  });
});
