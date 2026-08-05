// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/settings-boot-bridge.spec.ts
//
// Pure unit tests (no DB, no NestJS) — a fake EffectiveSettingsReader and a
// plain env object are enough to prove the hydration rules (RG12).

import { describe, expect, it } from "vitest";
import { hydrateTlsEnvFromSettings, type EffectiveSettingLike, type EffectiveSettingsReader } from "./settings-boot-bridge.js";

function fakeSettings(values: Record<string, EffectiveSettingLike>): EffectiveSettingsReader {
  return { getEffective: (key) => values[key] };
}

describe("hydrateTlsEnvFromSettings", () => {
  it("hydrates all five vars from database-sourced effective values into an empty env", () => {
    const settings = fakeSettings({
      "tls.mode": { value: "acme", source: "database" },
      "tls.acmeDomains": { value: ["media.example.com", "alt.example.com"], source: "database" },
      "tls.acmeChallengeType": { value: "http-01", source: "database" },
      "tls.acmeTosAgreed": { value: true, source: "database" },
      "network.trustProxy": { value: "1", source: "database" },
    });
    const env: NodeJS.ProcessEnv = {};
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_TLS_MODE"]).toBe("acme");
    expect(env["LOOMBRE_ACME_DOMAINS"]).toBe("media.example.com,alt.example.com");
    expect(env["LOOMBRE_ACME_CHALLENGE_TYPE"]).toBe("http-01");
    expect(env["LOOMBRE_ACME_TOS_AGREED"]).toBe("1");
    expect(env["LOOMBRE_TRUST_PROXY"]).toBe("1");
  });

  it("serializes tls.acmeTosAgreed=false as '0'", () => {
    const settings = fakeSettings({ "tls.acmeTosAgreed": { value: false, source: "database" } });
    const env: NodeJS.ProcessEnv = {};
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_ACME_TOS_AGREED"]).toBe("0");
  });

  it("NEVER overrides an already-set env var, regardless of what the database says (env always wins, A8)", () => {
    const settings = fakeSettings({ "tls.mode": { value: "acme", source: "database" } });
    const env: NodeJS.ProcessEnv = { LOOMBRE_TLS_MODE: "off" };
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_TLS_MODE"]).toBe("off");
  });

  it("does nothing when the effective source is 'environment' (the raw env var is already what settings resolved to)", () => {
    const settings = fakeSettings({ "tls.mode": { value: "manual", source: "environment" } });
    const env: NodeJS.ProcessEnv = {};
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_TLS_MODE"]).toBeUndefined();
  });

  it("does nothing when the effective source is 'default' (a fresh install with no DB rows is byte-identical to before this module existed)", () => {
    const settings = fakeSettings({ "tls.mode": { value: "off", source: "default" } });
    const env: NodeJS.ProcessEnv = {};
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_TLS_MODE"]).toBeUndefined();
  });

  it("does nothing for a key with no effective value at all (getEffective returns undefined)", () => {
    const settings = fakeSettings({});
    const env: NodeJS.ProcessEnv = {};
    expect(() => hydrateTlsEnvFromSettings(settings, env)).not.toThrow();
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("treats a whitespace-only existing env var as unset (still hydrates)", () => {
    const settings = fakeSettings({ "network.trustProxy": { value: "loopback", source: "database" } });
    const env: NodeJS.ProcessEnv = { LOOMBRE_TRUST_PROXY: "   " };
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_TRUST_PROXY"]).toBe("loopback");
  });

  it("hydrates a single-element tls.acmeDomains without a trailing comma", () => {
    const settings = fakeSettings({ "tls.acmeDomains": { value: ["media.example.com"], source: "database" } });
    const env: NodeJS.ProcessEnv = {};
    hydrateTlsEnvFromSettings(settings, env);
    expect(env["LOOMBRE_ACME_DOMAINS"]).toBe("media.example.com");
  });
});
