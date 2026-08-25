// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/AdminStep.tsx
//
// POST /setup/first-admin (public, STATE.md P4.10) — the wizard's own
// escape hatch from the admin-creates-users chicken-and-egg. Validation
// mirrors FirstAdminRequest's contract minimums (wizard-state.ts's
// validateAdminForm) client-side; the server re-validates identically and
// is the actual source of truth either way. On success the returned
// TokenPair is applied to the auth store immediately (SDK-typed calls only,
// no hand-rolled fetch) so every step after this one is authenticated.
//
// G10 (STATE.md "Current-password re-auth on self-changes"): `onNext` now
// hands the just-created password back to the page (../page.tsx), which
// threads it to RestrictedStep — PUT /users/me/restricted requires
// currentPassword on every call, and this wizard just proved it seconds
// ago. Threading beats asking the admin to retype a password they typed
// twice already in this same form.

import { useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { getClient } from "../../../lib/api-client.js";
import { apiErrorMessage, isApiProblem } from "../../../lib/api-error-message.js";
import { validateAdminForm, type AdminFormErrors } from "../wizard-state.js";
import styles from "./steps.module.css";

export interface AdminStepProps {
  /** Called with the password just set, so later steps (RestrictedStep)
   *  can prove currentPassword without asking the admin to retype it. */
  onNext: (password: string) => void;
}

export function AdminStep({ onNext }: AdminStepProps): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<AdminFormErrors>({});
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    const fieldErrors = validateAdminForm({ username, email, password });
    const mismatch = password !== confirmPassword ? "Passwords do not match." : null;
    setErrors(fieldErrors);
    setConfirmError(mismatch);
    if (Object.keys(fieldErrors).length > 0 || mismatch) return;

    setSubmitting(true);
    try {
      const result = await getClient().post("/setup/first-admin", {
        body: { username, email, password },
      });
      getAuthStore().applyTokenPair(result.tokens);
      onNext(password);
    } catch (err) {
      if (isApiProblem(err)) {
        setSubmitError(
          err.status === 404
            ? "This instance is already set up — refresh the page to sign in instead."
            : apiErrorMessage(err, "Could not create the administrator account."),
        );
      } else {
        setSubmitError("Could not reach the server. Check the server address and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.step} onSubmit={handleSubmit} noValidate>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={UserPlus} />
      </div>
      <h2 className={styles.subtitle}>Create the admin account</h2>
      <p className={styles.body}>This is the only account this wizard creates for you — you can add more from Admin → Users afterward.</p>

      <label className={styles.field} htmlFor="setup-admin-username">
        <span className={styles.label}>Username</span>
        <TextInput
          id="setup-admin-username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {errors.username && <span className={styles.fieldError}>{errors.username}</span>}
      </label>

      <label className={styles.field} htmlFor="setup-admin-email">
        <span className={styles.label}>Email</span>
        <TextInput
          id="setup-admin-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {errors.email && <span className={styles.fieldError}>{errors.email}</span>}
      </label>

      <label className={styles.field} htmlFor="setup-admin-password">
        <span className={styles.label}>Password</span>
        <TextInput
          id="setup-admin-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {errors.password && <span className={styles.fieldError}>{errors.password}</span>}
      </label>

      <label className={styles.field} htmlFor="setup-admin-confirm-password">
        <span className={styles.label}>Confirm password</span>
        <TextInput
          id="setup-admin-confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        {confirmError && <span className={styles.fieldError}>{confirmError}</span>}
      </label>

      {submitError && <div className={styles.error}>{submitError}</div>}

      <div className={styles.actionsEnd}>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create admin account"}
        </Button>
      </div>
    </form>
  );
}
