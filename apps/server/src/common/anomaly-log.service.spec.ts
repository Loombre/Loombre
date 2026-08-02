// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/anomaly-log.service.spec.ts
//
// fail2ban-compatible single-line auth anomaly log (STATE.md P2.1/P2.12,
// docs/PLAN.md §10 "login anomaly log + optional fail2ban-compatible log
// format"). Local file only — no network call is possible from this
// service (CLAUDE.md invariant 7: no telemetry/phone-home of any kind).
// Constructed directly (`new AnomalyLogService(fakeSettingsService)`), same
// bypass-Nest's-container spirit as hash.service.spec.ts — the fake
// (common/test-support/fake-settings-service.ts, Addendum A lane S3)
// resolves security.loginAnomalyLogEnabled through the SAME pure
// resolveEffectiveSettings() production uses, just without a database.
//
// RELOCATED from session/ to common/ (G3, STATE.md "Current-password
// re-auth on self-changes") alongside anomaly-log.service.ts itself — see
// that file's header for the D2 cross-module rationale.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnomalyLogService } from "./anomaly-log.service.js";
import { createFakeSettingsService } from "./test-support/fake-settings-service.js";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "loombre-auth-log-"));
});

afterEach(() => {
  delete process.env["LOOMBRE_AUTH_LOG_FILE"];
  rmSync(scratchDir, { recursive: true, force: true });
});

function newService(): AnomalyLogService {
  return new AnomalyLogService(createFakeSettingsService().service);
}

describe("AnomalyLogService", () => {
  it("creates the log directory (and any missing parents) if absent", () => {
    const nestedPath = join(scratchDir, "nested", "deeper", "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = nestedPath;
    newService().log("FAILED_LOGIN", { ip: "1.2.3.4", user: "alice" }, 0);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("defaults to <cwd>/logs/auth-anomaly.log when LOOMBRE_AUTH_LOG_FILE is unset", () => {
    delete process.env["LOOMBRE_AUTH_LOG_FILE"];
    const service = newService();
    expect(service.filePath).toBe(join(process.cwd(), "logs", "auth-anomaly.log"));
  });

  it("writes a stable, greppable, one-event-per-line format", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const service = newService();

    const fixedNowMs = Date.UTC(2026, 6, 23, 12, 0, 0, 0); // 2026-07-23T12:00:00.000Z
    service.log("FAILED_LOGIN", { ip: "1.2.3.4", user: "alice" }, fixedNowMs);

    const contents = readFileSync(logPath, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("2026-07-23T12:00:00.000Z loombre-auth FAILED_LOGIN ip=1.2.3.4 user=alice");
  });

  it("appends one line per event, oldest first", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const service = newService();

    service.log("FAILED_LOGIN", { ip: "1.1.1.1" }, 1000);
    service.log("REFRESH_REUSE", { ip: "2.2.2.2", user: "bob", device: "dev-1" }, 2000);
    service.log("PIN_FAILURE", { user: "carol" }, 3000);
    service.log("CURRENT_PASSWORD_FAILURE", { user: "dave" }, 3500);
    service.log("RATE_LIMITED", { ip: "3.3.3.3", op: "login" }, 4000);

    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("FAILED_LOGIN");
    expect(lines[1]).toContain("REFRESH_REUSE");
    expect(lines[2]).toContain("PIN_FAILURE");
    expect(lines[3]).toBe("1970-01-01T00:00:03.500Z loombre-auth CURRENT_PASSWORD_FAILURE user=dave");
    expect(lines[4]).toContain("RATE_LIMITED");
  });

  it("sanitizes field values so log-line injection (embedded newlines) is impossible", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const service = newService();

    service.log("FAILED_LOGIN", { user: "alice\nFORGED_LINE ip=9.9.9.9" }, 0);
    service.log("FAILED_LOGIN", { user: "bob" }, 0);

    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    // Exactly two real events were logged; an embedded newline in a field
    // must not have forged a third line.
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("\n");
  });

  it("never lets a secret-shaped field name (pin/password) reach the line", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const service = newService();

    // Fields is typed to only the safe identifying keys — this call site
    // demonstrates the shape callers are meant to use (ip/user/device/op),
    // never pin/password.
    service.log("PIN_FAILURE", { ip: "1.2.3.4", user: "casual" }, 0);

    const line = readFileSync(logPath, "utf8").trim();
    const fieldsPortion = line.replace(/^\S+ loombre-auth PIN_FAILURE\s*/, "");
    expect(line).not.toMatch(/pin=/i);
    expect(line).not.toMatch(/password=/i);
    expect(fieldsPortion).not.toMatch(/\b\d{4}\b/); // no bare 4-digit PIN-shaped token
  });

  it("Addendum A: security.loginAnomalyLogEnabled=false silently skips the write (no file, no throw)", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const service = new AnomalyLogService(createFakeSettingsService({ dbRows: [{ key: "security.loginAnomalyLogEnabled", value: false }] }).service);

    service.log("FAILED_LOGIN", { ip: "1.2.3.4" }, 0);

    expect(existsSync(logPath)).toBe(false);
  });

  it("Addendum A: toggling the setting hot (onChange, no restart) is honored on the very next log() call", () => {
    const logPath = join(scratchDir, "auth-anomaly.log");
    process.env["LOOMBRE_AUTH_LOG_FILE"] = logPath;
    const fake = createFakeSettingsService();
    const service = new AnomalyLogService(fake.service);

    service.log("FAILED_LOGIN", { ip: "1.1.1.1" }, 1000);
    fake.setDbValue("security.loginAnomalyLogEnabled", false);
    service.log("FAILED_LOGIN", { ip: "2.2.2.2" }, 2000);

    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // only the first call landed
  });
});
