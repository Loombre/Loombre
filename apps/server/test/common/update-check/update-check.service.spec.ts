// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/common/update-check/update-check.service.spec.ts
//
// Wiring-level tests for UpdateCheckService: mode dispatch, the daily
// startup-delay grace period, and cache reuse. Decision RULES themselves
// (verified/signature-invalid/unreachable/disabled) are perform-check.
// spec.ts's job — this file only proves the NestJS-facing class calls
// into that logic correctly and on the right schedule.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): `mode` now
// comes from SettingsService, constructor-injected — every test below
// builds a fake (src/common/test-support/fake-settings-service.ts)
// resolving updateCheck.mode through the SAME pure
// resolveEffectiveSettings() production uses, from an explicit `env`
// object (never a real process.env mutation) so LOOMBRE_UPDATE_CHECK's
// env-pin precedence is still exercised for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSettingsService } from "../../../src/common/test-support/fake-settings-service.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("UpdateCheckService", () => {
  beforeEach(() => {
    resetEnv();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetEnv();
  });

  it("mode='off': getUpdateInfo() never calls fetch, even after onApplicationBootstrap()", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "off";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await service.getUpdateInfo();
    expect(result.verification).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it("mode='manual': no timer fires, but getUpdateInfo() performs a fresh check every call", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "manual";
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).not.toHaveBeenCalled(); // no background timer in manual mode

    const first = await service.getUpdateInfo();
    const second = await service.getUpdateInfo();

    expect(first.verification).toBe("unreachable");
    expect(second.verification).toBe("unreachable");
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 2 URLs x 2 calls to getUpdateInfo()

    service.onModuleDestroy();
  });

  it("mode='daily': does NOT fetch synchronously on module init (startup grace delay)", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "daily";
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();

    // Immediately after init: nothing fired yet.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Still within the startup grace window (< 10s).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Past the grace window: the first background check has fired.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchSpy).toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it("mode='daily': getUpdateInfo() called before the first background check awaits an on-demand check instead of returning a placeholder", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "daily";
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();

    const result = await service.getUpdateInfo(); // called well before the 10s grace period elapses
    expect(result.verification).toBe("unreachable"); // real answer, not a stub/placeholder
    expect(fetchSpy).toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it("mode='daily': getUpdateInfo() serves the cache once a check has landed, without calling fetch again", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "daily";
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();

    await service.getUpdateInfo();
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await service.getUpdateInfo();
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst); // cache hit, no new network call

    service.onModuleDestroy();
  });

  it("onModuleDestroy() clears both the startup and interval timers", async () => {
    process.env["LOOMBRE_UPDATE_CHECK"] = "daily";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const service = new UpdateCheckService(createFakeSettingsService({ env: process.env }).service);
    service.onApplicationBootstrap();
    service.onModuleDestroy();

    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000); // 2 days, well past any real schedule
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Addendum A, lane S3: updateCheck.mode flipped requiresRestart:false —
  // these two prove the hot path (onChange, no restart) both directions.
  // Deliberately NOT env-pinned (LOOMBRE_UPDATE_CHECK unset): A8 says env
  // wins unconditionally, so a DB-driven change (what these tests
  // simulate via fake.setDbValue — the same write settings.service.ts's
  // updateSetting() performs for real) would be structurally INERT while
  // a pin is active, same as any other UI-editable+env-pinnable setting.
  it("Addendum A hot-reload: 'off' -> 'daily' starts the background timer with no restart", async () => {
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const fake = createFakeSettingsService({ env: process.env, dbRows: [{ key: "updateCheck.mode", value: "off" }] });
    const service = new UpdateCheckService(fake.service);
    service.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).not.toHaveBeenCalled(); // still 'off'

    fake.setDbValue("updateCheck.mode", "daily");
    await vi.advanceTimersByTimeAsync(10_000); // past the startup grace window
    expect(fetchSpy).toHaveBeenCalled(); // the NEW 'daily' schedule started on its own, no restart

    service.onModuleDestroy();
  });

  it("Addendum A hot-reload: 'daily' -> 'off' tears down the background timer with no restart", async () => {
    process.env["LOOMBRE_UPDATE_MANIFEST_URL"] = "https://manifest.example.invalid";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated unreachable"));
    vi.stubGlobal("fetch", fetchSpy);

    const { UpdateCheckService } = await import("../../../src/common/update-check/update-check.service.js");
    const fake = createFakeSettingsService({ env: process.env, dbRows: [{ key: "updateCheck.mode", value: "daily" }] });
    const service = new UpdateCheckService(fake.service);
    service.onApplicationBootstrap();

    fake.setDbValue("updateCheck.mode", "off");
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000); // 2 days — the 'daily' schedule would have fired many times by now if still active
    expect(fetchSpy).not.toHaveBeenCalled();

    const result = await service.getUpdateInfo();
    expect(result.verification).toBe("disabled"); // getUpdateInfo() itself dispatches on the NEW mode too

    service.onModuleDestroy();
  });
});
