#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/cli.ts
//
// `pnpm lpp:conform <url>` (root package.json wires this to `pnpm --filter
// @loombre/plugin-protocol run conform`, which runs this file via `tsx`).
//
// Usage:
//   pnpm lpp:conform <url>
//     [--secret <hex>]              event-subscriber delivery signing secret
//     [--config <json>]             sent as X-LPP-Config
//     [--secret-field NAME=value]   repeatable; sent as X-LPP-Secret-<NAME>
//     [--timeout <ms>]              per-request timeout (default 10000)
//     [--replay-window <ms>]        event-subscriber replay window (default 300000)
//
// Exit code 0 iff every check across every suite is pass|warn (no fail).

import { runLppConformance } from "./run.js";
import { formatLppConformanceReport } from "./report-format.js";

interface ParsedArgs {
  url: string;
  secret: string | undefined;
  config: Record<string, unknown> | undefined;
  secrets: Record<string, string>;
  timeoutMs: number | undefined;
  replayWindowMs: number | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const secrets: Record<string, string> = {};
  let secret: string | undefined;
  let config: Record<string, unknown> | undefined;
  let timeoutMs: number | undefined;
  let replayWindowMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--secret":
        secret = argv[++i];
        break;
      case "--config": {
        const raw = argv[++i];
        if (raw === undefined) throw new Error("--config requires a JSON argument");
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("--config must be a JSON object");
        }
        config = value as Record<string, unknown>;
        break;
      }
      case "--secret-field": {
        const raw = argv[++i];
        const eq = raw?.indexOf("=") ?? -1;
        if (!raw || eq === -1) throw new Error("--secret-field requires NAME=value");
        secrets[raw.slice(0, eq)] = raw.slice(eq + 1);
        break;
      }
      case "--timeout":
        timeoutMs = Number(argv[++i]);
        break;
      case "--replay-window":
        replayWindowMs = Number(argv[++i]);
        break;
      default:
        positionals.push(arg ?? "");
    }
  }

  const url = positionals[0];
  if (!url) {
    throw new Error("usage: lpp:conform <url> [--secret <hex>] [--config <json>] [--secret-field NAME=value] [--timeout <ms>]");
  }
  return { url, secret, config, secrets, timeoutMs, replayWindowMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runLppConformance(args.url, {
    ...(args.secret !== undefined ? { signingSecret: args.secret } : {}),
    ...(args.config !== undefined ? { config: args.config } : {}),
    ...(Object.keys(args.secrets).length > 0 ? { secrets: args.secrets } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.replayWindowMs !== undefined ? { replayWindowMs: args.replayWindowMs } : {}),
  });
  console.log(formatLppConformanceReport(report));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`lpp:conform: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
