// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/reconciliation-fold.spec.ts
//
// process-lifecycle hardening wave (2026-08-11, Lane A1) item C7: fold 'transcode'
// into the boot job-ledger reconciliation.
//
// apps/worker/src/index.ts's SINGLETON_GUARDED_JOB_TYPES deliberately
// excluded 'transcode', for a good reason its own comment states: the
// sweep is scoped to one-per-type job types so it can never turn into an
// unbounded loop with a matching outbox-event flood. 'transcode' is the
// opposite shape — one ledger row per playback session, many concurrent —
// so the fix is NOT to append it to that list. The machinery grows a
// notion of GROUPS, each with its own horizons and its own row bound:
//
//   * the singleton group keeps 24h-queued / previous-generation-active;
//   * transcode gets a horizon measured against a PLAYBACK session's
//     lifetime (a queued transcode job older than the 15-minute heartbeat
//     sweep belongs to a session that no longer exists), the same
//     previous-generation rule for 'active', and a hard cap on rows per
//     boot so one bad night never floods the outbox.
//
// The reconciliation behavior itself is pinned in
// packages/db/test/jobs-reconcile.spec.ts (live DB, real rows). What this
// file pins is the WIRING — that the worker actually asks for the
// transcode group, and does so as a separate group rather than by
// widening the singleton list.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_INDEX = join(__dirname, "..", "..", "src", "index.ts");

describe("worker boot reconciliation folds in transcode (C7)", () => {
  const source = readFileSync(WORKER_INDEX, "utf8");

  it("still scopes the SINGLETON list to genuinely-singleton job types", () => {
    const match = /const SINGLETON_GUARDED_JOB_TYPES = \[(.*?)\]/s.exec(source);
    expect(match, "SINGLETON_GUARDED_JOB_TYPES must still exist").not.toBeNull();
    expect(
      match![1],
      "'transcode' must NOT be appended to the singleton list — it is many-concurrent-rows",
    ).not.toMatch(/transcode/);
  });

  it("reconciles 'transcode' as its own group with its own horizons", () => {
    expect(source).toMatch(/RECONCILED_JOB_GROUPS|TRANSCODE_QUEUED_STALE_HORIZON_MS/);
    const groupsCall = /reconcileAbandonedJobLedgerRows\(db, \{[\s\S]*?\}\)/.exec(source);
    expect(groupsCall, "the boot sweep must call reconcileAbandonedJobLedgerRows").not.toBeNull();
    expect(groupsCall![0]).toMatch(/groups:/);
    expect(source).toMatch(/types: \["transcode"\]/);
  });

  it("bounds how many transcode rows one boot may reconcile", () => {
    expect(source).toMatch(/maxRows/);
  });

  it("the transcode queued horizon is a playback-session lifetime, not the 24h singleton horizon", () => {
    const horizon = /const TRANSCODE_QUEUED_STALE_HORIZON_MS = ([^;]+);/.exec(source);
    expect(horizon, "transcode needs its own queued horizon constant").not.toBeNull();
    // eslint-disable-next-line no-eval -- a literal arithmetic expression from this repo's own source
    const value = Number(eval(horizon![1]!));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
