// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/crash/data-dir.ts
//
// Platform-correct app-data DIRECTORY resolution — worker-local twin of
// apps/server/src/cli/app-paths.ts's resolveAppPaths (docs/PLAN.md §11:
// "app-data in platform-correct locations"). apps/worker cannot import
// from apps/server (separate deployable app — see apps/server/src/
// bootstrap/provisioning.ts's own header on this exact boundary, and D2's
// module-boundary spirit), and this wave's packages/shared edit is scoped
// to crashDirPath ONLY (this module's own header explains why), so this is
// a deliberate, small duplication rather than a new shared dependency.
//
// Scope is narrower than the server's version on purpose: this worker only
// ever needs ONE directory (where to write crash files — LOOMBRE_DATA_DIR),
// never a separate config dir, so this file resolves exactly that.

export type SupportedPlatform = "linux" | "macos" | "windows";

function toSupportedPlatform(nodePlatform: NodeJS.Platform): SupportedPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}

export interface DataDirEnv {
  LOOMBRE_DATA_DIR?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  APPDATA?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  HOME?: string | undefined;
  USERPROFILE?: string | undefined;
}

function homeDir(env: DataDirEnv, platform: SupportedPlatform): string {
  if (platform === "windows") return env.USERPROFILE ?? env.HOME ?? "C:\\Users\\Default";
  return env.HOME ?? "/root";
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function win32Join(...parts: string[]): string {
  return parts.join("\\").replace(/\\+/g, "\\");
}

function defaultDataDir(env: DataDirEnv, platform: SupportedPlatform): string {
  if (platform === "linux") {
    return posixJoin(env.XDG_DATA_HOME ?? posixJoin(homeDir(env, platform), ".local", "share"), "loombre");
  }
  if (platform === "macos") {
    return posixJoin(homeDir(env, platform), "Library", "Application Support", "Loombre");
  }
  const base = env.LOCALAPPDATA ?? win32Join(homeDir(env, platform), "AppData", "Local");
  return win32Join(base, "Loombre");
}

/** Resolves the worker's app-data directory. Pure — callers pass
 *  `process.platform`/`process.env` explicitly, never read implicitly. */
export function resolveWorkerDataDir(nodePlatform: NodeJS.Platform, env: DataDirEnv): string {
  const platform = toSupportedPlatform(nodePlatform);
  const override = env.LOOMBRE_DATA_DIR?.trim();
  return override && override.length > 0 ? override : defaultDataDir(env, platform);
}
