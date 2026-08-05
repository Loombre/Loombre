// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/settings-boot-bridge.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG12). RG12 promoted tls.mode,
// tls.acmeDomains, tls.acmeChallengeType, tls.acmeTosAgreed, and
// network.trustProxy from env-only to ui-scope (packages/shared/src/
// settings-registry.ts) so the Direct path's wizard can commit a validated
// ACME/reverse-proxy configuration through the ordinary settings machinery.
// BUT apps/server/src/main.ts resolves TLS mode and trust-proxy ONCE, at
// boot, by reading `process.env` directly (`loadTlsConfig(process.env)`,
// `applyTrustProxy(app, process.env["LOOMBRE_TRUST_PROXY"])`) — it has NO
// idea SettingsService or server_settings even exist. Without this bridge,
// a DB-only-committed `tls.mode="acme"` would be silently invisible at the
// next restart: the wizard's own promise ("restart to apply") would be a
// LIE for these five keys specifically, even though every other requires-
// Restart:true key in this registry (remote.wireguardPort/subnet) is
// consumed by a module that reads SettingsService normally, well after
// Nest's DI container is live — TLS is different because it gates HOW
// Express itself gets wrapped, before app.listen()/app.init() ever runs.
//
// THE BRIDGE: hydrates `process.env` from the already-booted SettingsService
// for exactly these five keys, BEFORE main.ts's existing raw-env readers
// run — env still wins unconditionally (A8): this only fills in a value
// for a var that isn't ALREADY set, and only when the effective value
// actually came from the database (source==="database"; a bare registry
// default needs no hydration at all, since that's already what an unset
// env var + no DB row produces today). A fresh/never-touched install (no
// server_settings rows for these keys) is byte-identical to before this
// module existed — every hydrate() call below is then a silent no-op.
//
// SAFE BY CONSTRUCTION: never throws (mirrors main.ts's own
// resolveAndSeedJwtSecret "never throws... falls back... logged loudly
// rather than crashing boot over a convenience feature" precedent,
// literally the next function up the file) — main.ts wraps the call in a
// try/catch regardless, but this module's own contract is also "cannot
// fail its caller", since a DB hiccup at this exact boot moment must never
// turn a previously env-only, DB-independent code path (TLS mode
// selection) into one that can crash boot.

// Mirrors packages/shared/src/settings-resolve.ts's SettingsValueSource
// exactly ("environment", not "env") — not imported directly so this
// module stays trivially fake-able in tests without a @loombre/shared
// build dependency; EffectiveSettingsReader below is what actually keeps
// this in sync (SettingsService.getEffective's real return type must be
// structurally assignable to it, checked by the TypeScript compiler at
// every call site, e.g. main.ts's `app.get(SettingsService)`).
export type EffectiveSettingsSource = "environment" | "database" | "default";

export interface EffectiveSettingLike {
  value: unknown;
  source: EffectiveSettingsSource;
}

/** The minimal shape this module needs from SettingsService — kept as an
 *  interface (not an import of the class) so this module stays trivially
 *  unit-testable with a plain object, no NestJS/DB bootstrapping involved. */
export interface EffectiveSettingsReader {
  getEffective(key: string): EffectiveSettingLike | undefined;
}

interface HydrationRule {
  key: string;
  envVar: string;
  serialize: (value: unknown) => string;
}

const HYDRATION_RULES: readonly HydrationRule[] = [
  { key: "tls.mode", envVar: "LOOMBRE_TLS_MODE", serialize: (v) => String(v) },
  {
    key: "tls.acmeDomains",
    envVar: "LOOMBRE_ACME_DOMAINS",
    serialize: (v) => (Array.isArray(v) ? v.join(",") : String(v)),
  },
  { key: "tls.acmeChallengeType", envVar: "LOOMBRE_ACME_CHALLENGE_TYPE", serialize: (v) => String(v) },
  { key: "tls.acmeTosAgreed", envVar: "LOOMBRE_ACME_TOS_AGREED", serialize: (v) => (v ? "1" : "0") },
  { key: "network.trustProxy", envVar: "LOOMBRE_TRUST_PROXY", serialize: (v) => String(v) },
];

/**
 * Mutates `env` in place. Pure with respect to `settings` (only calls
 * `getEffective`, never writes back to it) — every side effect lands on
 * `env`, exactly the same "caller passes process.env explicitly, no
 * process.env fallback default" discipline apps/server/src/tls/config.ts's
 * own `loadTlsConfig` documents in its header, so this is equally testable
 * with a fake env object and no global state leakage between test cases.
 */
export function hydrateTlsEnvFromSettings(settings: EffectiveSettingsReader, env: NodeJS.ProcessEnv): void {
  for (const rule of HYDRATION_RULES) {
    const effective = settings.getEffective(rule.key);
    if (effective === undefined || effective.source !== "database") continue;
    const current = env[rule.envVar];
    if (current !== undefined && current.trim() !== "") continue; // real env already wins — never override
    env[rule.envVar] = rule.serialize(effective.value);
  }
}
