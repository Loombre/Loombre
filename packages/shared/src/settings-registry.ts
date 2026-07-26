// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/settings-registry.ts
//
// Addendum A (STATE.md, admin-configurable server settings), decision A1:
// the SINGLE typed source of truth every other piece renders from — the
// admin settings UI (apps/web, lane S2), the API validator (apps/server/
// src/settings/, lane S1), the generated operator/admin docs (lane D1),
// and this package's own z.toJSONSchema projection (settingsValueJsonSchema
// below, AD3) all read this array and nothing else. Nobody hand-writes a
// second copy of a setting's shape anywhere in the codebase.
//
// Two disjoint scopes (A2/A3):
//   'env-only' — bootstrap/lockout-risk configuration (docs/PLAN.md's own
//     "before the DB is readable, or misconfiguration can sever admin
//     access" framing): database URL, HTTP port, data/config/transcode-
//     staging paths, ffmpeg/ffprobe binaries, trust-proxy, CORS origins,
//     TLS/ACME mode. Read-only in the admin UI — the projection shows the
//     resolved value + its envVar so an operator can SEE it, never edit it
//     through this surface. Every entry here always carries `envVar`.
//   'ui' — admin-editable, persisted in server_settings (migrations/
//     0013_server_settings.sql), the A3 set (+ AD1's rate-limit floor).
//     Some 'ui' entries ALSO carry `envVar` (A8's env-pin mechanism): env,
//     when set, wins over any DB value and locks the setting read-only in
//     the projection ("set by environment" + the var name) without
//     discarding the DB row underneath it (env-pin precedence is
//     packages/shared/src/settings-resolve.ts's job, not this file's).
//
// Every default below is grounded in a real, surveyed read site — see this
// lane's final report for the full key<->env<->read-site<->default table.
// Where no real env var exists today (most of the A3 knobs were previously
// bare hardcoded constants, per capabilities.ts's own "no instance-settings
// table exists yet" note), `envVar` is simply omitted — a UI-editable entry
// with no envVar can never be locked, only ever DB-or-default.
//
// tierDefaults (A8): LOOMBRE_TIER (0/1/2, read at the call site — this
// package does not itself decide the running instance's tier) selects among
// a PER-TIER default for the few knobs whose sane default genuinely depends
// on hardware class (today: only maxSimultaneousTranscodes, matching
// apps/server/src/playback/resolve-policy.ts's historical
// TIER_DEFAULT_MAX_TRANSCODES table verbatim — lane S3 removed that
// now-redundant constant from resolve-policy.ts itself once
// maxSimultaneousTranscodes moved to this registry, since
// SettingsService.getEffective() already resolves the tier-aware default
// from THIS table; see resolve-policy.ts's own header). `default` alone
// remains valid and sufficient for every other entry — tierDefaults is
// opt-in, not a second required field.

import { z } from "zod";

export type SettingsScope = "ui" | "env-only";
export type SettingsTier = 0 | 1 | 2;

export type SettingsCategory =
  | "transcode"
  | "scanner"
  | "images"
  | "restricted"
  | "sessions"
  | "updateCheck"
  | "security"
  | "rateLimit"
  | "database"
  | "network"
  | "tls"
  | "paths"
  | "ffmpeg";

/**
 * Converts a raw environment-variable string into the pre-validation value
 * `schema` expects (e.g. "true"/"1" -> boolean, "10" -> number). Omitted for
 * entries whose schema already accepts a bare string (most env-only path/
 * URL/passthrough entries). Never throws — an unparseable raw value returns
 * `undefined`, which settings-resolve.ts treats as "this env value doesn't
 * apply", falling through to the DB value or default exactly like an unset
 * variable (never a boot crash, matching A4's "never a crash" discipline).
 */
export type EnvValueParser = (raw: string) => unknown;

export interface SettingsRegistryEntry<T = unknown> {
  key: string;
  schema: z.ZodType<T>;
  /** Simple-case default (also the tier-0 default when `tierDefaults` is
   *  present — tier 0 is always the conservative/base tier in this repo's
   *  existing tier tables, e.g. transcode.maxSimultaneousTranscodes's own
   *  tierDefaults below, matching resolve-policy.ts's historical
   *  TIER_DEFAULT_MAX_TRANSCODES table verbatim). */
  default: T;
  /** Present only for the handful of knobs with a hardware-tier-dependent
   *  sane default (A8). Absent keys fall back to `default`. */
  tierDefaults?: Partial<Record<SettingsTier, T>>;
  category: SettingsCategory;
  description: string;
  /** Optional operator-facing caution surfaced by the UI/docs projection
   *  (e.g. a setting whose misconfiguration degrades but never locks out). */
  caution?: string;
  /** Whether a change only takes effect at next server boot (A5). Every
   *  requiresRestart:false entry MUST be safe to apply to already-running
   *  request handling without dropping in-flight work — see this lane's
   *  report for the LAW ("no setting change may drop active playback
   *  sessions") as it applies to transcode.maxSimultaneousTranscodes. */
  requiresRestart: boolean;
  scope: SettingsScope;
  /** The real environment variable this entry is pinnable by (A8) or
   *  exclusively sourced from (A2). 1:1 with a surveyed real read site —
   *  never invented for a knob with no existing env convention. */
  envVar?: string;
  parseEnv?: EnvValueParser;
  /** Security review F1: true when this entry's effective/default value
   *  itself EMBEDS a credential (e.g. a connection string with an inline
   *  username:password) rather than merely being sensitive-adjacent
   *  configuration (a TLS cert path, an ffmpeg binary path, a data
   *  directory — none of those are secrets; you cannot authenticate as
   *  anything with just a path). GET /v1/admin/settings and GET
   *  /v1/admin/settings/schema (apps/server/src/settings/settings.service.ts's
   *  toAdminSettingsResponse/toSchemaResponse) mask the credential portion
   *  of `value`/`default` for every entry carrying this flag — never the
   *  raw value, not even to a live-verified admin. Absent (falsy) means
   *  "render normally", the pre-F1 behavior. */
  secret?: boolean;
}

function defineSetting<T>(entry: SettingsRegistryEntry<T>): SettingsRegistryEntry<T> {
  return entry;
}

// ============================================================================
// Shared env-value parsers (one canonical convention per JS type — see this
// lane's report for how each compares to the specific legacy read site's own
// parsing quirks; S3, migrating those read sites, should double-check any
// noted divergence).
// ============================================================================

const ENV_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const ENV_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** Explicit true/false vocabulary only; anything else is unparseable
 *  (falls through) rather than silently guessed at. */
export function parseEnvBoolean(raw: string): boolean | undefined {
  const lowered = raw.trim().toLowerCase();
  if (ENV_TRUE_VALUES.has(lowered)) return true;
  if (ENV_FALSE_VALUES.has(lowered)) return false;
  return undefined;
}

export function parseEnvPositiveInt(raw: string): number | undefined {
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseEnvCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim().replace(/\/+$/, ""))
    .filter((v) => v.length > 0);
}

// ============================================================================
// Value schemas for the shapes richer than a scalar
// ============================================================================

export const LADDER_RUNG_CODECS = ["h264", "hevc"] as const;

/** Mirrors packages/playback-engine's LadderRung type field-for-field
 *  (docs/PLAYBACK.md §2.4) — playback-engine itself is never imported here
 *  (its purity law forbids importing anything, CLAUDE.md invariant 2), this
 *  is an independent structural echo validated by packages/shared's own
 *  tests, not a type import. */
export const LADDER_RUNG_SCHEMA = z.object({
  heightPx: z.number().int().positive(),
  // Security review F9: a schema-legal-but-absurd bitrate (e.g. 1 bps, or
  // MAX_SAFE_INTEGER bps) is still schema-legal today without a ceiling —
  // bounded to a sane real-world range (100 kbps floor, 100 Mbps ceiling;
  // the default table's own widest rung is 16 Mbps) so a single-rung edit
  // cannot produce an unencodable or resource-exhausting ladder.
  videoBitrateBps: z.number().int().min(100_000).max(100_000_000),
  audioBitrateBps: z.number().int().min(100_000).max(100_000_000),
  codec: z.enum(LADDER_RUNG_CODECS),
});

export type LadderRungValue = z.infer<typeof LADDER_RUNG_SCHEMA>;

/** apps/server/src/playback/resolve-policy.ts's DEFAULT_LADDER_RUNGS,
 *  transcribed verbatim (that module's own header: reused byte-for-byte
 *  from packages/playback-engine's matrix fixtures) — the registry default
 *  MUST equal today's behavior. */
export const DEFAULT_LADDER_RUNGS: LadderRungValue[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
];

// ============================================================================
// A2 — env-only entries (lockout/bootstrap boundary)
// ============================================================================

const ENV_ONLY_ENTRIES: SettingsRegistryEntry[] = [
  defineSetting({
    key: "database.url",
    schema: z.string().min(1),
    default: "postgres://loombre:loombre@localhost:5442/loombre",
    category: "database",
    description: "PostgreSQL connection string. Read before any DB-backed configuration (including this registry's own DB half) can be resolved at all.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "DATABASE_URL",
    // Security review F1 (the headline finding): this connection string
    // embeds a password. Audited every other env-only entry for the same
    // shape (http.port, the four path entries, the two ffmpeg/ffprobe
    // paths, network.trustProxy, network.corsOrigins, tls.mode) — none of
    // them are credentials, only this one is.
    secret: true,
  }),
  defineSetting({
    key: "http.port",
    schema: z.number().int().min(1).max(65535),
    default: 3001,
    category: "network",
    description: "TCP port the plain-HTTP listener binds (apps/server/src/main.ts). Ignored when tls.mode is not 'off' (TLS mode binds its own https port).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "PORT",
    parseEnv: (raw) => Number.parseInt(raw.trim(), 10),
  }),
  defineSetting({
    key: "paths.dataDir",
    schema: z.string().min(1),
    // Illustrative only — the real default is platform-derived
    // (apps/server/src/cli/app-paths.ts's XDG/%LOCALAPPDATA%/Application
    // Support resolution), which this static registry default cannot
    // reproduce without a process.platform read at module-eval time. See
    // this lane's report for the divergence (apps/worker's own
    // DEFAULT_DATA_DIR literal, './data', reused here for a grounded value
    // rather than an invented one).
    default: "./data",
    category: "paths",
    description: "App data directory (media cache, secrets, images, TLS state). Platform default when unset: XDG_DATA_HOME/loombre (Linux), ~/Library/Application Support/Loombre (macOS), %LOCALAPPDATA%/Loombre (Windows) — see apps/server/src/cli/app-paths.ts.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_DATA_DIR",
  }),
  defineSetting({
    key: "paths.configDir",
    schema: z.string().min(1),
    default: "./config",
    category: "paths",
    description: "App config directory. Platform default when unset: XDG_CONFIG_HOME/loombre (Linux), Application Support/Loombre/config (macOS), %APPDATA%/Loombre (Windows) — see apps/server/src/cli/app-paths.ts.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_CONFIG_DIR",
  }),
  defineSetting({
    key: "paths.transcodeStagingDir",
    schema: z.string().min(1),
    // Illustrative — real default is `${os.tmpdir()}/loombre-transcode`
    // (apps/worker/src/transcode/config.ts's resolveTranscodeStagingRoot).
    default: "/tmp/loombre-transcode",
    category: "paths",
    description: "Root directory transcode session staging directories are created under (docs/PLAYBACK.md §9 binding constraint 3). Default: <os.tmpdir()>/loombre-transcode.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_TRANSCODE_DIR",
  }),
  defineSetting({
    key: "ffmpeg.path",
    schema: z.string(),
    default: "",
    category: "ffmpeg",
    description: "Explicit ffmpeg binary path. Empty means resolve via PATH (apps/worker/src/probe/ffprobe.ts's resolveBinary).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_FFMPEG",
  }),
  defineSetting({
    key: "ffprobe.path",
    schema: z.string(),
    default: "",
    category: "ffmpeg",
    description: "Explicit ffprobe binary path. Empty means resolve via PATH (apps/worker/src/probe/ffprobe.ts's resolveBinary).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_FFPROBE",
  }),
  defineSetting({
    key: "network.trustProxy",
    schema: z.string(),
    default: "",
    category: "network",
    description: "Express 'trust proxy' setting (boolean-like flag, hop count, or CIDR/preset list). Empty/unset means disabled — req.ip is the raw socket address and X-Forwarded-For is ignored (apps/server/src/main.ts's resolveTrustProxySetting).",
    caution: "Only enable behind a reverse proxy you control — enabling this trusts client-supplied X-Forwarded-For for rate-limit and anomaly-log keying.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_TRUST_PROXY",
  }),
  defineSetting({
    key: "network.corsOrigins",
    schema: z.array(z.string()),
    default: ["http://localhost:3000", "http://127.0.0.1:3000"],
    category: "network",
    description: "Strict CORS origin allowlist for the browser web client. An explicitly empty list disables CORS entirely (same-origin deployments). Unset falls back to the local dev pairing (apps/server/src/main.ts's resolveCorsOrigins).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_CORS_ORIGINS",
    parseEnv: parseEnvCommaList,
  }),
  defineSetting({
    key: "tls.mode",
    schema: z.enum(["off", "manual", "acme"]),
    default: "off",
    category: "tls",
    description: "TLS termination mode: 'off' (plain HTTP, e.g. behind a reverse proxy), 'manual' (operator-supplied cert/key files), or 'acme' (built-in Let's Encrypt issuance). See apps/server/src/tls/config.ts.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_TLS_MODE",
  }),
];

// ============================================================================
// A3 (+ AD1) — UI-editable entries
// ============================================================================

const UI_ENTRIES: SettingsRegistryEntry[] = [
  // ---- transcode policy ----
  defineSetting({
    key: "transcode.maxSimultaneousTranscodes",
    // Security review F9: unbounded above meant a schema-legal edit (or a
    // schema-legal env pin, e.g. a copy-pasted extra zero) could try to
    // admit an unbounded number of concurrent conversions. 64 is far past
    // any real hardware this product targets — a ceiling, not a realistic
    // operating point.
    schema: z.number().int().min(1).max(64),
    default: 1,
    tierDefaults: { 0: 1, 1: 2, 2: 4 },
    category: "transcode",
    description: "How many videos this server will convert at the same time. Lowering it never interrupts anything already playing — it only makes the next person wait for a free slot.",
    caution: "Setting this too high can overload the server if several videos convert at once — raise it gradually and keep an eye on how the machine handles it.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_MAX_TRANSCODES",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "transcode.hevcEncodePreferred",
    schema: z.boolean(),
    default: true,
    category: "transcode",
    description: "When converting, prefer the newer, more efficient video format (HEVC) over the older, more compatible one (H.264). Only used when your hardware supports it.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.allowToneMapCpu",
    schema: z.enum(["always", "never", "tier-gated"]),
    default: "tier-gated",
    category: "transcode",
    description: "Advanced: whether Loombre may convert high-dynamic-range (HDR) video to standard range using the processor when the video hardware can't do it directly. Processor conversion is slower and uses more of the server's resources. By default this is only allowed on more capable servers; it can also be switched on everywhere or off entirely.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.ladderRungs",
    schema: z.array(LADDER_RUNG_SCHEMA).min(1),
    default: DEFAULT_LADDER_RUNGS,
    category: "transcode",
    description: "The set of quality levels Loombre can switch between while converting, best first. Loombre picks the highest one your connection can keep up with.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.segmentAheadSuspendThreshold",
    schema: z.number().int().min(1),
    default: 10,
    category: "transcode",
    description: "Advanced: how far ahead of what's currently playing Loombre is allowed to convert before it pauses conversion to save resources, measured in a few seconds of video at a time. Applies for the rest of the current viewing session — a change takes effect the next time someone starts watching something that needs converting.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.segmentAheadResumeThreshold",
    schema: z.number().int().min(0),
    default: 5,
    category: "transcode",
    description: "Advanced: how far the paused conversion above has to catch back down to before Loombre resumes it. Applies the same way as the setting above — the next time someone starts watching something that needs converting.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- scanner ----
  defineSetting({
    key: "scanner.concurrency",
    // Security review F9: unbounded above meant a schema-legal edit could
    // try to run an absurd number of parallel scan workers — 64 is a
    // ceiling far past any real hardware this product targets.
    schema: z.number().int().min(1).max(64),
    // The real unset-env-and-no-DB-row fallback is CPU-derived (max(2,
    // cpus/2)) — this static registry default is the documented floor of
    // that formula, a conservative grounded choice rather than a fixed
    // guess at "the" CPU count. A static `default` field cannot itself
    // express a host-derived formula, so lane S3's worker-side reader
    // (apps/worker/src/settings/effective-settings.ts's
    // resolveScanConcurrencyFromEffective) overrides this literal with the
    // real CPU-derived value whenever source==='default', keeping the
    // Addendum A behavior invariant exact — env pins and DB rows both flow
    // through unchanged. See this lane's final report.
    default: 2,
    category: "scanner",
    description: "How many files Loombre examines at once while scanning. Higher is faster but works the machine harder; takes effect on the next scan. When you haven't changed it, Loombre uses half your processor cores (minimum 2).",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SCAN_CONCURRENCY",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "scanner.missingFileGraceHours",
    schema: z.number().int().min(1),
    default: 72,
    category: "scanner",
    description: "How long a file can be missing before Loombre removes it from your library. The delay protects your watch history when a network drive drops out briefly.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- images ----
  defineSetting({
    key: "images.avifEnabled",
    schema: z.boolean(),
    default: true,
    category: "images",
    description: "Also save each poster and thumbnail in a newer, smaller image format (AVIF) alongside the standard one, when this server is able to create it. Turning this off only stops new AVIF copies from being made — images already created are untouched. Takes effect the next time an image is generated or a scan re-processes one.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "images.webpQuality",
    schema: z.number().int().min(1).max(100),
    default: 80,
    category: "images",
    description: "Image quality for posters and thumbnails, from 1 (smallest file, lowest quality) to 100 (largest file, highest quality). Already-created images are untouched — this only affects new images and ones a future scan re-creates.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "images.avifQuality",
    schema: z.number().int().min(1).max(100),
    default: 50,
    category: "images",
    description: "Image quality for the smaller AVIF copies of posters and thumbnails (see the setting above), from 1 to 100, used when that setting is turned on and this server can create them. Already-created images are untouched — this only affects new images and ones a future scan re-creates.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- restricted content ----
  defineSetting({
    key: "restricted.enabled",
    schema: z.boolean(),
    default: false,
    category: "restricted",
    description: "Turns the restricted-content feature on for this server. Off by default. While off, no restricted libraries or restricted content can be created.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RESTRICTED_ENABLED",
    parseEnv: parseEnvBoolean,
  }),
  defineSetting({
    key: "restricted.majorityAgeYears",
    // D13 hard floor, enforced HERE in the schema AND, redundantly, in
    // apps/server/src/settings/settings.service.ts's mutation path (A3:
    // "the >=18 floor enforced in schema AND service") — instance-
    // configurable UPWARD only.
    schema: z.number().int().min(18),
    default: 18,
    category: "restricted",
    description: "The minimum age for restricted content. Can be raised, never lowered — 18 is a hard floor the server enforces in several independent places.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "restricted.defaultUnlockDurationMs",
    // Security review F4: floor-only (.min(1)) let a schema-legal
    // MAX_SAFE_INTEGER value turn gate 5 into a permanent unlock. Bounded
    // to a real range: at least 1 minute, at most 24 hours.
    schema: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
    default: 30 * 60 * 1000,
    category: "restricted",
    description: "How long restricted content stays unlocked after someone enters their PIN, before it locks itself again.",
    caution: "Longer times mean the PIN is asked for less often — on a shared device that means restricted content stays available to whoever picks it up.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- sessions ----
  defineSetting({
    key: "sessions.staleCutoffMs",
    // Security review F9: bounded (was floor-only) — at least 1 minute, at
    // most 24 hours. Also validated cross-field against
    // sessions.heartbeatSuspendCutoffMs in SettingsService.updateSetting
    // (the registry alone cannot express "greater than this OTHER key's
    // current value").
    schema: z.number().int().min(60_000).max(86_400_000),
    default: 15 * 60_000,
    category: "sessions",
    description: "How long Loombre waits after a device stops responding before treating that person's playback as finished and freeing up the resources.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "sessions.heartbeatSuspendCutoffMs",
    // Security review F9: bounded (was floor-only) — at least 30 seconds,
    // at most 1 hour. Also validated cross-field against
    // sessions.staleCutoffMs — see that entry's description.
    schema: z.number().int().min(30_000).max(3_600_000),
    default: 90_000,
    category: "sessions",
    description: "How long Loombre waits after a device goes quiet before pausing its conversion. Playback isn't ended — it resumes when the device comes back.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- update check ----
  defineSetting({
    key: "updateCheck.mode",
    schema: z.enum(["off", "manual", "daily"]),
    default: "daily",
    category: "updateCheck",
    description: "Whether Loombre checks for a newer version. 'daily' checks at startup and once a day; 'manual' only when you ask; 'off' never. Nothing identifying is ever sent, in any mode. Loombre never installs an update by itself.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_UPDATE_CHECK",
    parseEnv: (raw) => raw.trim().toLowerCase(),
  }),

  // ---- security ----
  defineSetting({
    key: "security.loginAnomalyLogEnabled",
    schema: z.boolean(),
    default: true,
    category: "security",
    description: "Record suspicious sign-in activity — failed passwords, wrong PINs, too many attempts — to a log file on this machine. Nothing is ever sent anywhere.",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- auth/surface rate limits (AD1) — every entry has a hard floor of 1
  // in its own unit (per-minute for login/refresh/unlock/setup/
  // capabilities/mediaToken, per-hour for export) so no submitted value can
  // ever reduce a limiter to zero admitted requests and sever login.
  defineSetting({
    key: "rateLimit.login",
    schema: z.number().int().min(1),
    default: 10,
    category: "rateLimit",
    description: "How many sign-in attempts one device may make per minute before Loombre starts turning it away. Guards against password guessing.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_LOGIN",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.refresh",
    schema: z.number().int().min(1),
    default: 30,
    category: "rateLimit",
    description: "How many session-refresh requests one device may make per minute. Guards against a device flooding the server with requests for new sign-in tokens.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_REFRESH",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.unlock",
    schema: z.number().int().min(1),
    default: 5,
    category: "rateLimit",
    description: "How many PIN attempts one person may make per minute when unlocking restricted content. Guards against someone guessing the PIN.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_UNLOCK",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.setup",
    schema: z.number().int().min(1),
    default: 20,
    category: "rateLimit",
    description: "How many requests one device may make per minute to the first-time setup screen, before any account exists. Guards against abuse of that screen.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_SETUP",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.capabilities",
    schema: z.number().int().min(1),
    default: 120,
    category: "rateLimit",
    description: "How many times one device may ask the server what it supports, per minute. This is checked often during normal use, so the limit is set high.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_CAPABILITIES",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.export",
    schema: z.number().int().min(1),
    default: 5,
    category: "rateLimit",
    description: "How many full library exports one person may download per hour (not per minute — exports are heavy).",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_EXPORT",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.mediaToken",
    schema: z.number().int().min(1),
    default: 600,
    category: "rateLimit",
    description: "How many media requests one person may make per minute — posters, video, and subtitles combined. Set this high: normal viewing makes many small requests.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_MEDIA_TOKEN",
    parseEnv: parseEnvPositiveInt,
  }),
];

export const SETTINGS_REGISTRY: readonly SettingsRegistryEntry[] = [...ENV_ONLY_ENTRIES, ...UI_ENTRIES];

export const SETTINGS_REGISTRY_BY_KEY: ReadonlyMap<string, SettingsRegistryEntry> = new Map(
  SETTINGS_REGISTRY.map((entry) => [entry.key, entry]),
);

export function getSettingsRegistryEntry(key: string): SettingsRegistryEntry | undefined {
  return SETTINGS_REGISTRY_BY_KEY.get(key);
}

/**
 * AD3/A1: z.toJSONSchema projection for one entry's VALUE schema — the one
 * source that feeds the GET /admin/settings/schema endpoint (lane S2), the
 * UI's dynamic form renderer, and the generated docs (lane D1). Deliberately
 * projects `entry.schema` alone, not the whole entry — callers that need the
 * rest of the entry's metadata (category/description/scope/...) already have
 * the SettingsRegistryEntry itself.
 */
export function settingsValueJsonSchema(entry: SettingsRegistryEntry): Record<string, unknown> {
  return z.toJSONSchema(entry.schema) as Record<string, unknown>;
}

/** Resolves the tier-aware default for one entry — `tierDefaults[tier]` when
 *  present for that tier, else the entry's simple `default`. */
export function registryDefaultForTier<T>(entry: SettingsRegistryEntry<T>, tier: SettingsTier): T {
  const tiered = entry.tierDefaults?.[tier];
  return tiered !== undefined ? tiered : entry.default;
}
