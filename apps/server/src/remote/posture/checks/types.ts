// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/types.ts
//
// Shared return shape for every pure grading function in this directory
// (STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", R7, S1 lane) — kept in its own file
// rather than re-exported from one of the check modules so none of them
// has to import "past" a sibling for a type both need.

import type { PostureGrade } from "@loombre/shared";

export interface PostureCheckOutcome {
  grade: PostureGrade;
  detail: string;
}
