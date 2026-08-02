// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/mail/transport.spec.ts
//
// Optional mail transport run (E5): pure mapping tests for
// buildTransportOptions — no network, no nodemailer transport actually
// constructed here (that's consumer.e2e.spec.ts's job).

import { describe, expect, it } from "vitest";
import {
  buildTransportOptions,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_GREETING_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
} from "../../src/mail/transport.js";

describe("buildTransportOptions", () => {
  it("'implicit-tls' -> secure:true, no requireTLS/ignoreTLS", () => {
    const options = buildTransportOptions({ config: { host: "smtp.example.com", port: 465, security: "implicit-tls" }, credentials: null });
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBeUndefined();
    expect(options.ignoreTLS).toBeUndefined();
  });

  it("'starttls' -> secure:false, requireTLS:true (refuses to fall back to plaintext)", () => {
    const options = buildTransportOptions({ config: { host: "smtp.example.com", port: 587, security: "starttls" }, credentials: null });
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
    expect(options.ignoreTLS).toBeUndefined();
  });

  it("'none' -> secure:false, ignoreTLS:true (LAN-relay use only, per the registry entry's caution)", () => {
    const options = buildTransportOptions({ config: { host: "10.0.0.5", port: 25, security: "none" }, credentials: null });
    expect(options.secure).toBe(false);
    expect(options.ignoreTLS).toBe(true);
    expect(options.requireTLS).toBeUndefined();
  });

  it("host/port pass through verbatim", () => {
    const options = buildTransportOptions({ config: { host: "mail.example.org", port: 2525, security: "none" }, credentials: null });
    expect(options.host).toBe("mail.example.org");
    expect(options.port).toBe(2525);
  });

  it("credentials:null -> no auth field at all (unauthenticated relay, M8)", () => {
    const options = buildTransportOptions({ config: { host: "smtp.example.com", port: 587, security: "starttls" }, credentials: null });
    expect(options.auth).toBeUndefined();
  });

  it("credentials present -> auth:{user, pass}", () => {
    const options = buildTransportOptions({
      config: { host: "smtp.example.com", port: 587, security: "starttls" },
      credentials: { username: "smtp-user", password: "smtp-pass" },
    });
    expect(options.auth).toEqual({ user: "smtp-user", pass: "smtp-pass" });
  });

  it("default hard timeouts are applied when not overridden", () => {
    const options = buildTransportOptions({ config: { host: "smtp.example.com", port: 587, security: "starttls" }, credentials: null });
    expect(options.connectionTimeout).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(options.greetingTimeout).toBe(DEFAULT_GREETING_TIMEOUT_MS);
    expect(options.socketTimeout).toBe(DEFAULT_SOCKET_TIMEOUT_MS);
  });

  it("caller-supplied timeouts override the defaults", () => {
    const options = buildTransportOptions({
      config: { host: "smtp.example.com", port: 587, security: "starttls" },
      credentials: null,
      connectionTimeoutMs: 1000,
      greetingTimeoutMs: 2000,
      socketTimeoutMs: 3000,
    });
    expect(options.connectionTimeout).toBe(1000);
    expect(options.greetingTimeout).toBe(2000);
    expect(options.socketTimeout).toBe(3000);
  });
});
