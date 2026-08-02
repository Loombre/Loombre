// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/current-password-invalid.exception.ts
//
// G3 (STATE.md "Current-password re-auth on self-changes"): thrown by the
// shared re-auth check (apps/server/src/common/require-current-password.ts)
// on a well-formed but WRONG `currentPassword`, on either endpoint that
// requires re-authentication (PATCH /users/me when the body carries
// password and/or email; PUT /users/me/restricted always). A DISTINCT
// problem `type`/`code` from ordinary 403s (forbidden() in
// apps/server/src/gateway/problem.exception.ts) — mirrors
// must-change-password.exception.ts's own dedicated-class precedent — so a
// client can route the user to "re-enter your password" rather than a
// generic access-denied message.
//
// ONE fixed detail string, used by BOTH endpoints regardless of which
// field (password/email on updateMe; the PIN/opt-in operation on
// putRestricted) prompted the re-auth check — F2: "the same 403 shape
// regardless of which field was being changed" — a wrong current password
// must never confirm or deny anything about the TARGET value being
// changed (E8 holds through this feature).

import { HttpException, HttpStatus } from "@nestjs/common";

export const CURRENT_PASSWORD_INVALID_PROBLEM_TYPE = "urn:loombre:problem:current-password-invalid";

export const CURRENT_PASSWORD_INVALID_DETAIL = "Current password is incorrect.";

export class CurrentPasswordInvalidException extends HttpException {
  constructor(instance: string) {
    super(
      {
        type: CURRENT_PASSWORD_INVALID_PROBLEM_TYPE,
        title: "Current password is incorrect",
        status: HttpStatus.FORBIDDEN,
        detail: CURRENT_PASSWORD_INVALID_DETAIL,
        instance,
        code: "current-password-invalid",
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
