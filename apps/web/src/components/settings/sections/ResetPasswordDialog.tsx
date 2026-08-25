// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ResetPasswordDialog.tsx
//
// E3a/M14: RowMenu's "Reset password" action (UsersSection.tsx) — a confirm
// dialog naming the user and stating the real consequences (every session
// the user holds ends; they must set a new password at next sign-in), then
// POST /users/{id}/reset-password's ONE-TIME temporaryPassword reveal
// (same SecretReveal pattern as the invite claim-link reveal — see that
// component's header for why this is shared rather than a third
// hand-rolled copy).
//
// Self-reset honesty (task spec: "Handle the admin-resetting-self case
// honestly"): the endpoint permits it (M14 — "Self-reset ... is permitted —
// they know the consequence"), but it revokes EVERY refresh token the
// target holds, including the admin's own CURRENT session if they reset
// themselves. The confirm copy names this explicitly when `isSelf` — the
// temporary password shown next is then the admin's own only way back in,
// not merely a courtesy value for someone else.
//
// R-F3 (opus adversarial review, fix wave): a self-reset now ALSO requires
// re-proving the admin's current password server-side (a stolen bearer
// token alone must never mint a permanent takeover) — same
// currentPassword/`current-password-invalid` shape ProfileSection/
// ChangePasswordSection/RestrictedSection in AccountSection.tsx already
// use, duplicated locally rather than imported (same per-file convention
// login/page.tsx's own must-change-password re-entry field already
// follows — this codebase does not centralize this one small check).
// Resetting ANOTHER user needs no currentPassword — unaffected.
//
// Same Modal primitive as this file's siblings (EditUserModal/
// LibraryAccessModal in UsersSection.tsx), not SheetOrModal — consistency
// within this one surface, which already established that convention for
// every OTHER RowMenu-triggered dialog here; AddUserSheet's SheetOrModal
// choice is for the sibling create flow, not the pattern every dialog in
// this file follows.

import { useState, type FormEvent } from "react";
import type { components } from "@loombre/sdk";
import { Modal } from "../../admin/Modal.js";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { SecretReveal } from "../../ui/SecretReveal.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./shared.module.css";

type User = components["schemas"]["User"];

function isCurrentPasswordInvalid(err: unknown): boolean {
  if (!(err instanceof LoombreApiError)) return false;
  const problem = err.problem;
  return (
    typeof problem === "object" &&
    problem !== null &&
    "code" in problem &&
    (problem as { code?: unknown }).code === "current-password-invalid"
  );
}

export function ResetPasswordDialog({
  user,
  isSelf,
  onClose,
}: {
  user: User;
  /** True when the target is the admin currently driving this dialog —
   *  see this file's header for why that changes the confirm copy. */
  isSelf: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<"confirm" | "done">("confirm");
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);

  async function handleConfirm(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setCurrentPasswordError(null);
    try {
      const res = await apiPost("/users/{id}/reset-password", {
        params: { path: { id: user.id } },
        ...(isSelf ? { body: { currentPassword } } : {}),
      });
      setTemporaryPassword(res.temporaryPassword);
      setPhase("done");
    } catch (err) {
      if (isCurrentPasswordInvalid(err)) {
        setCurrentPasswordError(apiErrorCopy(err, "Current password is incorrect."));
      } else {
        setError(apiErrorCopy(err, "Failed to reset password."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={phase === "confirm" ? `Reset password — ${user.username}` : "Password reset"} onClose={onClose}>
      {phase === "confirm" ? (
        <form className={styles.form} onSubmit={(e) => void handleConfirm(e)}>
          <p className={styles.note}>
            This generates a random temporary password and immediately signs {user.username} out of every device —
            {` ${user.username} `}
            must set a new password the next time they sign in.
            {isSelf && (
              <>
                {" "}
                <strong>This is your own account</strong> — resetting it signs out your current session too. You
                will need the temporary password shown next to sign back in.
              </>
            )}
          </p>
          {isSelf && (
            <label className={styles.field}>
              <span className={styles.label}>Current password</span>
              <TextInput
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
              {currentPasswordError && <p className={styles.errorText}>{currentPasswordError}</p>}
            </label>
          )}
          {error && <p className={styles.errorText}>{error}</p>}
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={submitting}>
              {submitting ? "Resetting…" : "Reset password"}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.form}>
          <SecretReveal
            label="Temporary password"
            value={temporaryPassword ?? ""}
            warning="This will not be shown again — the user (or you) must change it at next sign-in."
          />
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
