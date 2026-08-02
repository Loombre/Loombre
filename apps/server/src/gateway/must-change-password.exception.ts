// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/must-change-password.exception.ts
//
// E3a/M14 (STATE.md "Optional mail transport + invitation & reset flows"):
// thrown by AuthGuard (apps/server/src/gateway/auth.guard.ts) for a
// well-authenticated request against a user whose `must_change_password`
// flag is set, on any route OUTSIDE the small allow-list (auth login/
// refresh/logout, GET /users/me, PATCH /users/me). A DISTINCT problem
// `type`/`code` from ordinary 403s (forbidden() in
// apps/server/src/gateway/problem.exception.ts) — mirrors
// unauthenticated.exception.ts's own dedicated-class precedent — so a
// client can tell "you don't have permission" apart from "you must change
// your password before doing anything else" and route the user to the
// right screen instead of a generic access-denied message.

import { HttpException, HttpStatus } from "@nestjs/common";

export const MUST_CHANGE_PASSWORD_PROBLEM_TYPE = "urn:loombre:problem:password-change-required";

export class MustChangePasswordException extends HttpException {
  constructor(instance: string) {
    super(
      {
        type: MUST_CHANGE_PASSWORD_PROBLEM_TYPE,
        title: "Password change required",
        status: HttpStatus.FORBIDDEN,
        detail:
          "A temporary password was set on this account. Change it (PATCH /users/me) before doing anything else.",
        instance,
        code: "password-change-required",
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
