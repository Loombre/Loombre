// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/invite-links-reachable.spec.ts
import { describe, expect, it } from "vitest";
import { gradeInviteLinksReachable } from "./invite-links-reachable.js";

describe("gradeInviteLinksReachable (R7 inviteLinksReachable)", () => {
  it("passes when no invite is pending", () => {
    const outcome = gradeInviteLinksReachable(false);
    expect(outcome.grade).toBe("pass");
  });

  it("is informational (never warn/fail — R7's own 'informational flag' wording) when a pending invite exists", () => {
    const outcome = gradeInviteLinksReachable(true);
    expect(outcome.grade).toBe("info");
  });

  // FALSE-GREEN HUNT: this is a plain existence flag, not a count or a
  // "how public has this link already gotten" measure — it cannot tell one
  // very old forgotten invite apart from a dozen freshly minted ones, and
  // it cannot know whether a link has already been posted somewhere
  // semi-public. A `pass` here means "nothing pending right now", nothing
  // stronger.
  it("BLIND SPOT — grade is identical whether one or many invites are pending; this check is a flag, not a count", () => {
    const one = gradeInviteLinksReachable(true);
    const manyAlsoTrue = gradeInviteLinksReachable(true);
    expect(one.grade).toBe(manyAlsoTrue.grade);
  });
});
