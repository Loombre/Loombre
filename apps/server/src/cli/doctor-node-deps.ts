// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/doctor-node-deps.ts
//
// The real (non-fake) DoctorDeps implementation — the only file under
// apps/server/src/cli that touches node:fs/node:child_process directly.
// Kept separate from doctor.ts so every doctor CHECK is a pure function of
// injected dependencies (unit-testable without touching the real
// filesystem or spawning real processes); this file is exercised
// indirectly by the CLI integration test instead.

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { DoctorDeps } from "./doctor.js";

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnVersion(binaryPath: string): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync(binaryPath, ["-version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.error || result.status !== 0) {
      return { ok: false, stdout: "" };
    }
    return { ok: true, stdout: result.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Walks up from `dir` to the nearest existing ancestor and reports whether
 *  THAT directory is writable — never creates anything. */
function checkWritable(dir: string): { exists: boolean; writable: boolean; checkedPath: string } {
  let current = dir;
  // Bounded walk (filesystem roots are reached in well under this many
  // hops on any real path) — avoids an infinite loop if dirname() ever
  // stops shrinking the path for a malformed input.
  for (let i = 0; i < 64; i += 1) {
    try {
      const stat = statSync(current);
      if (stat.isDirectory()) {
        const exists = current === dir;
        try {
          accessSync(current, fsConstants.W_OK);
          return { exists, writable: true, checkedPath: current };
        } catch {
          return { exists, writable: false, checkedPath: current };
        }
      }
    } catch {
      // Doesn't exist — walk up.
    }
    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root
    current = parent;
  }
  return { exists: false, writable: false, checkedPath: dir };
}

export const REAL_DOCTOR_DEPS: DoctorDeps = { isExecutableFile, spawnVersion, checkWritable };
