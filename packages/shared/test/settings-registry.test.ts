// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/settings-registry.test.ts
//
// Addendum A / lane S1: registry-level invariants that must hold no matter
// how many entries get added later — "every default is valid" and "every
// env-only entry declares its envVar" are the two the mission text names
// explicitly as minimum coverage.

import { describe, expect, it } from "vitest";
import {
  LADDER_RUNG_CODECS,
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_BY_KEY,
  getSettingsRegistryEntry,
  registryDefaultForTier,
  settingsValueJsonSchema,
} from "../src/settings-registry.js";

describe("SETTINGS_REGISTRY", () => {
  it("has at least one entry of each scope", () => {
    const scopes = new Set(SETTINGS_REGISTRY.map((e) => e.scope));
    expect(scopes.has("ui")).toBe(true);
    expect(scopes.has("env-only")).toBe(true);
  });

  it("every key is unique", () => {
    const keys = SETTINGS_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry's simple default passes its own schema", () => {
    for (const entry of SETTINGS_REGISTRY) {
      const result = entry.schema.safeParse(entry.default);
      expect(result.success, `${entry.key}: default ${JSON.stringify(entry.default)} failed schema: ${JSON.stringify(!result.success ? result.error.issues : undefined)}`).toBe(true);
    }
  });

  it("every tierDefaults value (0/1/2) passes its own schema", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (!entry.tierDefaults) continue;
      for (const tier of [0, 1, 2] as const) {
        const value = registryDefaultForTier(entry, tier);
        const result = entry.schema.safeParse(value);
        expect(result.success, `${entry.key} tier ${tier}: ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  it("every env-only entry declares envVar", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.scope === "env-only") {
        expect(entry.envVar, `${entry.key} is env-only but has no envVar`).toBeDefined();
      }
    }
  });

  it("every entry with a parseEnv also declares envVar", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.parseEnv) {
        expect(entry.envVar, `${entry.key} has parseEnv but no envVar`).toBeDefined();
      }
    }
  });

  it("restricted.majorityAgeYears enforces the >=18 floor in its schema (D13/A3)", () => {
    const entry = getSettingsRegistryEntry("restricted.majorityAgeYears");
    expect(entry).toBeDefined();
    expect(entry!.schema.safeParse(17).success).toBe(false);
    expect(entry!.schema.safeParse(18).success).toBe(true);
  });

  it("every rateLimit.* entry has a hard floor of >=1 in its own unit (AD1 lockout-impossibility)", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.category !== "rateLimit") continue;
      expect(entry.schema.safeParse(0).success, `${entry.key} must reject 0`).toBe(false);
      expect(entry.schema.safeParse(-1).success, `${entry.key} must reject negative`).toBe(false);
      expect(entry.schema.safeParse(1).success, `${entry.key} must accept 1`).toBe(true);
    }
  });

  it("SETTINGS_REGISTRY_BY_KEY is a 1:1 index of SETTINGS_REGISTRY", () => {
    expect(SETTINGS_REGISTRY_BY_KEY.size).toBe(SETTINGS_REGISTRY.length);
    for (const entry of SETTINGS_REGISTRY) {
      expect(SETTINGS_REGISTRY_BY_KEY.get(entry.key)).toBe(entry);
    }
  });

  it("settingsValueJsonSchema produces a JSON-schema-shaped projection for every entry", () => {
    for (const entry of SETTINGS_REGISTRY) {
      const schema = settingsValueJsonSchema(entry);
      expect(typeof schema).toBe("object");
      expect(schema).not.toBeNull();
      expect(schema["$schema"]).toBeDefined();
    }
  });

  it("transcode.maxSimultaneousTranscodes tierDefaults matches resolve-policy.ts's historical tier table (1/2/4)", () => {
    const entry = getSettingsRegistryEntry("transcode.maxSimultaneousTranscodes");
    expect(entry?.tierDefaults).toEqual({ 0: 1, 1: 2, 2: 4 });
  });

  // ==========================================================================
  // Security review F1: database.url's `secret` flag — the value it protects
  // embeds a Postgres password, unlike every other env-only entry.
  // ==========================================================================

  describe("F1: `secret` flag audit", () => {
    it("database.url is flagged secret:true", () => {
      const entry = getSettingsRegistryEntry("database.url");
      expect(entry?.secret).toBe(true);
    });

    it("no other entry is flagged secret:true (none of the audited env-only paths/flags are credentials)", () => {
      const secretEntries = SETTINGS_REGISTRY.filter((e) => e.secret === true);
      expect(secretEntries.map((e) => e.key)).toEqual(["database.url"]);
    });
  });

  // ==========================================================================
  // Security review F9: ceilings on single-key schemas that were previously
  // floor-only, so a schema-legal edit or env pin couldn't take the product
  // down or turn a knob into an effectively-unbounded value.
  // ==========================================================================

  describe("F9: registry-level ceilings", () => {
    it("transcode.maxSimultaneousTranscodes rejects above 64, accepts 64", () => {
      const entry = getSettingsRegistryEntry("transcode.maxSimultaneousTranscodes")!;
      expect(entry.schema.safeParse(65).success).toBe(false);
      expect(entry.schema.safeParse(64).success).toBe(true);
    });

    it("scanner.concurrency rejects above 64, accepts 64", () => {
      const entry = getSettingsRegistryEntry("scanner.concurrency")!;
      expect(entry.schema.safeParse(65).success).toBe(false);
      expect(entry.schema.safeParse(64).success).toBe(true);
    });

    it("sessions.heartbeatSuspendCutoffMs rejects below 30s and above 1h, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("sessions.heartbeatSuspendCutoffMs")!;
      expect(entry.schema.safeParse(29_999).success).toBe(false);
      expect(entry.schema.safeParse(30_000).success).toBe(true);
      expect(entry.schema.safeParse(3_600_001).success).toBe(false);
      expect(entry.schema.safeParse(3_600_000).success).toBe(true);
    });

    it("sessions.staleCutoffMs rejects below 1min and above 24h, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("sessions.staleCutoffMs")!;
      expect(entry.schema.safeParse(59_999).success).toBe(false);
      expect(entry.schema.safeParse(60_000).success).toBe(true);
      expect(entry.schema.safeParse(86_400_001).success).toBe(false);
      expect(entry.schema.safeParse(86_400_000).success).toBe(true);
    });

    it("transcode.ladderRungs rejects an out-of-range per-rung bitrate (below 100kbps or above 100Mbps)", () => {
      const entry = getSettingsRegistryEntry("transcode.ladderRungs")!;
      const baseRung = { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" as const };
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 99_999 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000 }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000_001 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, videoBitrateBps: 100_000_000 }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...baseRung, audioBitrateBps: 99_999 }]).success).toBe(false);
      expect(entry.schema.safeParse([{ ...baseRung, audioBitrateBps: 100_000_001 }]).success).toBe(false);
    });
  });

  // ==========================================================================
  // Wave C1 (LD-7): AV1 became a ladder ENCODE target. Two registry
  // consequences — the rung schema must ACCEPT `av1` (an admin who cannot
  // save a codec the engine can emit has a broken settings UI, not a safe
  // one), and the operator opt-in itself becomes a setting.
  // ==========================================================================

  describe("LD-7: AV1 ladder targeting", () => {
    it("LADDER_RUNG_CODECS is exactly the engine's LadderCodec set {h264, hevc, av1}", () => {
      expect([...LADDER_RUNG_CODECS].sort()).toEqual(["av1", "h264", "hevc"]);
    });

    it("transcode.ladderRungs ACCEPTS an av1 rung and still rejects a non-LadderCodec value", () => {
      const entry = getSettingsRegistryEntry("transcode.ladderRungs")!;
      const rung = { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000 };
      expect(entry.schema.safeParse([{ ...rung, codec: "av1" }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...rung, codec: "h264" }]).success).toBe(true);
      expect(entry.schema.safeParse([{ ...rung, codec: "hevc" }]).success).toBe(true);
      // vp9 is a SOURCE codec, never an encode target — the narrower set is
      // the whole point of LadderCodec existing separately from VideoCodec.
      expect(entry.schema.safeParse([{ ...rung, codec: "vp9" }]).success).toBe(false);
    });

    it("transcode.ladderRungs' copy names av1 among the legal codecs (the admin-facing list must not go stale)", () => {
      const entry = getSettingsRegistryEntry("transcode.ladderRungs")!;
      expect(entry.technicalDetails).toContain("av1");
    });

    it("transcode.av1EncodePreferred exists: boolean, DEFAULT FALSE (opt-in), scope 'ui', and NO envVar", () => {
      const entry = getSettingsRegistryEntry("transcode.av1EncodePreferred")!;
      expect(entry, "transcode.av1EncodePreferred is missing from the registry").toBeDefined();
      expect(entry.default).toBe(false);
      expect(entry.schema.safeParse(true).success).toBe(true);
      expect(entry.schema.safeParse("yes").success).toBe(false);
      expect(entry.category).toBe("transcode");
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(false);
      // Owner-decision D5: flippable per-instance from the settings UI at
      // any time, and deliberately NOT env-pinnable — unlike
      // transcode.maxSimultaneousTranscodes, nothing about this preference
      // needs to be fixed at deploy time.
      expect(entry.envVar).toBeUndefined();
    });

    it("its copy explains the TIER reality without leaking an internal decision ID", () => {
      const entry = getSettingsRegistryEntry("transcode.av1EncodePreferred")!;
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.technicalDetails).toBeDefined();
      expect(entry.description).not.toMatch(/\b(LD-\d+|D\d{1,2}|P\d\.\d+)\b/);
      expect(entry.technicalDetails).not.toMatch(/\b(LD-\d+|D\d{1,2}|P\d\.\d+)\b/);
    });
  });

  // ==========================================================================
  // Security review F4: restricted.defaultUnlockDurationMs was floor-only
  // (.min(1)) — a schema-legal MAX_SAFE_INTEGER value turned gate 5 into a
  // permanent unlock. The exact PoC from the review is asserted directly.
  // ==========================================================================

  describe("F4: restricted.defaultUnlockDurationMs bounds", () => {
    it("rejects the review's MAX_SAFE_INTEGER permanent-unlock PoC", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.schema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    });

    it("rejects below 1 minute and above 24 hours, accepts the boundaries", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.schema.safeParse(59_999).success).toBe(false);
      expect(entry.schema.safeParse(60_000).success).toBe(true);
      expect(entry.schema.safeParse(24 * 60 * 60 * 1000 + 1).success).toBe(false);
      expect(entry.schema.safeParse(24 * 60 * 60 * 1000).success).toBe(true);
    });

    it("carries a caution explaining the shared-device tradeoff", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.caution).toBeDefined();
      expect(entry.caution!.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Optional mail transport run (E5/M10): cross-field/validation cases for
  // the new mail.* + network.publicUrl entries.
  // ==========================================================================

  describe("optional mail transport run: network.publicUrl", () => {
    const entry = () => getSettingsRegistryEntry("network.publicUrl")!;

    it("accepts the empty string (unset)", () => {
      expect(entry().schema.safeParse("").success).toBe(true);
    });

    it("accepts absolute http:// and https:// URLs", () => {
      expect(entry().schema.safeParse("https://loombre.example.com").success).toBe(true);
      expect(entry().schema.safeParse("http://10.0.0.5:3001").success).toBe(true);
    });

    it("accepts a trailing slash at the SCHEMA level (normalization happens at the MailConfigService.publicUrl() read site, not here — z.toJSONSchema can't represent a .transform(), see PUBLIC_URL_SCHEMA's own header)", () => {
      expect(entry().schema.safeParse("https://loombre.example.com/").success).toBe(true);
    });

    it("rejects a bare hostname with no scheme", () => {
      expect(entry().schema.safeParse("loombre.example.com").success).toBe(false);
    });

    it("rejects a non-http(s) scheme", () => {
      expect(entry().schema.safeParse("ftp://loombre.example.com").success).toBe(false);
      expect(entry().schema.safeParse("javascript:alert(1)").success).toBe(false);
    });

    it("rejects whitespace-only garbage", () => {
      expect(entry().schema.safeParse("   ").success).toBe(false);
    });

    it("category is 'network' and it carries the LOOMBRE_PUBLIC_URL env pin", () => {
      expect(entry().category).toBe("network");
      expect(entry().envVar).toBe("LOOMBRE_PUBLIC_URL");
    });
  });

  describe("optional mail transport run: mail.smtpPort bounds", () => {
    const entry = () => getSettingsRegistryEntry("mail.smtpPort")!;

    it("rejects 0 and negative values", () => {
      expect(entry().schema.safeParse(0).success).toBe(false);
      expect(entry().schema.safeParse(-1).success).toBe(false);
    });

    it("accepts the boundaries 1 and 65535", () => {
      expect(entry().schema.safeParse(1).success).toBe(true);
      expect(entry().schema.safeParse(65535).success).toBe(true);
    });

    it("rejects above 65535", () => {
      expect(entry().schema.safeParse(65536).success).toBe(false);
    });

    it("rejects a non-integer", () => {
      expect(entry().schema.safeParse(587.5).success).toBe(false);
    });

    it("default is 587 (the common encrypted-submission port)", () => {
      expect(entry().default).toBe(587);
    });
  });

  describe("optional mail transport run: mail.fromAddress format", () => {
    const entry = () => getSettingsRegistryEntry("mail.fromAddress")!;

    it("accepts the empty string (mail turned off)", () => {
      expect(entry().schema.safeParse("").success).toBe(true);
    });

    it("accepts a syntactically valid email address", () => {
      expect(entry().schema.safeParse("server@loombre.example.com").success).toBe(true);
    });

    it("rejects a string with no @", () => {
      expect(entry().schema.safeParse("not-an-email").success).toBe(false);
    });

    it("rejects a string with no domain", () => {
      expect(entry().schema.safeParse("server@").success).toBe(false);
    });

    it("rejects whitespace-only garbage", () => {
      expect(entry().schema.safeParse("   ").success).toBe(false);
    });
  });

  describe("optional mail transport run: mail.smtpSecurity enum + caution", () => {
    const entry = () => getSettingsRegistryEntry("mail.smtpSecurity")!;

    it("accepts exactly the three closed values", () => {
      expect(entry().schema.safeParse("starttls").success).toBe(true);
      expect(entry().schema.safeParse("implicit-tls").success).toBe(true);
      expect(entry().schema.safeParse("none").success).toBe(true);
    });

    it("rejects anything outside the closed set", () => {
      expect(entry().schema.safeParse("tls").success).toBe(false);
      expect(entry().schema.safeParse("NONE").success).toBe(false);
      expect(entry().schema.safeParse("").success).toBe(false);
    });

    it("default is 'starttls'", () => {
      expect(entry().default).toBe("starttls");
    });

    it("carries a caution warning that 'none' sends credentials and mail in cleartext — LAN-relay use only", () => {
      expect(entry().caution).toBeDefined();
      expect(entry().caution).toMatch(/none/i);
      expect(entry().caution).toMatch(/plain|cleartext|readable text/i);
    });
  });

  describe("optional mail transport run: mail.smtpHost / mail.fromName", () => {
    it("mail.smtpHost accepts any string including empty (mail turned off)", () => {
      const entry = getSettingsRegistryEntry("mail.smtpHost")!;
      expect(entry.schema.safeParse("").success).toBe(true);
      expect(entry.schema.safeParse("smtp.example.com").success).toBe(true);
      expect(entry.default).toBe("");
    });

    it("mail.fromName defaults to 'Loombre' and accepts any string", () => {
      const entry = getSettingsRegistryEntry("mail.fromName")!;
      expect(entry.default).toBe("Loombre");
      expect(entry.schema.safeParse("My Server").success).toBe(true);
    });
  });

  describe("optional mail transport run: no new entry is secret:true (credentials live in the keyring)", () => {
    it("none of the six new mail/network.publicUrl entries carry secret:true", () => {
      for (const key of ["mail.smtpHost", "mail.smtpPort", "mail.smtpSecurity", "mail.fromAddress", "mail.fromName", "network.publicUrl"]) {
        expect(getSettingsRegistryEntry(key)?.secret, key).toBeFalsy();
      }
    });
  });

  // ==========================================================================
  // Security review F5/F6/F11d: every scope:'ui' entry's `description` is
  // admin-UI-facing copy — plain language, no repo paths, no class/function
  // names, no signal names, no internal decision-ID citations.
  // ==========================================================================

  describe("F5/F6/F11d: scope:'ui' description register", () => {
    const uiEntries = SETTINGS_REGISTRY.filter((e) => e.scope === "ui");

    it("covers all 49 scope:'ui' entries (sanity — keeps this suite honest if the registry grows)", () => {
      expect(uiEntries.length).toBe(49);
    });

    it("no scope:'ui' description references a repo path (apps/, packages/, scripts/, docs/)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\b(apps|packages|scripts|docs)\//);
        expect(entry.caution ?? "", entry.key).not.toMatch(/\b(apps|packages|scripts|docs)\//);
      }
    });

    it("no scope:'ui' description references an internal decision ID (A1-A10, AD1-AD9, D1-D30-ish, P-phase IDs)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\b(A\d{1,2}|AD\d{1,2}|D\d{1,2}|P\d\.\d+)\b/);
      }
    });

    it("no scope:'ui' description references a POSIX signal name (SIGSTOP/SIGCONT/etc.)", () => {
      for (const entry of uiEntries) {
        expect(entry.description, entry.key).not.toMatch(/\bSIG[A-Z]+\b/);
      }
    });

    it("scanner.concurrency's description carries the CPU-derived-default honesty sentence (F6)", () => {
      const entry = getSettingsRegistryEntry("scanner.concurrency")!;
      expect(entry.description).toMatch(/half your processor cores/i);
    });

    it("restricted.defaultUnlockDurationMs's description does NOT claim a client-requested-duration path (F11d — that path does not exist)", () => {
      const entry = getSettingsRegistryEntry("restricted.defaultUnlockDurationMs")!;
      expect(entry.description).not.toMatch(/client/i);
      expect(entry.description).not.toMatch(/request/i);
    });
  });

  // ==========================================================================
  // RG12 (STATE.md "Loombre Remote..."): tls.mode/network.trustProxy
  // promoted from env-only to ui-scope, and three new ACME keys added — all
  // five preserve their pre-existing env var name and stay requiresRestart:true.
  // ==========================================================================

  describe("RG12: tls.* / network.trustProxy promotion + new ACME keys", () => {
    it("tls.mode is now scope:'ui', requiresRestart:true, envVar unchanged", () => {
      const entry = getSettingsRegistryEntry("tls.mode")!;
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(true);
      expect(entry.envVar).toBe("LOOMBRE_TLS_MODE");
      expect(entry.schema.safeParse("off").success).toBe(true);
      expect(entry.schema.safeParse("manual").success).toBe(true);
      expect(entry.schema.safeParse("acme").success).toBe(true);
      expect(entry.schema.safeParse("bogus").success).toBe(false);
    });

    it("network.trustProxy is now scope:'ui', requiresRestart:true, envVar unchanged, caution preserved", () => {
      const entry = getSettingsRegistryEntry("network.trustProxy")!;
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(true);
      expect(entry.envVar).toBe("LOOMBRE_TRUST_PROXY");
      expect(entry.caution).toBeDefined();
    });

    it("tls.acmeDomains: envVar LOOMBRE_ACME_DOMAINS, empty default, rejects a bare IP/no-dot value, accepts a real domain", () => {
      const entry = getSettingsRegistryEntry("tls.acmeDomains")!;
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(true);
      expect(entry.envVar).toBe("LOOMBRE_ACME_DOMAINS");
      expect(entry.default).toEqual([]);
      expect(entry.schema.safeParse(["media.example.com"]).success).toBe(true);
      expect(entry.schema.safeParse(["media.example.com", "alt.example.com"]).success).toBe(true);
      expect(entry.schema.safeParse(["not-a-domain"]).success).toBe(false);
      expect(entry.schema.safeParse(["203.0.113.10"]).success).toBe(false);
      expect(entry.schema.safeParse([""]).success).toBe(false);
    });

    it("tls.acmeDomains' parseEnv lowercases and comma-splits, mirroring apps/server/src/tls/config.ts's own LOOMBRE_ACME_DOMAINS parsing", () => {
      const entry = getSettingsRegistryEntry("tls.acmeDomains")!;
      expect(entry.parseEnv?.("Media.Example.com, Alt.Example.com")).toEqual(["media.example.com", "alt.example.com"]);
    });

    it("tls.acmeChallengeType: envVar LOOMBRE_ACME_CHALLENGE_TYPE, default http-01, closed enum", () => {
      const entry = getSettingsRegistryEntry("tls.acmeChallengeType")!;
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(true);
      expect(entry.envVar).toBe("LOOMBRE_ACME_CHALLENGE_TYPE");
      expect(entry.default).toBe("http-01");
      expect(entry.schema.safeParse("http-01").success).toBe(true);
      expect(entry.schema.safeParse("dns-01").success).toBe(true);
      expect(entry.schema.safeParse("tls-alpn-01").success).toBe(false);
    });

    it("tls.acmeTosAgreed: envVar LOOMBRE_ACME_TOS_AGREED, default false, boolean", () => {
      const entry = getSettingsRegistryEntry("tls.acmeTosAgreed")!;
      expect(entry.scope).toBe("ui");
      expect(entry.requiresRestart).toBe(true);
      expect(entry.envVar).toBe("LOOMBRE_ACME_TOS_AGREED");
      expect(entry.default).toBe(false);
      expect(entry.schema.safeParse(true).success).toBe(true);
      expect(entry.schema.safeParse("1").success).toBe(false);
    });

    it("none of the five promoted/new keys is flagged secret:true", () => {
      for (const key of ["tls.mode", "network.trustProxy", "tls.acmeDomains", "tls.acmeChallengeType", "tls.acmeTosAgreed"]) {
        expect(getSettingsRegistryEntry(key)?.secret, key).toBeFalsy();
      }
    });
  });

  // ==========================================================================
  // W13b (decision D-7, layer 2): the `technicalDetails` additive field —
  // the plain-language `description` sweep's carrier for the precise
  // technical detail (protocol notes, format specifics, behavioral caveats)
  // moved OUT of the visible description. Rendered by apps/web's SettingField
  // in an on-demand info tooltip (W13a built the mechanism; this sweep wires
  // per-key content into it).
  // ==========================================================================

  describe("W13b: `technicalDetails` — the second copy layer", () => {
    it("is present (non-empty) on every entry whose description used to carry protocol/format specifics — spot check across categories", () => {
      for (const key of [
        "database.url",
        "http.port",
        "paths.dataDir",
        "network.corsOrigins",
        "network.publicUrl",
        "mail.smtpPort",
        "mail.smtpSecurity",
        "remote.subnet",
        "tls.mode",
        "tls.acmeDomains",
        "network.trustProxy",
      ]) {
        const entry = getSettingsRegistryEntry(key)!;
        expect(entry.technicalDetails, key).toBeDefined();
        expect(entry.technicalDetails!.length, key).toBeGreaterThan(0);
      }
    });

    it("mail.smtpPort's technicalDetails carries the 587/465/25 SMTP port explanation the description no longer states inline", () => {
      const entry = getSettingsRegistryEntry("mail.smtpPort")!;
      expect(entry.technicalDetails).toMatch(/587/);
      expect(entry.technicalDetails).toMatch(/465/);
      expect(entry.technicalDetails).toMatch(/25/);
      expect(entry.technicalDetails).toMatch(/STARTTLS/i);
    });

    it("mail.smtpPort's visible description stays plain — no bare port-number-to-protocol mapping", () => {
      const entry = getSettingsRegistryEntry("mail.smtpPort")!;
      expect(entry.description).not.toMatch(/STARTTLS|implicit/i);
    });

    it("technicalDetails, when present, is never just a restatement of the envVar pin (SettingField auto-folds that in on its own)", () => {
      for (const entry of SETTINGS_REGISTRY) {
        if (!entry.technicalDetails || !entry.envVar) continue;
        expect(entry.technicalDetails, entry.key).not.toMatch(new RegExp(`Pinnable via.*${entry.envVar}`));
      }
    });

    it("no entry's technicalDetails is identical to its description (the whole point is a SECOND layer, not a duplicate)", () => {
      for (const entry of SETTINGS_REGISTRY) {
        if (!entry.technicalDetails) continue;
        expect(entry.technicalDetails, entry.key).not.toBe(entry.description);
      }
    });

    it("every scope:'ui' entry's technicalDetails, like its description, stays free of internal decision-ID citations", () => {
      for (const entry of SETTINGS_REGISTRY) {
        if (entry.scope !== "ui" || !entry.technicalDetails) continue;
        expect(entry.technicalDetails, entry.key).not.toMatch(/\b(A\d{1,2}|AD\d{1,2}|D\d{1,2}|P\d\.\d+)\b/);
      }
    });
  });
});
