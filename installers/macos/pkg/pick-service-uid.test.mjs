#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/pick-service-uid.test.mjs
//
// THE REAL BUG (rc.6 field audit): pkg/scripts/postinstall's inline UID
// picker filtered CANDIDATES to the service range (<500 && >200) but never
// re-checked the +1 RESULT against that same bound — `dscl . -list /Users
// UniqueID | awk '$1<500 && $1>200' | sort -n | tail -1` followed by
// `NEXT_UID=$((NEXT_UID + 1))` allocated UID 500 (macOS's first HUMAN
// account uid, NOT a service uid) whenever the highest already-used
// candidate in range was 499. Reproduced live: the rc.6 install allocated
// `_loombre` at UID 500.
//
// pkg/scripts/pick-service-uid.sh replaces that one-liner: it scans
// ascending for the first FREE uid strictly inside [201, 499], so the
// result is a member of the allowed range by construction (no separate
// bounds check on the output to ever forget again), and fails loudly
// (nonzero exit, nothing on stdout) if the whole range is exhausted.
//
// This spawns the REAL shipped script (not a reimplementation) with
// synthetic "existing UIDs" on stdin — exactly the shape
// `dscl . -list /Users UniqueID | awk '{print $2}'` produces — so these
// tests exercise the exact bytes that ship in the pkg payload.
//
// Run: node --test installers/macos/pkg/pick-service-uid.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "scripts", "pick-service-uid.sh");

function pick(existingUids) {
  const input = existingUids.length > 0 ? existingUids.join("\n") + "\n" : "";
  return spawnSync(SCRIPT_PATH, [], { input, encoding: "utf8" });
}

test("pick-service-uid.sh ships executable at the path postinstall expects", () => {
  assert.ok(existsSync(SCRIPT_PATH), `missing ${SCRIPT_PATH}`);
  const mode = statSync(SCRIPT_PATH).mode;
  assert.ok(mode & 0o111, "pick-service-uid.sh is not executable (chmod 755 it, same as every other pkg/scripts entry)");
});

test("bash -n / sh -n: pick-service-uid.sh is syntactically valid POSIX sh", () => {
  for (const shell of ["bash", "sh"]) {
    const res = spawnSync(shell, ["-n", SCRIPT_PATH], { encoding: "utf8" });
    assert.equal(res.status, 0, `${shell} -n failed:\n${res.stderr}`);
  }
});

test("fresh system (no existing UIDs in range): picks 201, the historical default", () => {
  const res = pick([]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "201");
});

test("fills the lowest free gap, not (max existing + 1)", () => {
  // 201-210 taken; 211 is the lowest free slot. A "highest + 1" scheme
  // would also produce 211 here by coincidence (contiguous block) — the
  // NEXT test is the one that actually distinguishes the two algorithms.
  const used = [];
  for (let uid = 201; uid <= 210; uid++) used.push(uid);
  const res = pick(used);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "211");
});

test(
  "THE rc.6 REGRESSION CASE: uid 499 already in use (plus scattered lower uids) never produces 500",
  () => {
    // Mirrors the exact field conditions: some existing accounts scattered
    // through the human range below 200 (irrelevant — out of scanned
    // range) plus the service range's TOP boundary (499) already taken.
    // The old `tail -1` + `+1` scheme would compute NEXT_UID = 500 here —
    // macOS's first human-account uid, the exact defect. The new scan
    // finds the lowest FREE slot instead (201, since nothing below 499 is
    // used in this fixture) and never even considers 500 as a candidate
    // (the loop bound is <= 499 by construction).
    const used = [0, 1, 33, 70, 199, 200, 499];
    const res = pick(used);
    assert.equal(res.status, 0, res.stderr);
    const picked = Number(res.stdout.trim());
    assert.equal(picked, 201);
    assert.ok(picked < 500, `picked uid ${picked} is not < 500 — this IS the rc.6 bug`);
    assert.ok(picked > 200, `picked uid ${picked} is not > 200 — outside the intended service range`);
  },
);

test("dense-but-not-full range: skips every used uid and returns the first true gap", () => {
  const used = [];
  for (let uid = 201; uid <= 300; uid++) used.push(uid); // 201-300 solid
  used.push(305); // an isolated used uid past the gap
  const res = pick(used);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "301", "301 is the first free uid after the 201-300 solid block");
});

test("full range exhaustion (201-499 all used): fails loudly, nothing on stdout, exit != 0", () => {
  const used = [];
  for (let uid = 201; uid <= 499; uid++) used.push(uid);
  const res = pick(used);
  assert.notEqual(res.status, 0, "must fail, not silently allocate a uid >= 500");
  assert.equal(res.stdout.trim(), "", "must print nothing on stdout on failure (caller must not misread stderr noise as a uid)");
  assert.match(res.stderr, /no free service UID/i);
});

test(
  "merged-input collision: a uid free in /Users but already taken as a GID in /Groups is skipped, not double-assigned",
  () => {
    // THE SECOND REAL AUDIT FINDING: postinstall assigns the picked value
    // as BOTH _loombre's UniqueID (/Users) AND PrimaryGroupID (/Groups).
    // This script has no dscl access of its own and no per-namespace
    // tagging — it just does a whole-line lookup against whatever its
    // caller pipes in. The fix lives at the CALL SITE (postinstall must
    // pipe in the MERGED `{ dscl . -list /Users UniqueID; dscl . -list
    // /Groups PrimaryGroupID; }` output, not /Users alone) — this test
    // proves that once fed a merged/unlabeled union, the picker's plain
    // `grep -qx` whole-line matching correctly skips a candidate that is
    // ONLY taken in the /Groups namespace, exactly as it would skip one
    // taken in /Users, with no script changes needed.
    const used = [201]; // stands in for a /Groups-only PrimaryGroupID entry
    const res = pick(used);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout.trim(),
      "202",
      "201 must be skipped even though it is only taken as a GID (not a UID) in this merged-input fixture",
    );
  },
);

test("boundary values 200 and 500 are never eligible even if unused", () => {
  // Every uid from 201 up to (but not including) 500 is used EXCEPT the
  // boundaries themselves (200, 500) and 350 — so the only real gap inside
  // the allowed range is 350; if the script were off-by-one in either
  // direction it would instead report 200 or 500 here.
  const used = [];
  for (let uid = 201; uid <= 499; uid++) if (uid !== 350) used.push(uid);
  const res = pick(used);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "350");
});
