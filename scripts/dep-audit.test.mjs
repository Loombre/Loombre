// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/dep-audit.test.mjs
//
// Unit tests for scripts/dep-audit.mjs's pure logic — no network, no real
// `pnpm audit` invocation. Mirrors scripts/fetch-embedded-pg.test.mjs's own
// convention exactly (same "not wired into pnpm gate's turbo-scoped test
// step; run directly" posture — this file's own harness IS wired into
// `pnpm gate` a different way: as an actual STEP of gate.mjs, see that
// file's dep-audit entry, which shells out to the real dep-audit.mjs
// against the real allowlist — this test file instead exercises the
// classification logic itself, deterministically, with synthetic fixtures):
//
//   node --test scripts/dep-audit.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAdvisories, loadAllowlist, parseAdvisories } from "./dep-audit.mjs";

function advisory(overrides = {}) {
  return {
    id: "GHSA-aaaa-bbbb-cccc",
    title: "Something bad",
    moduleName: "some-package",
    severity: "high",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    ...overrides,
  };
}

test("parseAdvisories: real pnpm-audit-shaped JSON with two advisories", () => {
  const json = JSON.stringify({
    advisories: {
      "1117015": {
        id: 1117015,
        title: "PostCSS has XSS",
        module_name: "postcss",
        severity: "moderate",
        github_advisory_id: "GHSA-qx2v-qp2m-jg93",
        url: "https://github.com/advisories/GHSA-qx2v-qp2m-jg93",
      },
      "1124066": {
        id: 1124066,
        title: "sharp inherited vulnerabilities",
        module_name: "sharp",
        severity: "high",
        github_advisory_id: "GHSA-f88m-g3jw-g9cj",
        url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
      },
    },
    metadata: { vulnerabilities: { moderate: 1, high: 1, critical: 0, low: 0, info: 0 } },
  });

  const advisories = parseAdvisories(json);
  assert.equal(advisories.length, 2);
  assert.deepEqual(
    advisories.map((a) => a.id).sort(),
    ["GHSA-f88m-g3jw-g9cj", "GHSA-qx2v-qp2m-jg93"],
  );
});

test("parseAdvisories: a clean audit (empty advisories object) parses to zero findings", () => {
  const json = JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { high: 0, critical: 0, moderate: 0, low: 0, info: 0 } } });
  assert.equal(parseAdvisories(json).length, 0);
});

test("parseAdvisories: throws on unparseable JSON (a real pnpm-audit failure, not silently empty)", () => {
  assert.throws(() => parseAdvisories("not json"), /could not parse/);
});

test("parseAdvisories: throws when the JSON has no advisories object at all", () => {
  assert.throws(() => parseAdvisories(JSON.stringify({ foo: "bar" })), /unexpected pnpm audit output shape/);
});

// Regression (2026-09-03): when npm's audit endpoint times out, `pnpm audit
// --json` exits with `{"error":{"code":23,"message":"The operation was
// aborted due to timeout"}}` — a report-shaped failure, not a report. The
// old message ("no advisories object — unexpected pnpm audit output shape")
// hid pnpm's own error and read like a code defect; an operator went
// looking for a deleted file. The gate must STILL fail (an unverified tree
// never reads as clean), but the message must name the real cause and
// carry pnpm's code + message verbatim.
test("parseAdvisories: a pnpm error object (registry/network failure) throws a message that names it and quotes pnpm's code + message", () => {
  const pnpmTimeout = JSON.stringify({ error: { code: 23, message: "The operation was aborted due to timeout" } });
  assert.throws(
    () => parseAdvisories(pnpmTimeout),
    (err) =>
      err instanceof Error &&
      /reported an error instead of an audit report/.test(err.message) &&
      /registry|network/.test(err.message) &&
      /code 23/.test(err.message) &&
      /aborted due to timeout/.test(err.message) &&
      !/unexpected pnpm audit output shape/.test(err.message),
  );
});

test("loadAllowlist: parses a valid allowlist", () => {
  const entries = loadAllowlist(
    JSON.stringify({ entries: [{ advisoryId: "GHSA-xxxx", reason: "test reason", expires: "2099-01-01" }] }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].advisoryId, "GHSA-xxxx");
});

test("loadAllowlist: an empty entries array is valid (the repo's default, real, clean state)", () => {
  assert.deepEqual(loadAllowlist(JSON.stringify({ entries: [] })), []);
});

test("loadAllowlist: throws on non-JSON", () => {
  assert.throws(() => loadAllowlist("{not json"), /not valid JSON/);
});

test("loadAllowlist: throws when entries is missing/not an array", () => {
  assert.throws(() => loadAllowlist(JSON.stringify({})), /must be an object with an "entries" array/);
  assert.throws(() => loadAllowlist(JSON.stringify({ entries: "nope" })), /must be an object with an "entries" array/);
});

for (const missingField of ["advisoryId", "reason", "expires"]) {
  test(`loadAllowlist: throws when an entry is missing "${missingField}"`, () => {
    const entry = { advisoryId: "GHSA-xxxx", reason: "r", expires: "2099-01-01" };
    delete entry[missingField];
    assert.throws(() => loadAllowlist(JSON.stringify({ entries: [entry] })), new RegExp(missingField));
  });
}

test("loadAllowlist: throws on an invalid expires date", () => {
  assert.throws(
    () => loadAllowlist(JSON.stringify({ entries: [{ advisoryId: "GHSA-xxxx", reason: "r", expires: "not-a-date" }] })),
    /not a valid date/,
  );
});

const FIXED_NOW_MS = Date.parse("2026-07-24T12:00:00Z");

test("classifyAdvisories: a high-severity advisory with NO allowlist entry is blocking", () => {
  const result = classifyAdvisories([advisory({ severity: "high" })], [], FIXED_NOW_MS);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.allowlisted.length, 0);
});

test("classifyAdvisories: critical is blocking too", () => {
  const result = classifyAdvisories([advisory({ severity: "critical" })], [], FIXED_NOW_MS);
  assert.equal(result.blocking.length, 1);
});

test("classifyAdvisories: moderate/low/info are non-blocking regardless of allowlist", () => {
  const findings = [advisory({ severity: "moderate" }), advisory({ severity: "low" }), advisory({ severity: "info" })];
  const result = classifyAdvisories(findings, [], FIXED_NOW_MS);
  assert.equal(result.blocking.length, 0);
  assert.equal(result.nonBlocking.length, 3);
});

// Regression: nonBlocking used to receive BARE advisory objects while every
// other bucket received {advisory, entry} wrappers. main()'s reporter
// destructures `{ advisory }` from each bucket uniformly, so a bare entry made
// `advisory` undefined and the whole gate step died with "Cannot read
// properties of undefined (reading 'severity')" — the length assertion above
// passed the entire time because it never looked at an element's SHAPE. Real
// consequence: any repo state carrying a merely-moderate advisory crashed
// dep-audit instead of reporting `[info]` and passing.
test("classifyAdvisories: EVERY bucket yields {advisory, entry} — main()'s reporter destructures them uniformly", () => {
  const allowlist = [{ advisoryId: "GHSA-aaaa-bbbb-cccc", reason: "test", expires: "2099-01-01" }];
  const result = classifyAdvisories(
    [advisory({ severity: "moderate" }), advisory({ severity: "high", id: "GHSA-unallowlisted" }), advisory()],
    allowlist,
    FIXED_NOW_MS,
  );
  for (const [bucket, rows] of Object.entries(result)) {
    for (const row of rows) {
      assert.ok(row.advisory, `${bucket} entry must expose .advisory (got ${JSON.stringify(row)})`);
      assert.equal(typeof row.advisory.severity, "string", `${bucket} entry's .advisory needs a severity`);
      assert.ok("entry" in row, `${bucket} entry must expose .entry (null when there is no allowlist entry)`);
    }
  }
});

test("classifyAdvisories: a high-severity advisory WITH a live (non-expired) allowlist entry is NOT blocking", () => {
  const allowlist = [{ advisoryId: "GHSA-aaaa-bbbb-cccc", reason: "test", expires: "2099-01-01" }];
  const result = classifyAdvisories([advisory()], allowlist, FIXED_NOW_MS);
  assert.equal(result.blocking.length, 0);
  assert.equal(result.allowlisted.length, 1);
});

test("classifyAdvisories: an EXPIRED allowlist entry does NOT exempt the advisory — it blocks again", () => {
  const allowlist = [{ advisoryId: "GHSA-aaaa-bbbb-cccc", reason: "test", expires: "2020-01-01" }];
  const result = classifyAdvisories([advisory()], allowlist, FIXED_NOW_MS);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.expired.length, 1);
  assert.equal(result.allowlisted.length, 0);
});

test("classifyAdvisories: an allowlist entry expiring TODAY (end of day, UTC) still exempts", () => {
  const allowlist = [{ advisoryId: "GHSA-aaaa-bbbb-cccc", reason: "test", expires: "2026-07-24" }];
  const result = classifyAdvisories([advisory()], allowlist, FIXED_NOW_MS);
  assert.equal(result.blocking.length, 0, "expires TODAY means still valid through end of today");
});

test("classifyAdvisories: an allowlist entry that expired YESTERDAY blocks", () => {
  const allowlist = [{ advisoryId: "GHSA-aaaa-bbbb-cccc", reason: "test", expires: "2026-07-23" }];
  const result = classifyAdvisories([advisory()], allowlist, FIXED_NOW_MS);
  assert.equal(result.blocking.length, 1);
});

test("classifyAdvisories: an allowlist entry for a DIFFERENT advisory id doesn't exempt this one", () => {
  const allowlist = [{ advisoryId: "GHSA-different-one", reason: "test", expires: "2099-01-01" }];
  const result = classifyAdvisories([advisory()], allowlist, FIXED_NOW_MS);
  assert.equal(result.blocking.length, 1);
});

test("classifyAdvisories: a clean advisory list (real current repo state) classifies to all-empty", () => {
  const result = classifyAdvisories([], [], FIXED_NOW_MS);
  assert.deepEqual(result, { blocking: [], allowlisted: [], expired: [], nonBlocking: [] });
});
