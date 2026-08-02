#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/bin/loombre.mjs
//
// The `loombre` CLI entrypoint (docs/PLAN.md §14.1, STATE.md P4.11).
// Registered as this package's "bin" (apps/server/package.json), so an
// installed/linked package puts a `loombre` executable on PATH pointing
// here. Deliberately thin: all real logic lives in
// apps/server/src/cli/run-cli.ts (unit-tested directly, no process spawn
// needed) — this file only wires that pure function to real process
// I/O (argv/env/exit) and prints its output.
//
// Runtime note for installer lanes (I1 tarball / I3 MSI / I4 pkg): this
// script imports the COMPILED output at ../dist/cli/run-cli.js and
// ../dist/cli/doctor-node-deps.js (apps/server's own `pnpm build`, i.e.
// `tsc -p tsconfig.json`, plus packages/shared's own dist — both are
// plain compiled JS with no tsx/ts-node requirement at runtime, unlike
// apps/server's Nest application code, which separately depends on
// @loombre/db/@loombre/jobs resolving via tsx — see apps/server/scripts/
// dev.mjs's header). A packaged install only needs `apps/server/dist/**`
// + `packages/shared/dist/**` on disk for this CLI to work; it does NOT
// need Postgres reachable, ffmpeg present, or the Nest app booted for any
// of --version/--help/paths/doctor (doctor's checks are advisory reads,
// never a hard dependency on the thing being checked existing).
//
// H2 update: `admin reset-pin <username>` is one exception to the above —
// it DOES need a reachable Postgres (DATABASE_URL), since it reads and
// writes real user_settings/events rows. @loombre/db is dynamically
// imported only once that branch actually runs (run-cli.ts / admin-
// reset-pin.ts's own headers), so every other command here is completely
// unaffected — help/version/paths/doctor still load no database code at
// all and still work with Postgres unreachable.
//
// E3a/M14 update (STATE.md "Optional mail transport + invitation & reset
// flows"): `admin reset-password <username>` is the second such exception
// — same posture (needs DATABASE_URL, dynamically imports @loombre/db only
// once that branch runs — admin-reset-password.ts's own header), reads and
// writes real users/refresh_tokens/events rows.
//
// Wrapper scripts: platform installers should invoke this exact path —
// `<install-root>/apps/server/bin/loombre.mjs` — via a thin OS-native
// shim (a `loombre` shell script on Linux/macOS, a `loombre.cmd`/shortcut
// on Windows) that execs `node apps/server/bin/loombre.mjs "$@"` from the
// installed layout. See the release-lane report for the exact contract.

import { runCli } from "../dist/cli/run-cli.js";
import { REAL_DOCTOR_DEPS } from "../dist/cli/doctor-node-deps.js";
import { REAL_ADMIN_DEPS } from "../dist/cli/admin-node-deps.js";

async function main() {
  let result;
  try {
    result = await runCli({
      argv: process.argv.slice(2),
      env: process.env,
      nodePlatform: process.platform,
      doctorDeps: REAL_DOCTOR_DEPS,
      adminDeps: REAL_ADMIN_DEPS,
    });
  } catch (err) {
    process.stderr.write(`loombre: internal error — ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = result.exitCode;
}

main();
