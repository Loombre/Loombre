// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/resolve-cloudflared-binary.ts
//
// STATE.md RG7 (T2): binary resolution for the supervised cloudflared
// connector — remote.cloudflaredPath (packages/shared/src/settings-registry.ts,
// read via SettingsService.getEffective, env LOOMBRE_CLOUDFLARED_PATH wins
// per the registry's own env>db>default precedence) if set, ELSE a PATH
// scan for 'cloudflared' — NEVER an auto-download (RG7's own wording: "a
// binary fetch is supply-chain surface; wizard instructs per-platform
// install").
//
// Deliberately a LOCAL, small reimplementation of apps/worker/src/probe/
// ffprobe.ts's resolveBinary shape rather than a cross-app import — apps/
// server never imports apps/worker code anywhere in this codebase
// (separate deployable apps; ffprobe.ts's own resolveBinary/findOnPath are
// not exported for reuse either), so duplicating this ~30-line helper
// locally is the existing house pattern, not a new one.
//
// Pure + synchronous (no I/O beyond accessSync's stat call) — never
// throws; absence is a typed result, same posture as ffprobe.ts's own
// ResolveBinaryResult.

import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

export interface ResolvedCloudflaredBinary {
  path: string;
  source: "setting" | "path";
}

export type ResolveCloudflaredBinaryResult =
  | { ok: true; binary: ResolvedCloudflaredBinary }
  | { ok: false; detail: string };

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH for an executable named `name` (PATHEXT-aware on Windows) —
 *  byte-for-byte the same shape as ffprobe.ts's own findOnPath. */
function findOnPath(name: string): string | null {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const extensions =
    process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** `configuredPath` is the CALLER's already-resolved effective value of
 *  remote.cloudflaredPath (SettingsService.getEffective) — this module has
 *  no SettingsService dependency of its own, keeping it pure and directly
 *  unit-testable. */
export function resolveCloudflaredBinary(configuredPath: string): ResolveCloudflaredBinaryResult {
  const trimmed = configuredPath.trim();
  if (trimmed.length > 0) {
    if (isExecutableFile(trimmed)) {
      return { ok: true, binary: { path: trimmed, source: "setting" } };
    }
    return {
      ok: false,
      detail: `remote.cloudflaredPath is set to '${trimmed}' but that path is not an executable file`,
    };
  }

  const found = findOnPath("cloudflared");
  if (found) {
    return { ok: true, binary: { path: found, source: "path" } };
  }
  return {
    ok: false,
    detail: "'cloudflared' was not found on PATH and remote.cloudflaredPath is not set — install cloudflared or set remote.cloudflaredPath",
  };
}
