// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/windows-acl.ts
//
// The IPC lane's Windows ACL seam. The implementation itself now lives in
// @loombre/secrets' windows-acl.ts — the ONE home for every Windows ACL
// this codebase sets — which exposes two named policies side by side:
//
//   ownerOnly       — secrets (0600 tier): exactly one ACE, fail-closed.
//   serviceReadable — THIS lane: SYSTEM full + Administrators read,
//                     best-effort.
//
// This file keeps the IPC-specific naming and the operator-facing
// documentation below; it deliberately does not re-implement the icacls
// call. Read the policy comments in that module before changing which one
// is used here — the two differ on purpose, and picking the wrong one is
// either a confidentiality bug (a secret every local admin can read) or an
// availability bug (a service that cannot read its own discovery file).
//
// WHY serviceReadable IS THE RIGHT POLICY FOR THESE FILES (unchanged from
// the original orchestrator decision (b), Windows half):
//
// - The discovery/token files exist to be FOUND. A tray app or CLI run by
//   a local administrator must read them to locate and authenticate to a
//   server that may be running as LocalSystem — a different account. An
//   owner-only ACL here would not be "more secure", it would break the
//   feature outright.
// - Node has NO built-in Windows ACL API at all — Windows fs.chmod only
//   toggles the read-only DOS attribute. Shelling out to icacls.exe is the
//   only dependency-free way to set a real ACL.
// - Best-effort by design: a failed icacls degrades to the ACL the file
//   inherits from its parent directory (for a service-account-owned
//   app-data directory, typically SYSTEM + Administrators already, per
//   docs/PLAN.md §11 / installers/windows/msi's Directories.wxs) — not to
//   world access. Refusing to start the listener over a failed hardening
//   step would trade a small confidentiality margin for a total
//   availability loss, so failures are reported, never thrown.
// - This lane does NOT know who "the installing user" is. Beyond
//   BUILTIN\Administrators (named by locale-independent well-known SID
//   S-1-5-32-544, since the string "Administrators" is English-only), that
//   identity is known only to whatever installed Loombre.
//   LOOMBRE_IPC_WINDOWS_GRANT (env.ts) lets an installer or operator name
//   additional principals; absent it, only Administrators (and the writing
//   process's own account, implicitly via NTFS owner rights) can read.
//   Intentionally the NARROW default — "local administrators + the
//   installing user, not world" — with the installing-user half left to
//   whichever install path can actually name that account (I3 follow-up:
//   Services.wxs or a post-install step should set
//   LOOMBRE_IPC_WINDOWS_GRANT, or re-run icacls once that identity known).
// - RECOMMENDED_ICACLS_COMMAND re-exports the exact invocation attempted,
//   so an operator or installer can apply/verify the same grant by hand
//   regardless of whether the runtime attempt succeeded.

import { applyServiceReadableDacl, RECOMMENDED_ICACLS_COMMAND, type WindowsAclResult } from "@loombre/secrets";

export { RECOMMENDED_ICACLS_COMMAND };
export type { WindowsAclResult };

/** Best-effort: strips inherited permissions and grants SYSTEM full control
 *  + Administrators (+ any LOOMBRE_IPC_WINDOWS_GRANT extras) read-only, via
 *  `icacls`. No-ops (attempted: false) on any platform other than win32 —
 *  callers only need to invoke this unconditionally and check the result. */
export function applyWindowsAcl(path: string, extraGrants: string[] = []): WindowsAclResult {
  return applyServiceReadableDacl(path, extraGrants);
}
