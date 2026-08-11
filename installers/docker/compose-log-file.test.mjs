// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/docker/compose-log-file.test.mjs
//
// LD-11 (this implementation run's lane B3): every install shape
// must set LOOMBRE_LOG_FILE to a platform-appropriate path so
// GET /admin/logs/tail (apps/server/src/catalog/admin-logs-tail.ts) has a
// real file to read. Docker has no supervisor-level file capture the way
// macOS's launchd (StandardOutPath) or Windows' LoombreServiceHost
// (its own log-file Arguments flag) do — this test asserts docker-
// compose.prod.yml (repo root) both sets the env var AND wires a real
// writer for it (the `server`/`worker` services' own `command:` override,
// which tees stdout+stderr to the same path while preserving the
// original stdout so `docker compose logs` — the documented
// docs/install/docker.md troubleshooting path — keeps working unchanged).
//
// Signal-safety of the tee override (verified empirically against a real
// tini+bash+node container, scratch-only, never committed — see this
// lane's exit report for the captured run) is a runtime property this
// static test cannot itself prove; what IS statically checked below is
// the structural shape that makes that property hold: `bash -c` ending in
// `exec node ...` (so node replaces the shell as tini's tracked child,
// preserving PID-based SIGTERM delivery) and the tee target matching the
// LOOMBRE_LOG_FILE env value exactly.
//
// Run: node --test installers/docker/compose-log-file.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DOCKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DOCKER_DIR, "..", "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.prod.yml");

const composeSource = readFileSync(COMPOSE_PATH, "utf8");

/** Extracts one top-level service's YAML block by name (from its `  <name>:`
 *  heading to the next same-indentation heading or EOF) — a plain text
 *  slice, not a YAML parse (this repo has no YAML-parser dependency; see
 *  scripts/perf-baseline-check.mjs-adjacent precedent of hand-rolled
 *  extraction over adding a parser for a narrow, well-bounded check). */
function extractServiceBlock(name) {
  // NOTE: the lookahead deliberately does NOT include a bare `$` alternative
  // — under the "m" flag, `$` matches at the end of EVERY line, not just
  // the end of the string, which would make the lazy `[\s\S]*?` stop after
  // just one line. This file always has a trailing top-level `volumes:`
  // section after every service, so that alternative alone is sufficient.
  const headingRe = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z_]+:\\n|^volumes:\\n)`, "m");
  const match = composeSource.match(headingRe);
  assert.ok(match, `could not find a top-level "${name}:" service block in docker-compose.prod.yml`);
  return match[1];
}

for (const { service, logFile } of [
  { service: "server", logFile: "/data/logs/server.log" },
  { service: "worker", logFile: "/data/logs/worker.log" },
]) {
  test(`${service}: environment sets LOOMBRE_LOG_FILE to ${logFile}`, () => {
    const block = extractServiceBlock(service);
    assert.match(
      block,
      new RegExp(`LOOMBRE_LOG_FILE:\\s*${logFile.replace(/\//g, "\\/")}\\s*\\n`),
      `${service}'s environment block never sets LOOMBRE_LOG_FILE to ${logFile}`,
    );
  });

  test(`${service}: command tees stdout+stderr to the SAME path as LOOMBRE_LOG_FILE, then execs node directly (tini-signal-safe shape)`, () => {
    const block = extractServiceBlock(service);
    const commandMatch = block.match(/command:\s*>-\s*\n\s+(.+)/);
    assert.ok(commandMatch, `${service} has no folded-scalar \`command: >-\` override`);
    const command = commandMatch[1];

    assert.match(command, /^bash -c "/, `${service}'s command must run through bash -c (process substitution is a bash-ism)`);
    assert.match(
      command,
      new RegExp(`tee -a ${logFile.replace(/\//g, "\\/")}`),
      `${service}'s command does not tee to ${logFile}`,
    );
    // MUST end in `exec node ...` — a trailing non-exec'd command would
    // leave bash as the tracked process, breaking tini's direct-child
    // SIGTERM delivery on `docker stop` (verified empirically the other
    // way: this exact shape, scratch-tested, forwards SIGTERM to node's
    // own pid with no added delay).
    assert.match(command, /&& exec node [^"]+"$/, `${service}'s command does not end in "&& exec node ...\" — verify tini-signal-safety`);
  });
}

test("docker-compose.prod.yml documents `docker compose logs` still works (tee, not a redirect, preserves stdout)", () => {
  // Sanity guard against a future edit accidentally replacing the tee-based
  // override with a plain `>` redirect (which would silently break the
  // documented troubleshooting path in docs/install/docker.md).
  for (const service of ["server", "worker"]) {
    const block = extractServiceBlock(service);
    const commandMatch = block.match(/command:\s*>-\s*\n\s+(.+)/);
    assert.ok(commandMatch);
    assert.doesNotMatch(
      commandMatch[1],
      />\s*\/data\/logs\/[a-z]+\.log(?!\))/,
      `${service}'s command redirects stdout AWAY from the console (a plain ">", not a tee) — this breaks "docker compose logs"`,
    );
  }
});
