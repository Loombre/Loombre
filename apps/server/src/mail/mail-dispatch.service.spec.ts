// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/mail-dispatch.service.spec.ts
//
// Pure unit tests (fake MailConfigService + fake JobQueueProvider doubles,
// no DB/queue). Proves E6's whole point: trySend() NEVER throws, and
// "unconfigured" / "enqueue failed" collapse to the identical
// {dispatched:false, jobId:null} shape a caller (an invite/reset flow)
// can treat uniformly.

import { describe, expect, it, vi } from "vitest";
import { MailDispatchService } from "./mail-dispatch.service.js";
import type { MailConfigService } from "./mail-config.service.js";
import type { JobQueueProvider } from "../common/job-queue.provider.js";

function fakeMailConfigService(configured: boolean): MailConfigService {
  return { isConfigured: () => configured } as unknown as MailConfigService;
}

function fakeJobQueueProvider(enqueue: (type: string, payload: unknown) => Promise<string>): JobQueueProvider {
  return { queue: { enqueue } } as unknown as JobQueueProvider;
}

describe("MailDispatchService.trySend (E6: mail can never block a flow)", () => {
  it("unconfigured -> {dispatched:false, jobId:null}, never attempts to enqueue", async () => {
    const enqueue = vi.fn();
    const service = new MailDispatchService(fakeMailConfigService(false), fakeJobQueueProvider(enqueue));

    const result = await service.trySend({ templateId: "invite", to: "a@example.com", params: {} });

    expect(result).toEqual({ dispatched: false, jobId: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("configured -> enqueues 'mail-send' with the frozen payload shape, returns {dispatched:true, jobId}", async () => {
    const enqueue = vi.fn(async () => "job-123");
    const service = new MailDispatchService(fakeMailConfigService(true), fakeJobQueueProvider(enqueue));

    const result = await service.trySend({ templateId: "password-reset", to: "b@example.com", params: { actionUrl: "https://x/y" } });

    expect(result).toEqual({ dispatched: true, jobId: "job-123" });
    expect(enqueue).toHaveBeenCalledWith("mail-send", {
      templateId: "password-reset",
      to: "b@example.com",
      params: { actionUrl: "https://x/y" },
    });
  });

  it("configured, but enqueue() throws -> degrades to {dispatched:false, jobId:null}, never propagates the error", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue is down");
    });
    const service = new MailDispatchService(fakeMailConfigService(true), fakeJobQueueProvider(enqueue));

    await expect(
      service.trySend({ templateId: "security-notice", to: "c@example.com", params: {} }),
    ).resolves.toEqual({ dispatched: false, jobId: null });
  });

  it("every templateId is accepted, including 'test'", async () => {
    const enqueue = vi.fn(async () => "job-test");
    const service = new MailDispatchService(fakeMailConfigService(true), fakeJobQueueProvider(enqueue));

    const result = await service.trySend({ templateId: "test", to: "d@example.com", params: {} });
    expect(result).toEqual({ dispatched: true, jobId: "job-test" });
  });

  it("a tokened link is SEALED into the payload — the enqueued job carries no plaintext token and no actionUrl (MRV-R1)", async () => {
    const enqueue = vi.fn(async () => "job-sealed");
    const service = new MailDispatchService(fakeMailConfigService(true), fakeJobQueueProvider(enqueue));
    const plaintextToken = "live-reset-token-cafebabe0042";

    const result = await service.trySend({
      templateId: "password-reset",
      to: "e@example.com",
      params: { displayName: "Sam" },
      link: { kind: "reset", token: plaintextToken },
    });
    expect(result).toEqual({ dispatched: true, jobId: "job-sealed" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [type, payload] = enqueue.mock.calls[0]! as unknown as [string, { templateId: string; to: string; params: Record<string, string>; link?: { kind: string; sealedToken: string } }];
    expect(type).toBe("mail-send");
    expect(payload.link?.kind).toBe("reset");
    expect(typeof payload.link?.sealedToken).toBe("string");
    // The whole persisted payload must be free of the live token and of
    // any pre-built URL — pg-boss writes this verbatim to pgboss.job.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(plaintextToken);
    expect(payload.params["actionUrl"]).toBeUndefined();
  });

  it("a sealing failure degrades to {dispatched:false} — the same never-throws posture as an enqueue failure", async () => {
    const enqueue = vi.fn(async () => "job-x");
    const service = new MailDispatchService(fakeMailConfigService(true), fakeJobQueueProvider(enqueue));
    (service as unknown as { resolveSealingSecret: () => Promise<string> }).resolveSealingSecret = async () => {
      throw new Error("keyring unavailable");
    };

    await expect(
      service.trySend({ templateId: "invite", to: "f@example.com", params: {}, link: { kind: "claim", token: "tok" } }),
    ).resolves.toEqual({ dispatched: false, jobId: null });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
