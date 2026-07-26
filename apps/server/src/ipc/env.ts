// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/env.ts
//
// Env resolution for this lane's mission deliverable: "LOOMBRE_IPC_DISABLED=1
// kill-switch (default enabled only when LOOMBRE_DATA_DIR is set — dev
// servers without a data dir get no IPC; document)".
//
// Rationale: a dev checkout running `pnpm dev` with no LOOMBRE_DATA_DIR set
// resolves an app-data dir under the developer's own home directory
// (apps/server/src/cli/app-paths.ts's defaultDataDir) purely as a
// convenience default for embedded-PG provisioning — it was never an
// explicit "this is an installed Loombre instance" signal. Standing up a
// loopback HTTP listener + writing discovery/token files under that
// incidental directory on every `pnpm dev` boot would be surprising and
// serves no controller (no tray/menubar app is ever pointed at a dev
// checkout). Requiring an EXPLICIT LOOMBRE_DATA_DIR — which only installers
// (I1 systemd EnvironmentFile, I3 Windows service, I4 launchd plist,
// docker-compose) and an operator who deliberately opts in ever set — keeps
// the IPC listener inert by default in every dev/test context while still
// being unconditionally on for every real install without any extra flag.
//
// LOOMBRE_IPC_DISABLED is the escape hatch on top of that: an operator (or
// installer script under test) who HAS set LOOMBRE_DATA_DIR but wants the
// listener off anyway (e.g. running a headless install with no controller
// app present at all) sets LOOMBRE_IPC_DISABLED=1.

function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "yes";
}

export interface IpcEnablementResult {
  enabled: boolean;
  /** Human-readable reason, always populated — logged once at boot either
   *  way so "why isn't the tray finding my server" has an immediate answer
   *  in the server's own log. */
  reason: string;
}

export function resolveIpcEnablement(env: NodeJS.ProcessEnv): IpcEnablementResult {
  const dataDirSet = (env["LOOMBRE_DATA_DIR"]?.trim().length ?? 0) > 0;
  if (!dataDirSet) {
    return {
      enabled: false,
      reason:
        "LOOMBRE_DATA_DIR is not set — dev/ad-hoc servers get no IPC listener by default (set LOOMBRE_DATA_DIR to opt in, or run through an installer, which always sets it).",
    };
  }
  if (isTruthyFlag(env["LOOMBRE_IPC_DISABLED"])) {
    return { enabled: false, reason: "LOOMBRE_IPC_DISABLED is set — IPC listener explicitly disabled." };
  }
  return { enabled: true, reason: "LOOMBRE_DATA_DIR is set and LOOMBRE_IPC_DISABLED is not — IPC listener enabled." };
}

/** Orchestrator decision (b): mac/linux discovery+token files are written
 *  0640 with the file GROUP set from LOOMBRE_IPC_GROUP (a POSIX group NAME,
 *  e.g. an installer setting "admin" on macOS), defaulting to the writing
 *  process's own primary group when unset — see posix-permissions.ts. This
 *  just resolves the raw env value; group-name -> gid resolution needs
 *  `id -g`, so it lives in posix-permissions.ts next to where it's used. */
export function resolveIpcGroupName(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["LOOMBRE_IPC_GROUP"]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Windows analog of LOOMBRE_IPC_GROUP: extra principal name(s) (comma-
 *  separated) an installer can grant read access to on top of the always-
 *  granted BUILTIN\Administrators — see windows-acl.ts. Named distinctly
 *  (not reusing LOOMBRE_IPC_GROUP) because a POSIX group name and a Windows
 *  account/group name are different identifier spaces; conflating them
 *  behind one env var would silently do the wrong thing on whichever
 *  platform didn't expect it. */
export function resolveIpcWindowsExtraGrants(env: NodeJS.ProcessEnv): string[] {
  const raw = env["LOOMBRE_IPC_WINDOWS_GRANT"]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
