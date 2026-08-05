// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/invite-links-reachable.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 inviteLinksReachable, S1 lane).
// Pure grading function; the impure "does one exist" half is
// packages/db/src/query/invites.ts's hasUnclaimedInvites.
//
// Deliberately an INFORMATIONAL flag, never warn/fail (R7's own wording:
// "invite links now world-reachable (informational flag)") — a pending
// invite becoming reachable from outside the LAN once a remote-access path
// is enabled is EXPECTED behavior (that is the entire point of an invite
// link), not a misconfiguration; this check exists only so an admin who
// forgot a stale pending invite was outstanding gets a nudge, not an alarm.
//
// FALSE-GREEN HUNT: this check cannot know whether a pending invite's
// link has already been shared somewhere semi-public (a group chat, a
// public forum post) — it only knows the DB row's own claimed/revoked/
// expiry state. It also cannot distinguish "one very old forgotten invite"
// from "a dozen freshly minted ones an admin is actively handing out this
// minute" — hasUnclaimedInvites is a plain existence flag, not a count,
// by design (R7 calls for a flag, not a metric).

import type { PostureCheckOutcome } from "./types.js";

export function gradeInviteLinksReachable(hasUnclaimedInvites: boolean): PostureCheckOutcome {
  if (!hasUnclaimedInvites) {
    return {
      grade: "pass",
      detail: "No invite links are currently pending.",
    };
  }

  return {
    grade: "info",
    detail:
      "One or more invite links are still pending. With a remote-access path enabled, those links become reachable from outside your network too — expected, not a misconfiguration, but worth knowing about.",
  };
}
