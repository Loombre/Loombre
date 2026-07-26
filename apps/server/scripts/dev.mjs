// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/scripts/dev.mjs
//
// Dev runner. `tsx watch src/main.ts` is NOT usable for this app: tsx
// transforms with esbuild, which cannot emit `design:paramtypes` metadata
// (emitDecoratorMetadata), and NestJS constructor injection silently
// resolves every dependency to `undefined` without it — the app "boots"
// and /healthz answers (no deps), but the first real request or bootstrap
// hook that touches an injected service crashes (found via
// WsBroadcasterService.httpAdapterHost in Phase 2 Wave 2). The dev loop
// therefore runs the real `tsc --watch` (full metadata emit, same compiler
// as the build) and restarts `node --watch` against dist/.
//
// Cross-platform note: on Windows the pnpm/npx shims are .cmd files that
// spawn() refuses without a shell (see scripts/gate.mjs) — same rule here.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const WIN = process.platform === "win32";
const appDir = fileURLToPath(new URL("..", import.meta.url));
const distMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const tsc = spawn("npx", ["tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], {
  cwd: appDir,
  stdio: "inherit",
  shell: WIN,
});

// Wait for the first emit (or reuse a stale dist — node --watch restarts on
// the rebuild that is already underway).
while (!existsSync(distMain)) {
  if (tsc.exitCode !== null) process.exit(tsc.exitCode ?? 1);
  await delay(250);
}
await delay(500);

// `--import tsx` mirrors the perf-t0 dist-child trick: workspace deps
// (@loombre/db etc.) resolve to their TS sources, which tsx transforms on
// the fly — those packages carry no Nest decorators, so the metadata loss
// is confined to code that never needs it, while this app's own classes
// load from dist with full emitDecoratorMetadata output.
const node = spawn(process.execPath, ["--enable-source-maps", "--import", "tsx", "--watch", distMain], {
  cwd: appDir,
  stdio: "inherit",
});

const shutdown = () => {
  tsc.kill();
  node.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
node.on("exit", (code) => {
  tsc.kill();
  process.exit(code ?? 0);
});
