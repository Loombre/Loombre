// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/dns01-hook.ts
//
// DNS-01 has two documented modes (P4.4 — "NO per-provider SDKs in v1"):
//
//   1. Hook script (LOOMBRE_ACME_DNS_HOOK set): Loombre invokes the
//      operator's own executable as
//        <script> set  <record-name> <txt-value>
//        <script> clear <record-name> <txt-value>
//      and waits for it to exit 0. The script is 100% the operator's
//      responsibility — a five-line curl wrapper against Cloudflare/
//      Route53/etc's API, or anything else. This is the same shape every
//      "generic hook" ACME client (certbot's --manual-auth-hook,
//      acme.sh's dns_ prefix, lego's exec provider) converges on, and it
//      is what keeps Loombre's dependency tree free of N per-provider DNS
//      SDKs (a real AGPL-relicense-readiness + maintenance-burden win).
//
//   2. Manual mode (LOOMBRE_ACME_DNS_HOOK unset): Loombre prints the record
//      name+value to the log and polls DNS until it becomes visible, for
//      an operator who will paste it into their registrar's UI by hand.
//      No hook script, no automation — just a wait loop with a real
//      timeout so a forgotten record doesn't hang the process forever.
//
// Both modes share pollTxtRecordVisible(): after the hook sets the
// record (or in parallel with the operator manually setting it), this
// polls DNS until the TXT value is actually visible before letting the
// ACME flow ask the CA to validate — CA-side validation has its own
// retry/backoff, but confirming propagation first avoids burning through
// that budget on records that predictably aren't live yet.

import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";

export type DnsHookAction = "set" | "clear";

export interface RunDnsHookOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Spawns `hookPath <action> <recordName> <recordValue>` and resolves when
 *  it exits 0; rejects (with stderr in the message) on nonzero exit,
 *  spawn error, or timeout. The three hook arguments are also exposed as
 *  LOOMBRE_ACME_DNS_ACTION / LOOMBRE_ACME_DNS_RECORD / LOOMBRE_ACME_DNS_VALUE
 *  env vars for scripts that prefer reading env over argv. */
export function runDnsHook(
  hookPath: string,
  action: DnsHookAction,
  recordName: string,
  recordValue: string,
  opts: RunDnsHookOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(hookPath, [action, recordName, recordValue], {
      env: {
        ...process.env,
        ...opts.env,
        LOOMBRE_ACME_DNS_ACTION: action,
        LOOMBRE_ACME_DNS_RECORD: recordName,
        LOOMBRE_ACME_DNS_VALUE: recordValue,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`LOOMBRE_ACME_DNS_HOOK timed out after ${timeoutMs}ms (${action} ${recordName})`));
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`LOOMBRE_ACME_DNS_HOOK failed to run "${hookPath}": ${err.message}`));
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`LOOMBRE_ACME_DNS_HOOK exited ${String(code)} for "${action} ${recordName}": ${stderr.trim()}`));
      }
    });
  });
}

export interface PollTxtOptions {
  /** Custom DNS resolver addresses (host:port) — used by tests to point at
   *  pebble-challtestsrv's fake DNS server instead of the system resolver.
   *  node:dns.Resolver#setServers wants bare addresses (no scheme); ports
   *  are supported as "host:port" per Node's docs. */
  resolverAddresses?: string[];
  timeoutMs?: number;
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `resolveTxt(recordName)` until `expectedValue` is among the
 *  returned records (TXT records can be split into multiple strings by
 *  the resolver — records.join('') reassembles a chunked value) or the
 *  timeout elapses. NXDOMAIN/SERVFAIL while the record hasn't propagated
 *  yet are expected and swallowed; any OTHER unexpected condition still
 *  just counts as "not yet visible" for this call — propagation checking
 *  is a best-effort accelerant, never the sole gate for automated
 *  (hook-script) mode, where the CA's own retries are the real backstop. */
export async function pollTxtRecordVisible(
  recordName: string,
  expectedValue: string,
  opts: PollTxtOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const resolver = new Resolver();
  if (opts.resolverAddresses !== undefined) resolver.setServers(opts.resolverAddresses);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const records = await resolver.resolveTxt(recordName);
      if (records.some((chunks) => chunks.join("") === expectedValue)) return true;
    } catch {
      // Not yet propagated (or a transient resolver error) — keep polling.
    }
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export function formatManualDnsInstructions(recordName: string, recordValue: string): string {
  return (
    "Loombre ACME DNS-01: LOOMBRE_ACME_DNS_HOOK is not set — create this TXT record with your DNS " +
    `provider, then Loombre will continue automatically once it propagates:\n` +
    `  Name:  ${recordName}\n` +
    `  Value: ${recordValue}`
  );
}
