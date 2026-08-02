// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/lib/settings-titles.mjs
//
// Addendum A, lane D1 — shared presentation metadata for the two settings-
// registry-driven generators (gen-settings-reference.mjs for the Admin
// Guide, gen-env-reference.mjs for the Operator Guide). Kept as hand-
// curated maps rather than algorithmically humanized strings: a mechanical
// camelCase-to-words transform of `transcode.hevcEncodePreferred` produces
// "Hevc Encode Preferred", not the kind of plain, admin-facing phrase the
// Admin Guide's register requires. `entry.description` itself is still
// reused VERBATIM in the generators per the orchestrator's explicit
// instruction (UI and docs must render the identical string) — these maps
// only cover the SURROUNDING presentation (headings, grouping, anchors),
// never the description text.
//
// MAINTENANCE: packages/shared/src/settings-registry.ts is owned by lanes
// S1/S3, not this lane — this file has no compile-time link to it (plain
// data, no import), so a new registry key silently gets a mechanically
// humanized fallback title (humanizeKey below) instead of a build failure.
// Both generators print a note when that happens so a stale map is visible
// in build output, not silently wrong.
//
// Both generators use `slugify` for the SAME heading text, so an operator-
// guide cross-link to a specific admin-guide setting resolves to the exact
// anchor VitePress's default Markdown-it slugger would generate.

export const SETTING_TITLES = {
  "transcode.maxSimultaneousTranscodes": "Maximum simultaneous conversions",
  "transcode.hevcEncodePreferred": "Prefer efficient video format when converting",
  "transcode.allowToneMapCpu": "Allow software HDR color adjustment",
  "transcode.ladderRungs": "Quality levels used when converting",
  "transcode.segmentAheadSuspendThreshold": "Pause conversion when far ahead of playback",
  "transcode.segmentAheadResumeThreshold": "Resume conversion after pausing",
  "scanner.concurrency": "Library scan speed",
  "scanner.missingFileGraceHours": "Grace period for missing files",
  "images.avifEnabled": "Generate modern image format (AVIF)",
  "images.webpQuality": "Image quality (WebP)",
  "images.avifQuality": "Image quality (AVIF)",
  "restricted.enabled": "Enable restricted content",
  "restricted.majorityAgeYears": "Minimum age for restricted content",
  "restricted.defaultUnlockDurationMs": "How long restricted content stays unlocked",
  "sessions.staleCutoffMs": "End inactive playback sessions after",
  "sessions.heartbeatSuspendCutoffMs": "Pause conversion for inactive sessions after",
  "updateCheck.mode": "Check for updates",
  "security.loginAnomalyLogEnabled": "Log suspicious sign-in activity",
  "rateLimit.login": "Sign-in attempt limit",
  "rateLimit.refresh": "Session refresh limit",
  "rateLimit.unlock": "Restricted-content PIN attempt limit",
  "rateLimit.setup": "Setup wizard request limit",
  "rateLimit.capabilities": "Capability check request limit",
  "rateLimit.export": "Data export request limit",
  "rateLimit.mediaToken": "Media playback request limit",
  "stash.sync.scheduleIntervalMs": "Automatic Stash re-sync interval",
  "network.publicUrl": "Public web address",
  "mail.smtpHost": "Mail server address",
  "mail.smtpPort": "Mail server port",
  "mail.smtpSecurity": "Mail connection security",
  "mail.fromAddress": "From address",
  "mail.fromName": "From name",

  "database.url": "Database connection",
  "http.port": "HTTP port",
  "paths.dataDir": "Data directory",
  "paths.configDir": "Config directory",
  "paths.transcodeStagingDir": "Conversion staging directory",
  "ffmpeg.path": "ffmpeg binary path",
  "ffprobe.path": "ffprobe binary path",
  "network.trustProxy": "Trust proxy",
  "network.corsOrigins": "Allowed browser origins (CORS)",
  "tls.mode": "TLS mode",
};

/** Admin Guide category grouping — only categories that actually contain a
 *  scope:'ui' entry appear here; order is display order. */
export const ADMIN_CATEGORY_TITLES = {
  transcode: { title: "Video conversion & playback quality", blurb: "How Loombre converts video for playback, and how much of it happens at once." },
  scanner: { title: "Library scanning", blurb: "How Loombre watches and scans your library folders." },
  images: { title: "Image quality", blurb: "Quality and format settings for poster/thumbnail images Loombre generates." },
  restricted: { title: "Restricted content", blurb: "Server-wide restricted-content settings — see the User Guide's Restricted content page for what this looks like for someone using the account." },
  sessions: { title: "Playback sessions", blurb: "When an inactive playback session is treated as ended or paused." },
  updateCheck: { title: "Update checking", blurb: "Whether Loombre checks for newer versions. Never installs anything automatically." },
  security: { title: "Security & sign-in logging", blurb: "Local logging of suspicious sign-in activity." },
  rateLimit: { title: "Sign-in & request limits", blurb: "How many attempts or requests are allowed in a given time window, per person or device — protects against automated guessing without locking anyone out under normal use." },
  network: { title: "Network", blurb: "The web address people use to reach this server from outside your own network." },
  mail: { title: "Mail", blurb: "The outgoing mail server Loombre uses to send invitation and password-reset email. Entirely optional — every part of Loombre works without mail configured; see the Admin Guide's pages on inviting users and on users & permissions for the copy-link alternative." },
  stash: { title: "Stash sync", blurb: "Automatic scheduling for re-syncing metadata from a connected Stash database. See the Restricted content chapter for connecting Stash in the first place." },
};

export const ADMIN_CATEGORY_ORDER = ["transcode", "scanner", "images", "restricted", "sessions", "updateCheck", "security", "rateLimit", "network", "mail", "stash"];

/** Operator Guide category grouping — env-only entries only. */
export const ENV_CATEGORY_TITLES = {
  database: "Database",
  network: "Network",
  tls: "TLS",
  paths: "Paths",
  ffmpeg: "ffmpeg / ffprobe",
};

export const ENV_CATEGORY_ORDER = ["database", "network", "tls", "paths", "ffmpeg"];

/** Fallback for any registry key not yet in SETTING_TITLES above (new keys
 *  land in packages/shared/src/settings-registry.ts, owned by other
 *  lanes) — mechanical, not pretty, but never silently drops a setting. */
export function humanizeKey(key) {
  const last = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function titleFor(key) {
  return SETTING_TITLES[key] ?? humanizeKey(key);
}

/** Matches VitePress's default Markdown-it heading slugger closely enough
 *  for cross-link anchors between the two generated pages (lowercase,
 *  strip non-alphanumerics to hyphens, collapse/trim hyphens). */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
