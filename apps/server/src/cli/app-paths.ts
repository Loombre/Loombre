// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/app-paths.ts
//
// Platform-correct app-data path resolution (docs/PLAN.md §11: "app-data in
// platform-correct locations (XDG / %ProgramData% / ~/Library/Application
// Support)") for the `loombre paths`/`loombre doctor` CLI commands. Pure
// function of (platform, env) — no filesystem access here, so it's cheap to
// unit test exhaustively; callers that need to know whether a path is
// actually writable do that separately (doctor.ts).
//
// This is a CLI-display concern only, not the seam packages/provisioning's
// embedded-PG lane or the installer lanes are contractually bound to (no
// FROZEN interface names this) — if a later wave formalizes a shared
// app-data resolver, this can delegate to it without changing the CLI's
// observable output for the common (no env override) case, since the
// platform defaults below already follow docs/PLAN.md §11 verbatim.
//
// Env overrides (LOOMBRE_DATA_DIR / LOOMBRE_CONFIG_DIR) always win — this is
// what lets a Docker image or a dev checkout point both at a bind-mounted
// directory without touching the OS-default resolution logic at all.

export type SupportedPlatform = "linux" | "macos" | "windows";

export function toSupportedPlatform(nodePlatform: NodeJS.Platform): SupportedPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}

export interface AppPathsEnv {
  LOOMBRE_DATA_DIR?: string | undefined;
  LOOMBRE_CONFIG_DIR?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  APPDATA?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  HOME?: string | undefined;
  USERPROFILE?: string | undefined;
}

export interface ResolvedAppPaths {
  dataDir: string;
  configDir: string;
  /** "env" when an explicit LOOMBRE_*_DIR override was honored, "default" for the platform-derived path. */
  dataDirSource: "env" | "default";
  configDirSource: "env" | "default";
}

function homeDir(env: AppPathsEnv, platform: SupportedPlatform): string {
  if (platform === "windows") return env.USERPROFILE ?? env.HOME ?? "C:\\Users\\Default";
  return env.HOME ?? "/root";
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function win32Join(...parts: string[]): string {
  return parts.join("\\").replace(/\\+/g, "\\");
}

function defaultDataDir(env: AppPathsEnv, platform: SupportedPlatform): string {
  if (platform === "linux") {
    return posixJoin(env.XDG_DATA_HOME ?? posixJoin(homeDir(env, platform), ".local", "share"), "loombre");
  }
  if (platform === "macos") {
    return posixJoin(homeDir(env, platform), "Library", "Application Support", "Loombre");
  }
  // windows: local (non-roaming) app data — the correct home for a data
  // directory that shouldn't sync via roaming profiles (large media DB/logs).
  const base = env.LOCALAPPDATA ?? win32Join(homeDir(env, platform), "AppData", "Local");
  return win32Join(base, "Loombre");
}

function defaultConfigDir(env: AppPathsEnv, platform: SupportedPlatform): string {
  if (platform === "linux") {
    return posixJoin(env.XDG_CONFIG_HOME ?? posixJoin(homeDir(env, platform), ".config"), "loombre");
  }
  if (platform === "macos") {
    // macOS has no separate XDG-style config dir convention; Application
    // Support is the correct home for both (a "config" subfolder keeps the
    // on-disk layout self-describing rather than mixing config files loose
    // among data files).
    return posixJoin(homeDir(env, platform), "Library", "Application Support", "Loombre", "config");
  }
  // windows: roaming app data is the conventional home for small config
  // (Explorer/other apps expect settings here, not in %LOCALAPPDATA%).
  const base = env.APPDATA ?? win32Join(homeDir(env, platform), "AppData", "Roaming");
  return win32Join(base, "Loombre");
}

/** Resolves both directories for the given platform + environment. Pure —
 *  callers pass `process.platform`/`process.env` explicitly (never reads
 *  them itself) so tests can exercise every platform branch from one OS. */
export function resolveAppPaths(nodePlatform: NodeJS.Platform, env: AppPathsEnv): ResolvedAppPaths {
  const platform = toSupportedPlatform(nodePlatform);

  const dataOverride = env.LOOMBRE_DATA_DIR?.trim();
  const configOverride = env.LOOMBRE_CONFIG_DIR?.trim();

  return {
    dataDir: dataOverride && dataOverride.length > 0 ? dataOverride : defaultDataDir(env, platform),
    dataDirSource: dataOverride && dataOverride.length > 0 ? "env" : "default",
    configDir: configOverride && configOverride.length > 0 ? configOverride : defaultConfigDir(env, platform),
    configDirSource: configOverride && configOverride.length > 0 ? "env" : "default",
  };
}
