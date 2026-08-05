// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/fixtures/http01-crash-entrypoint.ts
//
// Real child-process entrypoint for
// ../http01-crash-boundary.integration.spec.ts — mirrors
// ../../crash/fixtures/throw-entrypoint.ts's rationale exactly, applied to
// the HTTP-01 challenge listener: installs the REAL crash handlers (the
// same boot order main.ts uses) then stands up a REAL Http01ChallengeServer
// on a real loopback socket and idles. The parent test drives it with real
// HTTP requests so a throw inside handle() propagates through the SAME
// http.Server event-emitter path production does — a direct handle() call
// in a unit test would not exercise that path and would pass even with the
// crash boundary removed.
//
// Usage: node --import tsx http01-crash-entrypoint.ts <dataDir>
// Registers "known-token" -> "known-key-authorization" before listening,
// then prints "PORT=<n>" to stdout once listen() resolves.

import { installCrashHandlers } from "../../../src/crash/handlers.js";
import { Http01ChallengeServer } from "../../../src/tls/acme/http01-server.js";

const [, , dataDir] = process.argv;
if (!dataDir) {
  console.error("usage: http01-crash-entrypoint.ts <dataDir>");
  process.exit(2);
}

installCrashHandlers({ dataDir, version: "test-fixture-1.0.0", platform: process.platform });

const server = new Http01ChallengeServer({ host: "127.0.0.1" });
server.register("known-token", "known-key-authorization");

await server.listen(0);
console.log(`PORT=${server.port}`);
