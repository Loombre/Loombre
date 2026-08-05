#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/pebble/challtestsrv-dns-hook.mjs
//
// A REAL LOOMBRE_ACME_DNS_HOOK script (test-only) — proves the documented
// hook-script seam (P4.4) end-to-end by standing in for a real DNS
// provider's API with pebble-challtestsrv's `/set-txt` / `/clear-txt`
// management API instead. This is exactly the shape any operator's own
// hook script takes (see docs/ops/remote-access/acme.md's real-provider example): read
// argv[2]/argv[3] (or the LOOMBRE_ACME_DNS_* env vars — either works),
// call an HTTP API, exit 0 on success / nonzero with a stderr message on
// failure.
//
// Usage: challtestsrv-dns-hook.mjs <set|clear> <record-name> <txt-value>
// Env:   LOOMBRE_TEST_CHALLTESTSRV_URL (management API base, e.g.
//        http://127.0.0.1:3602)

const [, , action, recordName, value] = process.argv;
const base = process.env.LOOMBRE_TEST_CHALLTESTSRV_URL;

if (base === undefined || base.trim() === "") {
  console.error("challtestsrv-dns-hook: LOOMBRE_TEST_CHALLTESTSRV_URL is not set");
  process.exit(1);
}
if (action !== "set" && action !== "clear") {
  console.error(`challtestsrv-dns-hook: unknown action "${action}" (expected set|clear)`);
  process.exit(1);
}
if (!recordName) {
  console.error("challtestsrv-dns-hook: missing record name argument");
  process.exit(1);
}

// challtestsrv requires the trailing dot on the FQDN (its own README says
// so explicitly) and, per its API, /set-txt REPLACES the value (a second
// set-txt with a different value overwrites, it does not append) —
// mirrors how a real DNS provider's upsert-a-TXT-record call behaves.
const host = recordName.endsWith(".") ? recordName : `${recordName}.`;
const endpoint = action === "set" ? "/set-txt" : "/clear-txt";
const body = action === "set" ? { host, value } : { host };

const res = await fetch(`${base}${endpoint}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`challtestsrv-dns-hook: ${endpoint} returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

process.exit(0);
