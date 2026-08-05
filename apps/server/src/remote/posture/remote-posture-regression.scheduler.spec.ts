// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/remote-posture-regression.scheduler.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7/RG4, S1 lane). Exit-gate line:
// "regression raises a notice" — this file proves runSweep() diffs
// against the previous sweep's grades and emits the correct outbox event
// (posture.regressed on worsening, posture.recovered on improving), NEVER
// on the first sweep ever (silent baseline seed), and never for a check
// that stayed the same grade.
//
// A FAKE RemotePostureService (scripted evaluate() return values across
// successive calls) rather than driving real checks through real state —
// the checks/evaluators themselves are already covered exhaustively
// elsewhere (./checks/*.spec.ts, ./remote-posture.service.spec.ts); this
// file is purely about the SCHEDULER's diff-and-emit logic. The events
// table itself is real (live DB, same ensureTestDatabase convention as
// every other live-DB spec in this package) — recordPostureRegressedEvent/
// recordPostureRecoveredEvent are real packages/db functions, not faked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase } from "@loombre/db";
import type { PostureCardState, PostureCheckKey, PostureGrade } from "@loombre/shared";
import { DbProvider, type LoombreDb } from "../../common/db.provider.js";
import { RemotePostureRegressionSchedulerService } from "./remote-posture-regression.scheduler.js";
import type { RemotePostureService } from "./remote-posture.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: LoombreDb;
let dbProvider: DbProvider;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "posture_regression_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  dbProvider = new DbProvider();
  db = dbProvider.db;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
});

function cardOf(checks: { checkKey: PostureCheckKey; grade: PostureGrade }[]): PostureCardState {
  return {
    active: checks.length > 0,
    overallGrade: "pass",
    checks: checks.map((c) => ({ ...c, fixAction: { label: "", href: "" } })),
  };
}

/** A fake RemotePostureService whose evaluate() replays a scripted
 *  sequence of cards, one per call — exactly what runSweep() calls once
 *  per tick. */
function fakePostureService(cards: PostureCardState[]): RemotePostureService {
  let i = 0;
  const fake = {
    resolveActivePath: async () => "remote" as const,
    evaluate: async () => {
      const card = cards[Math.min(i, cards.length - 1)]!;
      i += 1;
      return { card, details: new Map() };
    },
  };
  return fake as unknown as RemotePostureService;
}

async function latestEventsOfType(type: string): Promise<{ payload: Record<string, unknown>; actor_user_id: string | null }[]> {
  return db
    .selectFrom("events")
    .select(["payload", "actor_user_id"])
    .where("type", "=", type)
    .orderBy("ts_ms", "desc")
    .limit(50)
    .execute();
}

describe("RemotePostureRegressionSchedulerService.runSweep", () => {
  it("the FIRST sweep ever seeds the baseline silently — no event, even for a check that starts at fail", async () => {
    const scheduler = new RemotePostureRegressionSchedulerService(
      dbProvider,
      fakePostureService([cardOf([{ checkKey: "tlsValidity", grade: "fail" }])]),
    );
    const beforeRegressed = (await latestEventsOfType("posture.regressed")).length;
    const beforeRecovered = (await latestEventsOfType("posture.recovered")).length;

    await scheduler.runSweep();

    expect((await latestEventsOfType("posture.regressed")).length).toBe(beforeRegressed);
    expect((await latestEventsOfType("posture.recovered")).length).toBe(beforeRecovered);
  });

  it("a worsening grade on the SECOND sweep emits posture.regressed with the exact old/new grades, no actor", async () => {
    const scheduler = new RemotePostureRegressionSchedulerService(
      dbProvider,
      fakePostureService([
        cardOf([{ checkKey: "rateLimitersActive", grade: "pass" }]),
        cardOf([{ checkKey: "rateLimitersActive", grade: "fail" }]),
      ]),
    );
    await scheduler.runSweep(); // seeds baseline (pass)
    const before = (await latestEventsOfType("posture.regressed")).length;

    await scheduler.runSweep(); // pass -> fail

    const after = await latestEventsOfType("posture.regressed");
    expect(after.length).toBe(before + 1);
    const event = after.find((e) => e.payload["checkKey"] === "rateLimitersActive" && e.payload["newGrade"] === "fail");
    expect(event).toBeDefined();
    expect(event!.payload["previousGrade"]).toBe("pass");
    expect(event!.actor_user_id).toBeNull();
  });

  it("an improving grade emits posture.recovered instead", async () => {
    const scheduler = new RemotePostureRegressionSchedulerService(
      dbProvider,
      fakePostureService([
        cardOf([{ checkKey: "staleAccounts", grade: "warn" }]),
        cardOf([{ checkKey: "staleAccounts", grade: "pass" }]),
      ]),
    );
    await scheduler.runSweep(); // seeds baseline (warn)
    const before = (await latestEventsOfType("posture.recovered")).length;

    await scheduler.runSweep(); // warn -> pass

    const after = await latestEventsOfType("posture.recovered");
    expect(after.length).toBe(before + 1);
    const event = after.find((e) => e.payload["checkKey"] === "staleAccounts" && e.payload["newGrade"] === "pass");
    expect(event).toBeDefined();
    expect(event!.payload["previousGrade"]).toBe("warn");
  });

  it("an UNCHANGED grade between sweeps emits nothing", async () => {
    const scheduler = new RemotePostureRegressionSchedulerService(
      dbProvider,
      fakePostureService([
        cardOf([{ checkKey: "inviteLinksReachable", grade: "pass" }]),
        cardOf([{ checkKey: "inviteLinksReachable", grade: "pass" }]),
      ]),
    );
    await scheduler.runSweep();
    const beforeRegressed = (await latestEventsOfType("posture.regressed")).length;
    const beforeRecovered = (await latestEventsOfType("posture.recovered")).length;

    await scheduler.runSweep();

    expect((await latestEventsOfType("posture.regressed")).length).toBe(beforeRegressed);
    expect((await latestEventsOfType("posture.recovered")).length).toBe(beforeRecovered);
  });

  it("overlap guard: a sweep already in flight makes a concurrent runSweep() call a no-op", async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let evaluateCalls = 0;
    const slowPostureService = {
      resolveActivePath: async () => "remote" as const,
      evaluate: async () => {
        evaluateCalls += 1;
        await gate;
        return { card: cardOf([{ checkKey: "connectorHealth", grade: "pass" }]), details: new Map() };
      },
    } as unknown as RemotePostureService;
    const scheduler = new RemotePostureRegressionSchedulerService(dbProvider, slowPostureService);

    const firstSweep = scheduler.runSweep();
    const secondSweep = scheduler.runSweep(); // should return immediately, ticking=true
    await secondSweep;
    expect(evaluateCalls).toBe(1); // the second call never even reached evaluate()
    resolveFirst();
    await firstSweep;
  });

  it("a check that drops out of applicability (path change) is not left as a stale baseline for a LATER unrelated diff", async () => {
    const scheduler = new RemotePostureRegressionSchedulerService(
      dbProvider,
      fakePostureService([
        cardOf([{ checkKey: "wgPortSilence", grade: "info" }]), // seed (remote path)
        cardOf([{ checkKey: "connectorHealth", grade: "pass" }]), // path changed to tunnel — wgPortSilence gone
        cardOf([{ checkKey: "wgPortSilence", grade: "fail" }]), // path changed back — fresh first-sighting, not a diff
      ]),
    );
    await scheduler.runSweep();
    await scheduler.runSweep();
    const before = (await latestEventsOfType("posture.regressed")).length;

    await scheduler.runSweep();

    // wgPortSilence reappearing at "fail" must be treated as a FRESH
    // baseline (no prior grade to diff against after it dropped out), not
    // a regression from its stale "info" baseline two sweeps ago.
    expect((await latestEventsOfType("posture.regressed")).length).toBe(before);
  });
});
