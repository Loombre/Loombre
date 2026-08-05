#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/support/cloudflared-stub.mjs
//
// STATE.md RG7 (T2): a tiny Node script emulating cloudflared's observable
// behavior for CloudflaredConnectorManager's lifecycle tests — driven
// through the REAL spawn path (a genuine, unprivileged OS child process,
// real signals, real stdout/stderr streams), never mocked. Run directly
// with `node cloudflared-stub.mjs` (a plain script, not exec'd as a
// binary, so it needs no chmod/shebang-execute permission — cross-platform
// safe, including Windows CI, where a shebang-executable file would not
// work at all). apps/server/test/remote-tunnel.e2e.spec.ts substitutes
// this for the real `cloudflared` binary via ConnectorManager.setTestDeps'
// spawnFn seam, which redirects the OS-level exec target to
// `node <this file> tunnel --no-autoupdate run` while leaving everything
// else (env, stdio, signals) production-real.
//
// Mode selected by the CLOUDFLARED_STUB_MODE env var:
//   healthy        - prints the readiness line, then runs until signaled.
//   crash          - runs, then exits 1 after CLOUDFLARED_STUB_CRASH_AFTER_MS.
//   flap           - prints the readiness line, then (after
//                    CLOUDFLARED_STUB_FLAP_AFTER_MS) prints a
//                    connection-lost line WITHOUT exiting, then keeps running.
//   ignore-sigterm - runs forever, ignores SIGTERM (only SIGKILL reaps it).
//   silent         - runs forever, never prints a readiness line (stuck
//                    'starting' — never asserted on by the e2e suite, kept
//                    for local/manual use).

const mode = process.env.CLOUDFLARED_STUB_MODE ?? "healthy";
const crashAfterMs = Number(process.env.CLOUDFLARED_STUB_CRASH_AFTER_MS ?? 20);
const flapAfterMs = Number(process.env.CLOUDFLARED_STUB_FLAP_AFTER_MS ?? 20);

if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {
    // Deliberately does nothing — only SIGKILL can reap this process.
  });
}

function writeReadyLine() {
  process.stderr.write(
    "INF Registered tunnel connection connIndex=0 connection=stub-conn event=0 ip=127.0.0.1 location=STUB protocol=quic\n",
  );
}

function writeConnectionLostLine() {
  process.stderr.write("INF Unregistered tunnel connection connIndex=0 event=1\n");
}

switch (mode) {
  case "crash":
    setTimeout(() => process.exit(1), crashAfterMs);
    break;
  case "flap":
    writeReadyLine();
    setTimeout(writeConnectionLostLine, flapAfterMs);
    break;
  case "silent":
    break;
  case "healthy":
  case "ignore-sigterm":
  default:
    writeReadyLine();
    break;
}

// Keep the event loop alive until signaled (SIGTERM/SIGKILL from the
// connector manager's stop()/killChild path).
setInterval(() => {}, 1000);
