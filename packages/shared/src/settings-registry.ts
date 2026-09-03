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
// on hardware class (today: only maxSimultaneousTranscodes, currently
// { 0: 2, 1: 2, 2: 4 } — SPF-8 raised tier 0 from 1 so a single background
// transcode can never occupy the only slot and block a viewer's own
// playback — matching apps/server/src/playback/resolve-policy.ts's
// historical TIER_DEFAULT_MAX_TRANSCODES table verbatim — lane S3 removed
// that now-redundant constant from resolve-policy.ts itself once
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
  | "ffmpeg"
  | "stash"
  | "mail"
  | "remote";

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
  /** VISIBLE, always-on copy — plain, task-oriented language a self-hosting
   *  non-engineer can act on without help: what this setting does, when
   *  you'd change it, and what the safe default means. Never repo paths,
   *  internal decision IDs, or protocol/format minutiae — see
   *  `technicalDetails` for that layer (D-7, W13b). */
  description: string;
  /** Optional operator-facing caution surfaced by the UI/docs projection
   *  (e.g. a setting whose misconfiguration degrades but never locks out). */
  caution?: string;
  /** D-7's second copy layer: the precise technical detail `description`
   *  deliberately leaves out — protocol notes (e.g. which SMTP port means
   *  what), exact format/bounds specifics, and behavioral caveats a curious
   *  or advanced admin wants but a first read doesn't need. Rendered by
   *  apps/web's SettingField in an on-demand info tooltip (W13a), which
   *  ALSO auto-folds this entry's own env-pin name in underneath — never
   *  restate "Pinnable via <VAR>" here, that sentence is generated for you.
   *  Optional and additive: an absent value simply means no info trigger
   *  renders beyond whatever the env-pin note alone would show. */
  technicalDetails?: string;
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
  /** True when the REAL default is derived at runtime — from the platform
   *  (apps/server/src/cli/app-paths.ts's resolveAppPaths for the path
   *  entries), from the host's CPU count (apps/worker/src/settings/
   *  effective-settings.ts's resolveScanConcurrencyFromEffective for
   *  scanner.concurrency), or from a mode selection (an unset DATABASE_URL
   *  selects embedded-PostgreSQL provisioning, apps/server/src/bootstrap/
   *  provisioning.ts) — and the static `default` below is only an
   *  illustrative fallback that cannot reproduce it. Doc generators
   *  (scripts/docs/gen-env-reference.mjs) suppress the "Default when
   *  unset" bullet for these entries so the description's own
   *  derived-default sentence — the true answer — is the only default
   *  stated (audit fafa47f, AUD-A6b-002; extended per F24-1/F33-6/T04-3). */
  platformDerivedDefault?: boolean;
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

/** Mirrors packages/playback-engine's `LADDER_CODECS` (docs/PLAYBACK.md
 *  §7/§7.1's `LadderCodec`) — the closed set of codecs a rung may ENCODE
 *  to, deliberately narrower than the source-fact `VideoCodec` union.
 *  `av1` landed with LD-7 (Wave C1). This is an independent structural
 *  echo, NOT a type import (playback-engine's purity law forbids importing
 *  anything into it, and shared may not depend on it either);
 *  apps/server/test/contract-reason-codes.spec.ts is the three-way drift
 *  guard that holds this array, the engine's, and openapi.yaml's
 *  `LadderCodec` enum to each other. */
export const LADDER_RUNG_CODECS = ["h264", "hevc", "av1"] as const;

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

/** Optional mail transport run, M9/M10: `network.publicUrl` — empty (unset)
 *  or an absolute http(s) URL. Validated with the `URL` constructor rather
 *  than a hand-rolled regex (a regex would either reject legal URLs or
 *  accept garbage the constructor itself would choke on later) — only the
 *  scheme is constrained; host shape, port, and path are whatever `URL`
 *  itself accepts. Every mail link the worker builds is derived ONLY from
 *  this value (E7: zero Host-header trust for security-sensitive links).
 *
 *  Deliberately NOT a `.transform()` that strips a trailing slash at the
 *  schema level (the brief's "store/normalize without trailing slash"):
 *  settingsValueJsonSchema()/AD3 projects this exact schema through
 *  `z.toJSONSchema()` for the admin UI's form renderer, and zod v4 cannot
 *  represent a transform in JSON Schema at all (throws "Transforms cannot
 *  be represented in JSON Schema" — verified at this lane's own test run).
 *  Normalization instead happens at the READ site,
 *  apps/server/src/mail/mail-config.service.ts's `publicUrl()` — which
 *  covers a trailing slash arriving via ANY source (env pin, database row,
 *  or default) uniformly, not just a value freshly written through PUT
 *  /admin/settings/{key}. See that method's own doc comment. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const PUBLIC_URL_SCHEMA = z.string().refine((value) => value === "" || isAbsoluteHttpUrl(value), {
  message: "Must be empty, or an absolute http:// or https:// address (e.g. https://loombre.example.com).",
});

/** Optional mail transport run, M10: `mail.fromAddress` — empty (mail
 *  turned off) or a syntactically valid email address. `z.email()` (zod v4)
 *  is deliberately permissive about deliverability (this is a display
 *  field, not an SMTP handshake) — the worker's real send attempt is the
 *  only genuine test of whether the address works. */
export const OPTIONAL_EMAIL_SCHEMA = z.union([z.literal(""), z.email()]);

/** STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
 *  reachability proof + posture card" (RG9): `remote.subnet` — an IPv4
 *  CIDR block, octets individually bounded to 0-255 (not merely `\d{1,3}`,
 *  which would accept e.g. "999.999.999.999/24") and a prefix length
 *  sanity-bounded to /8-/30 (below /8 is not a sane tunnel subnet size;
 *  above /30 leaves no room for the server plus at least one device). */
function isValidIpv4Cidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return false;
  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet > 255)) return false;
  const prefixLength = Number.parseInt(match[5]!, 10);
  return prefixLength >= 8 && prefixLength <= 30;
}

export const REMOTE_SUBNET_SCHEMA = z.string().refine(isValidIpv4Cidr, {
  message: "Must be an IPv4 CIDR block (e.g. 10.82.146.0/24), prefix length between /8 and /30.",
});

/** STATE.md "Loombre Remote..." (RG12): `tls.acmeDomains` — a standard DNS
 *  hostname shape (dot-separated labels, letters/digits/hyphens, no
 *  leading/trailing hyphen per label). Deliberately permissive about
 *  length/TLD validity beyond that — the real, load-bearing check is the
 *  ACME server's own issuance attempt (the Direct path's staged test),
 *  not this schema; this only rejects obvious garbage (spaces, no dot,
 *  empty labels) before a value is ever stored. */
function isValidAcmeDomain(value: string): boolean {
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(value)) return false;
  // ICANN never delegates an all-numeric TLD, so a value whose final label
  // is all digits is an IPv4 address (or similar), not a real domain —
  // rejected here rather than with a separate IP-literal parser.
  const labels = value.split(".");
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

export const ACME_DOMAIN_SCHEMA = z.string().refine(isValidAcmeDomain, {
  message: "Must be a domain name (e.g. media.example.com) — not an IP address, and not missing a dot.",
});

export const ACME_DOMAINS_SCHEMA = z.array(ACME_DOMAIN_SCHEMA);

const ENV_ONLY_ENTRIES: SettingsRegistryEntry[] = [
  defineSetting({
    key: "database.url",
    schema: z.string().min(1),
    // Illustrative only — the docker-compose dev harness's connection
    // string (docker-compose.dev.yml maps host port 5442), NOT what an
    // unset value does in the shipped product: unset selects EMBEDDED
    // PostgreSQL provisioning (apps/server/src/bootstrap/provisioning.ts;
    // packages/provisioning-pg's EMBEDDED_PG_DEFAULT_PORT, 5433).
    // platformDerivedDefault keeps this dev-harness literal out of the
    // generated operator docs (F24-1) — the description below states the
    // real unset behavior.
    default: "postgres://loombre:loombre@localhost:5442/loombre",
    platformDerivedDefault: true,
    category: "database",
    description: "Where Loombre's database lives. Leave it unset and Loombre provisions and manages its own embedded PostgreSQL automatically; set it and Loombre connects to that external PostgreSQL instead — the two modes are selected purely by whether this variable is set. The server can't start without resolving this first — every other setting stored in the database depends on it.",
    technicalDetails: "PostgreSQL connection string. Read before any DB-backed configuration — including this registry's own database-stored half — can be resolved at all. When unset, the bundled embedded PostgreSQL is provisioned under the data directory and listens on loopback port 5433; see the Operator Guide's External PostgreSQL page for the external mode.",
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
    description: "Which network port Loombre listens on for plain (non-HTTPS) connections. Not used once HTTPS is turned on (the TLS settings) — that mode listens on its own port instead.",
    technicalDetails: "TCP port the plain-HTTP listener binds (apps/server/src/main.ts). Ignored whenever tls.mode is not 'off' — TLS mode binds its own HTTPS port.",
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
    // rather than an invented one). platformDerivedDefault keeps this
    // illustrative value out of the generated operator docs (AUD-A6b-002).
    default: "./data",
    platformDerivedDefault: true,
    category: "paths",
    description: "Where Loombre stores its data: your media cache, secrets, generated poster/thumbnail images, and TLS certificates. Leave unset and Loombre picks a sensible location based on your operating system.",
    technicalDetails: "Platform default when unset: XDG_DATA_HOME/loombre (Linux), ~/Library/Application Support/Loombre (macOS), %LOCALAPPDATA%/Loombre (Windows) — see apps/server/src/cli/app-paths.ts.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_DATA_DIR",
  }),
  defineSetting({
    key: "paths.configDir",
    schema: z.string().min(1),
    // Illustrative only — same platform-derived reality as paths.dataDir
    // above (resolveAppPaths' XDG/%APPDATA%/Application Support resolution).
    default: "./config",
    platformDerivedDefault: true,
    category: "paths",
    description: "Where Loombre stores its configuration files. Leave unset and Loombre picks a sensible location based on your operating system.",
    technicalDetails: "Platform default when unset: XDG_CONFIG_HOME/loombre (Linux), Application Support/Loombre/config (macOS), %APPDATA%/Loombre (Windows) — see apps/server/src/cli/app-paths.ts.",
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
    description: "The folder Loombre uses to hold video temporarily while it's being converted. Needs enough free space for whatever is converting right now — Loombre cleans these files up automatically once it's done.",
    technicalDetails: "Root directory transcode session staging directories are created under (docs/PLAYBACK.md §9 binding constraint 3). Default: <os.tmpdir()>/loombre-transcode.",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_TRANSCODE_DIR",
  }),
  defineSetting({
    key: "ffmpeg.path",
    schema: z.string(),
    default: "",
    category: "ffmpeg",
    description: "Where to find the ffmpeg program Loombre uses to convert video. Leave blank and Loombre looks for it automatically, the same way your system finds any other installed program.",
    technicalDetails: "Explicit ffmpeg binary path. Empty means resolve via PATH (apps/worker/src/probe/ffprobe.ts's resolveBinary).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_FFMPEG",
  }),
  defineSetting({
    key: "ffprobe.path",
    schema: z.string(),
    default: "",
    category: "ffmpeg",
    description: "Where to find the ffprobe program Loombre uses to inspect video and audio files before converting them. Leave blank and Loombre looks for it automatically, the same way your system finds any other installed program.",
    technicalDetails: "Explicit ffprobe binary path. Empty means resolve via PATH (apps/worker/src/probe/ffprobe.ts's resolveBinary).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_FFPROBE",
  }),
  defineSetting({
    key: "network.corsOrigins",
    schema: z.array(z.string()),
    default: ["http://localhost:3000", "http://127.0.0.1:3000"],
    category: "network",
    description: "Which web addresses are allowed to load Loombre's web app in a browser and talk to this server — set this to the address(es) you use to reach Loombre. An empty list turns this check off entirely, for setups where the web app and server share the same address.",
    technicalDetails: "Strict CORS origin allowlist for the browser web client. An explicitly empty list disables CORS entirely (same-origin deployments). Unset falls back to the local dev pairing (apps/server/src/main.ts's resolveCorsOrigins).",
    requiresRestart: true,
    scope: "env-only",
    envVar: "LOOMBRE_CORS_ORIGINS",
    parseEnv: parseEnvCommaList,
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
    default: 2,
    tierDefaults: { 0: 2, 1: 2, 2: 4 },
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
    technicalDetails:
      "Preference half only. The capability half is resolved per request in apps/server (resolve-policy.ts): HEVC is used when a HARDWARE encoder verifies hevc, or — on tier 1/2 only — when the box has no hardware encode route at all and the software encoder verifies hevc. A tier-0 box never software-encodes HEVC (libx265 is 2–4× slower than libx264), and a box with an h264-only hardware encoder keeps its hardware H.264 route (SPF-10). AV1 preference is separate (transcode.av1EncodePreferred).",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.allowToneMapCpu",
    schema: z.enum(["always", "never", "tier-gated"]),
    default: "tier-gated",
    category: "transcode",
    description: "Advanced: whether Loombre may convert high-dynamic-range (HDR) video to standard range using the processor when the video hardware can't do it directly. Processor conversion is slower and uses more of the server's resources. 'tier-gated' (the default) allows it only on more capable servers, 'always' allows it everywhere, 'never' turns it off entirely.",
    technicalDetails:
      "CPU tone-mapping via zscale. 'tier-gated' = allowed on Tier 1/2 hardware, refused on Tier 0 for sources >= 1080p; a refused HDR conversion surfaces as media-unplayable rather than a washed-out picture.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.av1EncodePreferred",
    schema: z.boolean(),
    // Opt-in. AV1 encoding is dramatically more expensive than H.264/HEVC,
    // and on a small server without a real AV1 encode engine it is not a
    // slower option — it is an unwatchable one, so the default must be off
    // and the escape hatch must be hardware rather than a checkbox.
    default: false,
    category: "transcode",
    description:
      "When converting, prefer AV1 — the newest and most efficient video format, giving similar quality at a noticeably lower bitrate. Loombre only uses it when your server has AV1 encoding hardware, or on more capable servers where converting it in software is realistic; otherwise it quietly converts to HEVC or H.264 instead. Not every device can play AV1, and Loombre checks that too.",
    caution:
      "Converting to AV1 in software is very demanding. On a small or low-power server Loombre will decline to do it and fall back automatically, so turning this on there simply has no effect.",
    technicalDetails:
      "Passed to the playback engine as a preference only — never pre-resolved against hardware. A rung becomes AV1 when this is on AND the client declares AV1 decode support AND it can take fMP4 segments (AV1 has no MPEG-TS stream type) AND the capability snapshot verifies an AV1 encoder: any non-software backend qualifies at every tier, while the software encoder (libsvtav1) qualifies only on Tier 1 and above. AV1 rungs take 60% of the equivalent H.264 bitrate and never replace a 2160p rung. Rungs that cannot be delivered as AV1 are converted to HEVC/H.264 at their configured bitrate rather than dropped, and each one reports why.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.ladderRungs",
    schema: z.array(LADDER_RUNG_SCHEMA).min(1),
    default: DEFAULT_LADDER_RUNGS,
    category: "transcode",
    description: "The set of quality levels Loombre can switch between while converting, best first. Loombre picks the highest one your connection can keep up with.",
    technicalDetails:
      "JSON array, best rung first. Each rung: { heightPx: positive integer, videoBitrateBps and audioBitrateBps: integers between 100,000 (100 kbps) and 100,000,000 (100 Mbps), codec: 'h264', 'hevc' or 'av1' }. At least one rung is required. An 'av1' rung is an explicit request for that quality point and is honoured wherever the client and the server's verified encoders allow it — including at 2160p, which the automatic AV1 preference never touches; where they do not, the rung is converted to HEVC/H.264 at the bitrate you set rather than dropped.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.segmentAheadSuspendThreshold",
    schema: z.number().int().min(1),
    default: 30,
    category: "transcode",
    description: "Advanced: how far ahead of what's currently playing Loombre is allowed to convert before it pauses conversion to save resources, measured in 2-second chunks of video at a time. Applies for the rest of the current viewing session — a change takes effect the next time someone starts watching something that needs converting.",
    technicalDetails:
      "Measured in HLS segments ahead of the playhead, each segment 2 seconds of video (SPF-1). Coupled to transcode.segmentAheadResumeThreshold: the resume value must stay BELOW this one, or saving is rejected.",
    requiresRestart: false,
    scope: "ui",
  }),
  defineSetting({
    key: "transcode.segmentAheadResumeThreshold",
    schema: z.number().int().min(0),
    default: 15,
    category: "transcode",
    description: "Advanced: how far the paused conversion (see 'Segment ahead suspend threshold') has to catch back down to before Loombre resumes it, measured in 2-second chunks of video at a time. Applies the same way — the next time someone starts watching something that needs converting.",
    technicalDetails:
      "Measured in HLS segments ahead of the playhead, each segment 2 seconds of video (SPF-1). Must stay BELOW transcode.segmentAheadSuspendThreshold, or saving is rejected.",
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
    // platformDerivedDefault keeps the illustrative floor literal out of
    // the generated operator docs (F33-6/T04-3) — the description's own
    // half-your-cores sentence is the true default statement.
    default: 2,
    platformDerivedDefault: true,
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
    description: "How long a file can be missing before Loombre removes it from your library, in hours (the default 72 = three days). The delay protects your watch history when a network drive drops out briefly.",
    technicalDetails:
      "Hours. Evaluated during scans: a media_files row past the grace window since it was first marked missing is deleted on the next scan of its library.",
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
    description: "Image quality for the smaller AVIF copies of posters and thumbnails, from 1 to 100 — used when 'Create AVIF copies' (images.avifEnabled) is turned on and this server can create them. Already-created images are untouched — this only affects new images and ones a future scan re-creates.",
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
    description: "The minimum age required to view restricted content. You can raise this number, but Loombre never allows it below 18 — that floor is enforced no matter what you set here.",
    technicalDetails: "The >=18 floor is enforced in more than one place server-side (schema validation and the settings-update path, not just this one field), so it can't be bypassed by a single validation gap.",
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
    description: "How long restricted content stays unlocked after someone enters their PIN, before it locks itself again. Enter the time in milliseconds (60000 = one minute; the default 1800000 = 30 minutes).",
    technicalDetails: "Milliseconds. Bounded 60,000 (1 min) to 86,400,000 (24 h).",
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
    description: "How long Loombre waits after a device stops responding before treating that person's playback as finished and freeing up the resources. Enter the time in milliseconds (60000 = one minute; the default 900000 = 15 minutes).",
    technicalDetails:
      "Milliseconds, bounded 60,000 to 86,400,000. Coupled to sessions.heartbeatSuspendCutoffMs: this value must stay ABOVE it (a session must suspend before it can be considered stale), or saving is rejected.",
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
    description: "How long Loombre waits after a device goes quiet before pausing its conversion. Playback isn't ended — it resumes when the device comes back. Enter the time in milliseconds (the default 90000 = 90 seconds).",
    technicalDetails:
      "Milliseconds, bounded 30,000 to 3,600,000. Coupled to sessions.staleCutoffMs: this value must stay BELOW it, or saving is rejected.",
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
    description: "How many sign-in attempts may come from one network address per minute before Loombre starts turning them away. Guards against password guessing. Several devices sharing one connection (a household router) share this allowance.",
    technicalDetails:
      "Keyed per source IP, not per device — the per-account companion is rateLimit.loginByIdentifier.",
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
    description: "How many session-refresh requests may come from one network address per minute. Guards against flooding the server with requests for new sign-in tokens. Several devices sharing one connection share this allowance.",
    technicalDetails:
      "Keyed per source IP, not per device — the per-device companion is rateLimit.refreshByDevice.",
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
  // G4 (STATE.md "Current-password re-auth on self-changes"): per-USER,
  // same default as login's own 10/min (F1: "same bucket class as
  // login... a re-auth prompt must not become a password-guessing
  // oracle") — apps/server/src/common/current-password-rate-limiter.
  // service.ts's currentPassword KeyedRateLimiter, consulted by BOTH
  // PATCH /users/me (when the body carries password/email) and
  // PUT /users/me/restricted (always).
  defineSetting({
    key: "rateLimit.currentPassword",
    schema: z.number().int().min(1),
    default: 10,
    category: "rateLimit",
    description: "How many current-password re-authentication attempts one person may make per minute when changing their password, email, or restricted-content PIN. Guards against someone guessing the account password.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_CURRENT_PASSWORD",
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
  // "Optional mail transport + invitation & reset flows", E2/M12 (Lane A):
  // GET/POST /claim/{token} — unauthenticated, per-IP, same floor-of-1
  // posture as every other entry in this group.
  defineSetting({
    key: "rateLimit.claim",
    schema: z.number().int().min(1),
    default: 10,
    category: "rateLimit",
    description: "How many invite-claim attempts one device may make per minute, before any account exists for it. Guards the claim link against brute-force guessing.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_CLAIM",
    parseEnv: parseEnvPositiveInt,
  }),
  // Password recovery (E3b/M12, STATE.md "Optional mail transport +
  // invitation & reset flows"): shared by both new unauthenticated routes,
  // POST /auth/forgot-password and POST /auth/reset-password
  // (@RateLimit("passwordReset","ip") on both) — a low ceiling on purpose,
  // since both are attempted-account-recovery surfaces (email-bombing via
  // forgot-password, token-guessing via reset-password).
  defineSetting({
    key: "rateLimit.passwordReset",
    schema: z.number().int().min(1),
    default: 5,
    category: "rateLimit",
    description: "How many password-recovery requests (forgot-password or reset-password) one device may make per minute. Guards against email-bombing an account and against guessing a reset token.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_PASSWORD_RESET",
    parseEnv: parseEnvPositiveInt,
  }),
  // STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
  // reachability proof + posture card" (R6/RG6, Wave 0 freeze): GET
  // /probe/{token} — unauthenticated, per-IP, same floor-of-1 posture as
  // every other entry in this group, modeled directly on rateLimit.claim
  // (RG6: "the /invites/claim/{token} precedent"). A probe token is
  // single-use and 15-minute-lived (R6), so this is a low ceiling — the
  // legitimate case is one real phone-on-cellular request per mint.
  defineSetting({
    key: "rateLimit.probe",
    schema: z.number().int().min(1),
    default: 10,
    category: "rateLimit",
    description: "How many reachability-check attempts one device may make per minute while proving it can reach this server from outside your network (part of Remote Access setup). Guards that check against brute-force guessing.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_PROBE",
    parseEnv: parseEnvPositiveInt,
  }),
  // Fix Wave 3 (audit fafa47f, AUD-A7d-001): rateLimit.login/refresh above
  // are keyed per-IP only — a distributed attempt against ONE account (or
  // one device's refresh chain) from many source addresses was
  // unthrottled. These two are a SECOND, independent dimension on the
  // SAME two routes: per-SUBMITTED-identifier for login (mirrors
  // rateLimit.unlock's per-user precedent, but keyed on the unverified
  // value the caller submitted rather than a resolved user id — an
  // unknown identifier must cost the same budget as a real one) and
  // per-SUBMITTED-deviceId for refresh (refresh tokens are opaque 256-bit
  // values, not brute-forceable regardless of rate — this closes the
  // per-IP-only gap for a distributed attempt against one known device's
  // refresh chain instead). See apps/server/src/session/
  // auth-rate-limiter.service.ts for the KeyedRateLimiter wiring.
  defineSetting({
    key: "rateLimit.loginByIdentifier",
    schema: z.number().int().min(1),
    default: 20,
    category: "rateLimit",
    description: "How many sign-in attempts one ACCOUNT may receive per minute, combined across every source address — separate from the per-device limit above. Guards against a distributed attempt to guess one person's password.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_LOGIN_BY_IDENTIFIER",
    parseEnv: parseEnvPositiveInt,
  }),
  defineSetting({
    key: "rateLimit.refreshByDevice",
    schema: z.number().int().min(1),
    default: 40,
    category: "rateLimit",
    description: "How many session-refresh requests one signed-in device may receive per minute, combined across every source address — separate from the per-device limit above. Guards against a distributed attempt to overwhelm one device's session renewal.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_REFRESH_BY_DEVICE",
    parseEnv: parseEnvPositiveInt,
  }),
  // Fix Wave 3 (audit fafa47f, AUD-A7d-002): GET /search and
  // GET /restricted/search carried NO limiter at all despite an N+1
  // detail fetch per row — closes the gap using the SurfaceRateLimiterService
  // idiom (identity-keyed, one shared bucket across both routes, mirroring
  // rateLimit.mediaToken's four-route-family sharing). Generous ceiling on
  // purpose: normal typeahead-style search fires bursts on ordinary use.
  defineSetting({
    key: "rateLimit.search",
    schema: z.number().int().min(1),
    default: 60,
    category: "rateLimit",
    description: "How many search requests one person may make per minute — this covers both regular search and restricted-content search. Each search does some extra work behind the scenes, so this keeps that from being abused while staying generous enough for normal typing.",
    technicalDetails: "Shared by GET /search and GET /restricted/search, one bucket across both routes (the same sharing pattern rateLimit.mediaToken uses for its own route family). The generous ceiling exists because each request does an extra per-result detail lookup, so ordinary typeahead-style bursts must not trip it.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_RATE_SEARCH",
    parseEnv: parseEnvPositiveInt,
  }),

  // ---- stash (STATE.md "Stash SQLite metadata sync", S8, trigger (b)) ----
  // Deliverable 7(b)'s schedule trigger: no cron machinery exists anywhere
  // in this repo (K-notes "ground truth worth repeating"), and extending
  // packages/jobs' shared JobQueue abstraction (every job type's foundation)
  // for a single feature's `.schedule()` need is a bigger blast radius than
  // this lane's scope justifies. Instead, apps/worker/src/stash/
  // schedule-loop.ts runs its OWN setInterval poll loop — the exact "own
  // interval, own handle, own clean shutdown" shape
  // apps/worker/src/plugin-delivery/delivery-loop.ts's LPP v1 outbox-fanout
  // loop already established (see that module's header) — and re-reads
  // this key fresh on every tick via loadWorkerEffectiveSettings (the SAME
  // per-tick-boundary re-resolution convention scan/probe/transcode all
  // use, per this file's own header). 0 (the default) means OFF: no
  // schedule-triggered sync fires until an admin sets a positive interval —
  // trigger (a) (the admin button, Lane D) and (c) (chokidar Stash-DB mtime
  // watch, this lane's watcher.ts) both keep working regardless of this
  // setting's value.
  defineSetting({
    key: "stash.sync.scheduleIntervalMs",
    // Floor is 0 (off); ceiling is 30 days — far past any sane periodic
    // resync cadence, just a sanity bound (mirrors scanner.concurrency's
    // F9 "unbounded above meant an absurd value was schema-legal" fix).
    schema: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
    default: 0,
    category: "stash",
    description: "How often Loombre automatically re-syncs metadata from a connected Stash database. Enter the interval in milliseconds — 0 (the default) turns automatic scheduling off; Stash still syncs whenever you click the sync button or its database file changes on disk.",
    technicalDetails: "Value is in milliseconds; ceiling is 30 days (a sanity bound, not a recommended cadence).",
    requiresRestart: false,
    scope: "ui",
  }),

  // ---- network (optional mail transport run, M9: the one sanctioned
  // source for every security-sensitive link a piece of outgoing mail can
  // ever contain) ----
  defineSetting({
    key: "network.publicUrl",
    schema: PUBLIC_URL_SCHEMA,
    default: "",
    category: "network",
    description: "The web address people use to reach this server from outside your own network (for example, https://myserver.example.com). Any link Loombre sends by email — invitations, password resets — is built only from this address, so it's never guessed from wherever a request happened to come from. Leave this blank and Loombre will not send mail that contains a link.",
    technicalDetails: "Must be empty, or an absolute http:// or https:// URL. This is the sole source for every security-sensitive link a piece of outgoing mail can ever contain — never derived from an incoming request's Host header.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_PUBLIC_URL",
  }),

  // ---- mail (optional mail transport run, E5/M10): a generic SMTP
  // transport — provider-agnostic by design, no provider-specific fields.
  // Credentials are NOT here: a username/password live in the keyring
  // (mail-smtp-credentials, A9 pattern), never in server_settings —
  // unauthenticated SMTP (a private-network relay) is a fully legal
  // configuration with every key below set and no credentials at all.
  defineSetting({
    key: "mail.smtpHost",
    schema: z.string(),
    default: "",
    category: "mail",
    description: "The address of the outgoing mail server Loombre sends email through. Leave blank to leave mail sending turned off.",
    technicalDetails: "Your SMTP provider's hostname (e.g. smtp.mailprovider.com) — check your provider's setup page for the exact value. No username or password lives here: SMTP credentials, if the server requires them, are stored separately and encrypted; an unauthenticated relay on a private network is also a legal configuration with this field set and no credentials at all.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SMTP_HOST",
  }),
  defineSetting({
    key: "mail.smtpPort",
    schema: z.number().int().min(1).max(65535),
    default: 587,
    category: "mail",
    description: "Which door on your mail provider's server Loombre connects to when sending email. Your provider's setup page lists it; 587 is the most common.",
    technicalDetails: "SMTP submission port. 587 = STARTTLS submission (recommended), 465 = implicit TLS, 25 = server-to-server relay, usually blocked for clients from outside their own network.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SMTP_PORT",
    parseEnv: (raw) => Number.parseInt(raw.trim(), 10),
  }),
  defineSetting({
    key: "mail.smtpSecurity",
    schema: z.enum(["starttls", "implicit-tls", "none"]),
    default: "starttls",
    category: "mail",
    description: "How the connection to your mail server is protected. 'starttls' connects in the open and switches to an encrypted connection partway through (the most common choice); 'implicit-tls' is encrypted from the very first byte; 'none' is a plain, unencrypted connection with no protection at all.",
    technicalDetails: "'starttls' pairs with port 587 (STARTTLS submission); 'implicit-tls' pairs with port 465 (TLS from connection open) — see mail.smtpPort's own technical notes.",
    caution: "Choosing 'none' sends your mail server password and every email in plain, readable text over the network — only use this for a private network relay you control, never for a mail server reached over the internet.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SMTP_SECURITY",
    parseEnv: (raw) => raw.trim().toLowerCase(),
  }),
  defineSetting({
    key: "mail.fromAddress",
    schema: OPTIONAL_EMAIL_SCHEMA,
    default: "",
    category: "mail",
    description: "The email address your outgoing mail appears to come from. Leave blank to leave mail sending turned off.",
    technicalDetails: "Must be empty or a syntactically valid email address — Loombre does not verify deliverability at save time; your first real send attempt is the only genuine test of whether the address actually works.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SMTP_FROM_ADDRESS",
  }),
  defineSetting({
    key: "mail.fromName",
    schema: z.string(),
    default: "Loombre",
    category: "mail",
    description: "The display name shown alongside the from-address on outgoing mail.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_SMTP_FROM_NAME",
  }),

  // ---- remote (STATE.md "Loombre Remote — embedded WireGuard + three-path
  // wizard + reachability proof + posture card", R1/RG5/RG9, Wave 0
  // freeze): NO `remote.activePath` key here — RG15's refinement of RG5's
  // original wording holds: the active path is DERIVED from the three
  // subsystems' own enabled state (at most one enabled, enforced 409 by
  // each path's staged enable flow), never stored, so it cannot drift from
  // reality (GET /admin/remote/state, RemotePathId in openapi.yaml).
  //
  // requiresRestart, decided honestly per key rather than defaulted:
  // wireguardPort/subnet are true because the in-process userspace
  // listener (RG1/RG2) binds ONE UDP port for its whole lifetime and every
  // enrolled peer's tunnel IP is allocated from the configured subnet at
  // enrollment time — changing either while the listener is live would
  // either fail to rebind or orphan already-enrolled peers rather than
  // hot-apply cleanly (A5's "no setting change may drop active playback
  // sessions" law's own spirit: a WireGuard peer mid-handshake is exactly
  // this kind of active session). wireguardEndpointHost/cloudflaredPath/
  // tunnelHostname are false — none of them affect anything already
  // running; they only shape what a FUTURE action reads (a new
  // enrollment's generated config, the next connector spawn, the next
  // tunnel-enable call), the same "applies on next use, not immediately
  // to a live process" posture other hot-reload entries already have.
  defineSetting({
    key: "remote.wireguardPort",
    schema: z.number().int().min(1).max(65535),
    default: 51820,
    category: "remote",
    description: "Which network port Loombre Remote uses for its secure tunnel connections. A change only takes effect after a server restart (the port cannot be switched while the server is running), and the restart disconnects remote devices until they reconnect.",
    technicalDetails: "UDP port the in-process WireGuard listener binds to for its whole lifetime. Cannot be rebound to a different port while the server is running, hence the restart requirement.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_WG_PORT",
    parseEnv: (raw) => Number.parseInt(raw.trim(), 10),
  }),
  defineSetting({
    key: "remote.subnet",
    // RG9: default 10.82.146.0/24 (RFC1918, deliberately NOT 100.64/10 —
    // Tailscale squats CGNAT space and a phone running both would
    // collide), registry-configurable. Server = .1, devices allocated
    // lowest-free from .2-.254 (a /24's usable range) — the /8-/30 bound
    // below is a sanity ceiling/floor, not a recommendation to use
    // anything but a /24 in practice.
    schema: REMOTE_SUBNET_SCHEMA,
    default: "10.82.146.0/24",
    category: "remote",
    description: "The private range of addresses Loombre Remote assigns to your server and its enrolled devices for their secure tunnel connections — the server takes the first address, and each device gets the next free one. Changing this requires a server restart, and orphans any already-enrolled devices, since their addresses came from the old range.",
    technicalDetails: "An IPv4 CIDR block (e.g. 10.82.146.0/24), prefix length between /8 and /30. Server = the first usable address (.1 in a /24); devices are allocated the lowest-free address from the remaining usable range.",
    caution: "Avoid 100.64.0.0/10 (CGNAT space) — other VPN tools commonly use it, and a device running both could collide.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_WG_SUBNET",
  }),
  defineSetting({
    key: "remote.wireguardEndpointHost",
    schema: z.string(),
    default: "",
    category: "remote",
    description: "The public address (hostname or IP) devices should connect to in order to reach this server through Loombre Remote — written into each device's configuration when it's enrolled. Leave this blank until you know this server's public address.",
    technicalDetails: "Combined with the WireGuard port setting above to form each newly enrolled device's endpoint address; already-enrolled devices are not updated retroactively when this changes.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_WG_ENDPOINT_HOST",
  }),
  defineSetting({
    key: "remote.cloudflaredPath",
    schema: z.string(),
    default: "",
    category: "remote",
    description: "Where to find the cloudflared program, if Loombre can't locate it automatically. Loombre does not install this program itself — install it yourself, then point this setting at it if auto-detect fails. Leave blank to let Loombre look for it automatically.",
    technicalDetails: "Explicit path to the cloudflared binary, used when it is not resolvable via the server's PATH.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_CLOUDFLARED_PATH",
  }),
  defineSetting({
    key: "remote.tunnelHostname",
    schema: z.string(),
    default: "",
    category: "remote",
    description: "The public web address the Tunnel connection method routes through. Loombre sets this automatically when you turn on the Tunnel option in the setup wizard; you can edit it here afterward.",
    requiresRestart: false,
    scope: "ui",
    envVar: "LOOMBRE_TUNNEL_HOSTNAME",
  }),

  // ---- tls / Direct path (STATE.md "Loombre Remote — embedded WireGuard +
  // three-path wizard + reachability proof + posture card", RG12): the
  // MINIMUM key set promoted from env-only to ui-scope so the Direct
  // path's wizard (apps/server/src/remote/remote-direct.controller.ts) can
  // stage a real ACME test issuance and commit a validated result through
  // the ordinary settings machinery, rather than requiring an operator to
  // hand-edit environment variables to use a feature the admin UI walks
  // them through. Every env var name is UNCHANGED from before this
  // promotion (docs/ops/remote-access/acme.md, apps/server/src/tls/config.ts) — env
  // still wins whenever set (A8), and every one of these is
  // requiresRestart:true because apps/server/src/main.ts resolves TLS
  // mode once, at boot, before the settings service's own database read
  // is consulted — exactly the same "cannot hot-apply to a live process"
  // shape remote.wireguardPort/remote.subnet above already established.
  // tls.mode's cross-field requirements (acmeDomains non-empty,
  // acmeTosAgreed true, whenever mode is "acme") are enforced in
  // apps/server/src/settings/settings.service.ts's
  // assertCrossFieldInvariants — a single key's own zod schema cannot
  // express "valid only in combination with these other keys' values",
  // the same reasoning documented on the existing transcode/sessions pairs
  // there.
  defineSetting({
    key: "tls.mode",
    schema: z.enum(["off", "manual", "acme"]),
    default: "off",
    category: "tls",
    description: "How Loombre handles HTTPS: 'off' serves plain HTTP (the right choice when a reverse proxy in front of Loombre handles HTTPS itself), 'manual' uses a certificate and key file you provide yourself, and 'acme' has Loombre request and automatically renew its own certificate from Let's Encrypt (or another compatible certificate authority) using the domain and verification settings below.",
    technicalDetails: "ACME issuance uses the domain(s) in tls.acmeDomains, the challenge method in tls.acmeChallengeType, and requires tls.acmeTosAgreed to be true. Resolved once at server boot, not re-read from a live process — that's why a mode change needs a restart to take effect.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_TLS_MODE",
  }),
  defineSetting({
    key: "tls.acmeDomains",
    schema: ACME_DOMAINS_SCHEMA,
    default: [],
    category: "tls",
    description: "The domain name(s) this server requests an HTTPS certificate for when TLS mode is 'acme' — the address people use to reach it from outside your network (for example media.example.com). The first one becomes the certificate's primary name.",
    technicalDetails: "Must be real domain names, not IP addresses — a bare IP address or a value with no dot is rejected before it's ever saved. Real issuance validity is ultimately decided by the certificate authority's own request at the time TLS mode 'acme' takes effect.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_ACME_DOMAINS",
    // Mirrors apps/server/src/tls/config.ts's own LOOMBRE_ACME_DOMAINS
    // parsing exactly (lowercased, same as every domain match this value
    // ever gets compared against) — parseEnvCommaList alone doesn't lowercase.
    parseEnv: (raw) => parseEnvCommaList(raw).map((d) => d.toLowerCase()),
  }),
  defineSetting({
    key: "tls.acmeChallengeType",
    schema: z.enum(["http-01", "dns-01"]),
    default: "http-01",
    category: "tls",
    description: "How Loombre proves it controls the domain above, to get a certificate for it: 'http-01' answers a request on port 80 (simplest, when that port is reachable from the internet), 'dns-01' creates a temporary DNS record instead (works even with no reachable inbound port, and is required for a wildcard certificate).",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_ACME_CHALLENGE_TYPE",
    parseEnv: (raw) => raw.trim().toLowerCase(),
  }),
  defineSetting({
    key: "tls.acmeTosAgreed",
    schema: z.boolean(),
    default: false,
    category: "tls",
    description: "Confirms you accept the certificate authority's Terms of Service on this server's behalf — required before Loombre will request a certificate automatically. Loombre never agrees on your behalf silently; this must be turned on explicitly.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_ACME_TOS_AGREED",
    parseEnv: parseEnvBoolean,
  }),
  defineSetting({
    key: "network.trustProxy",
    schema: z.string(),
    default: "",
    category: "network",
    description: "Tells Loombre it's running behind a reverse proxy you control, so it can trust that proxy's information about which address a request really came from — used for rate-limiting and the sign-in log. Leave this blank unless you are running Loombre behind your own reverse proxy.",
    technicalDetails: "Accepts a hop count (e.g. \"1\"), a trusted IP address or CIDR range, or a comma-separated list of them.",
    caution: "Only enable behind a reverse proxy you control — enabling this trusts client-supplied forwarded-address information for rate-limit and sign-in-log keying.",
    requiresRestart: true,
    scope: "ui",
    envVar: "LOOMBRE_TRUST_PROXY",
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
