// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/discovery-files.ts
//
// Writes/removes the two well-known files packages/controller-ipc/src/
// transport.ts defines (IPC_DISCOVERY_FILENAME + IPC_TOKEN_FILENAME) under
// the resolved app-data dir — see that file's own header: "under the
// platform app-data dir ... resolving that base path is the CALLER's
// concern, same as @loombre/provisioning's dataDir". This lane resolves
// that base path exactly the way apps/server/src/bootstrap/provisioning.ts
// already does: apps/server/src/cli/app-paths.ts's resolveAppPaths(), the
// SAME dataDir bootstrapProvisioning() uses for the embedded-PG data
// directory — one seam, not two competing ones.
//
// LOCATION NOTE / KNOWN CROSS-CLIENT DISCREPANCY (flag for orchestrator +
// I3/I4, see this lane's report): the two already-built Wave 1 controller
// clients disagree on where under the app-data dir these files live.
//   - installers/windows/tray/Loombre.Tray.Ipc/Discovery.cs reads them
//     directly from the app-data root (no subdirectory) — matching
//     transport.ts's own literal wording ("under the platform app-data
//     dir"), which is what this file implements.
//   - installers/macos/menubar/Sources/LoombreIPCKit/AppPaths.swift instead
//     expects an "ipc/" SUBdirectory (appSupportDir + "/ipc") —
//     installers/macos/LAYOUT.md §2 documents this as a "RESERVED,
//     created empty by postinstall, not yet written to by anything" plan
//     that predates this lane's implementation.
// This file follows the FROZEN transport.ts spec + the Windows client's
// already-shipped behavior literally (root of the app-data dir, no
// subdirectory) since transport.ts's own words are the closer-to-authoritative
// source and editing installers/** is out of this lane's ownership. The
// macOS menubar's AppPaths.swift needs a follow-up fix (drop the "/ipc"
// path segment) — a three-line change, called out explicitly in this
// lane's report, not made here.
//
// STALE-FILE RECOVERY: on every boot, BEFORE writing new files, checks
// whether a discovery file already exists from a previous (crashed, or
// simply not cleanly shut down) boot and, if so, whether its `pid` still
// names a live process. Either way this is diagnostic-only — the new files
// are always written, overwriting whatever was there — but a live-looking
// stale pid is logged loudly since it usually means either (a) this really
// is a stale file (the OS has since reused that pid for an unrelated
// process — rare but possible) or (b) two server instances are somehow
// running against the same data dir, which is a bigger problem this
// listener cannot fix, only surface.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  IPC_DISCOVERY_FILENAME,
  IPC_TOKEN_FILENAME,
  IPC_LOOPBACK_HOST,
  type IpcDiscoveryFile,
} from "@loombre/controller-ipc";
import { writeIpcFilePosix } from "./posix-permissions.js";
import { applyWindowsAcl, RECOMMENDED_ICACLS_COMMAND } from "./windows-acl.js";
import { resolveIpcGroupName, resolveIpcWindowsExtraGrants } from "./env.js";

export function discoveryFilePath(dataDir: string): string {
  return join(dataDir, IPC_DISCOVERY_FILENAME);
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, IPC_TOKEN_FILENAME);
}

/** 32 random bytes, hex-encoded (64 chars) — an opaque bearer token, no
 *  structure a client needs to parse. transport.ts's IPC_TOKEN_FILENAME doc
 *  comment: "raw UTF-8 text (no JSON wrapper, no trailing newline
 *  required)" — hex satisfies that trivially (no padding/escaping
 *  concerns a base64 alphabet would raise, unlike the base64url password
 *  packages/provisioning-pg/src/secret/file0600.ts generates for a
 *  DIFFERENT purpose — a connection-string-embedded secret — where
 *  compactness actually mattered). */
export function generateIpcToken(): string {
  return randomBytes(32).toString("hex");
}

export interface StaleDiscoveryCheck {
  found: boolean;
  /** Only meaningful when `found` is true. */
  stale: boolean;
  pid?: number;
}

/** POSIX kill(pid, 0) semantics via Node's process.kill: throws ESRCH for
 *  "no such process", throws EPERM for "exists, but not ours to signal"
 *  (still alive), returns normally for "exists and signalable". Mirrors
 *  installers/macos/menubar's own SystemProcessLivenessChecker exactly
 *  (DiscoveryReader.swift) so both sides of this contract agree on what
 *  "stale" means. On win32, process.kill(pid, 0) has different underlying
 *  semantics (no real signal 0 concept) but Node emulates "does this pid
 *  exist" via OpenProcess, which is exactly what's needed here too. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Diagnostic-only pre-flight — see module header. Never throws; a
 *  corrupt/unparseable pre-existing discovery file is reported as
 *  found+stale (treat "can't prove it's live" as "safe to overwrite"). */
export function detectStaleDiscoveryFile(dataDir: string): StaleDiscoveryCheck {
  const path = discoveryFilePath(dataDir);
  if (!existsSync(path)) return { found: false, stale: false };

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IpcDiscoveryFile>;
    if (typeof raw.pid !== "number") return { found: true, stale: true };
    return { found: true, stale: !isPidAlive(raw.pid), pid: raw.pid };
  } catch {
    return { found: true, stale: true };
  }
}

export interface WrittenDiscovery {
  discoveryPath: string;
  tokenPath: string;
  token: string;
  discovery: IpcDiscoveryFile;
}

/** Writes both files for this boot. Call sequence in ipc/index.ts: bind the
 *  real loopback listener FIRST (to learn the actual ephemeral port), THEN
 *  call this — a controller reading a freshly-written discovery file must
 *  never observe a port nothing is listening on yet. */
export function writeDiscoveryFiles(
  dataDir: string,
  params: { port: number; pid: number; startedAtMs: number },
  env: NodeJS.ProcessEnv,
): WrittenDiscovery {
  const discovery: IpcDiscoveryFile = {
    port: params.port,
    host: IPC_LOOPBACK_HOST,
    pid: params.pid,
    startedAtMs: params.startedAtMs,
  };
  const token = generateIpcToken();

  const discoveryPath = discoveryFilePath(dataDir);
  const tokPath = tokenFilePath(dataDir);
  const discoveryJson = JSON.stringify(discovery);

  if (process.platform === "win32") {
    // Windows has no POSIX mode/group bits — write plain, then best-effort
    // ACL (windows-acl.ts is explicit about what this can/cannot guarantee).
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(discoveryPath, discoveryJson, "utf8");
    writeFileSync(tokPath, token, "utf8");
    const extras = resolveIpcWindowsExtraGrants(env);
    for (const path of [discoveryPath, tokPath]) {
      const result = applyWindowsAcl(path, extras);
      if (!result.succeeded) {
        console.warn(
          `ipc: best-effort Windows ACL grant on ${path} did not succeed (${result.detail ?? "unknown reason"}). ` +
            `The file was still written; it inherits its parent directory's ACL. Recommended manual command: ${RECOMMENDED_ICACLS_COMMAND}`,
        );
      }
    }
  } else {
    const groupName = resolveIpcGroupName(env);
    writeIpcFilePosix(discoveryPath, discoveryJson, groupName);
    writeIpcFilePosix(tokPath, token, groupName);
  }

  return { discoveryPath, tokenPath: tokPath, token, discovery };
}

/** Best-effort removal on clean shutdown — see ipc/listener.ts's `exit`
 *  handler for why this must be synchronous. Missing files are not an
 *  error (idempotent, safe to call even if writeDiscoveryFiles never ran). */
export function removeDiscoveryFiles(dataDir: string): void {
  for (const path of [discoveryFilePath(dataDir), tokenFilePath(dataDir)]) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.warn(`ipc: failed to remove ${path} on shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
