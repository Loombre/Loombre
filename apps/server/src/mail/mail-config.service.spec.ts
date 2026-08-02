// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/mail-config.service.spec.ts
//
// Pure unit tests — MailConfigService only reads SettingsService.getEffective,
// so a fake SettingsService double (never a real DB) is enough to prove
// M8's isConfigured() definition and the trailing-slash normalization
// publicUrl() performs at the read site (see that method's own doc
// comment for why normalization lives here rather than in the registry
// schema).

import { describe, expect, it } from "vitest";
import { MailConfigService } from "./mail-config.service.js";
import type { SettingsService } from "../settings/settings.service.js";

function fakeSettingsService(values: Record<string, unknown>): SettingsService {
  return {
    getEffective: (key: string) => (key in values ? { key, value: values[key], source: "database", requiresRestart: false, scope: "ui", envVar: undefined, locked: false, lockedBy: undefined } : undefined),
  } as unknown as SettingsService;
}

describe("MailConfigService.isConfigured (M8)", () => {
  it("false when nothing is set", () => {
    const service = new MailConfigService(fakeSettingsService({}));
    expect(service.isConfigured()).toBe(false);
  });

  it("false when smtpHost is set but fromAddress/publicUrl are not", () => {
    const service = new MailConfigService(fakeSettingsService({ "mail.smtpHost": "smtp.example.com" }));
    expect(service.isConfigured()).toBe(false);
  });

  it("false when smtpHost + fromAddress are set but publicUrl is not (M8: publicUrl is required too)", () => {
    const service = new MailConfigService(
      fakeSettingsService({ "mail.smtpHost": "smtp.example.com", "mail.fromAddress": "server@example.com" }),
    );
    expect(service.isConfigured()).toBe(false);
  });

  it("true when smtpHost + fromAddress + publicUrl are all set — credentials are NOT part of the definition (M8: unauthenticated relays are legal)", () => {
    const service = new MailConfigService(
      fakeSettingsService({
        "mail.smtpHost": "smtp.example.com",
        "mail.fromAddress": "server@example.com",
        "network.publicUrl": "https://loombre.example.com",
      }),
    );
    expect(service.isConfigured()).toBe(true);
  });

  it("whitespace-only values do not count as set", () => {
    const service = new MailConfigService(
      fakeSettingsService({ "mail.smtpHost": "   ", "mail.fromAddress": "server@example.com", "network.publicUrl": "https://x.example.com" }),
    );
    expect(service.isConfigured()).toBe(false);
  });
});

describe("MailConfigService.publicUrl", () => {
  it("null when unset", () => {
    const service = new MailConfigService(fakeSettingsService({}));
    expect(service.publicUrl()).toBeNull();
  });

  it("null when the effective value is an empty string", () => {
    const service = new MailConfigService(fakeSettingsService({ "network.publicUrl": "" }));
    expect(service.publicUrl()).toBeNull();
  });

  it("strips a trailing slash at the read site (registry schema itself cannot — see PUBLIC_URL_SCHEMA's own header)", () => {
    const service = new MailConfigService(fakeSettingsService({ "network.publicUrl": "https://loombre.example.com/" }));
    expect(service.publicUrl()).toBe("https://loombre.example.com");
  });

  it("strips MULTIPLE trailing slashes", () => {
    const service = new MailConfigService(fakeSettingsService({ "network.publicUrl": "https://loombre.example.com///" }));
    expect(service.publicUrl()).toBe("https://loombre.example.com");
  });

  it("a value with no trailing slash passes through unchanged", () => {
    const service = new MailConfigService(fakeSettingsService({ "network.publicUrl": "https://loombre.example.com" }));
    expect(service.publicUrl()).toBe("https://loombre.example.com");
  });
});
