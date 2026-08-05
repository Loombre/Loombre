// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { classifyCloudflaredLogLine } from "./cloudflared-log-signals.js";

describe("classifyCloudflaredLogLine — readiness", () => {
  it("recognizes the real 'Registered tunnel connection' line", () => {
    const line =
      "2026-08-04T12:00:00Z INF Registered tunnel connection connIndex=0 connection=2dafc029-273d-4b94-905b-da28be28c49d event=0 ip=198.41.200.10 location=DFW protocol=quic";
    expect(classifyCloudflaredLogLine(line)).toBe("ready");
  });

  it("is case-insensitive", () => {
    expect(classifyCloudflaredLogLine("REGISTERED TUNNEL CONNECTION connIndex=1")).toBe("ready");
  });

  it("does NOT treat 'Unregistered tunnel connection' as readiness (substring trap)", () => {
    expect(classifyCloudflaredLogLine("Unregistered tunnel connection connIndex=0 event=1")).not.toBe("ready");
  });
});

describe("classifyCloudflaredLogLine — connection lost", () => {
  it("recognizes 'Unregistered tunnel connection'", () => {
    expect(classifyCloudflaredLogLine("Unregistered tunnel connection connIndex=0 event=1")).toBe("connection-lost");
  });

  it("recognizes 'Retrying connection'", () => {
    expect(classifyCloudflaredLogLine("Retrying connection in up to 3s")).toBe("connection-lost");
  });

  it("recognizes 'Connection terminated'", () => {
    expect(classifyCloudflaredLogLine('Connection terminated error="connection with edge closed"')).toBe("connection-lost");
  });
});

describe("classifyCloudflaredLogLine — noise", () => {
  it("ignores the benign quic-go buffer-size warning", () => {
    expect(classifyCloudflaredLogLine("failed to sufficiently increase receive buffer size")).toBeNull();
  });

  it("ignores unrelated lines", () => {
    expect(classifyCloudflaredLogLine("Starting tunnel tunnelID=abc123")).toBeNull();
    expect(classifyCloudflaredLogLine("")).toBeNull();
  });
});
