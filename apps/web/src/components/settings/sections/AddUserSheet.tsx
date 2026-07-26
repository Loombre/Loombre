// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AddUserSheet.tsx
//
// README "+ Add user" flow: "name, role chips MEMBER/RESTRICTED/GUEST,
// restricted-content toggle, Create user" — disabled-looking (45% opacity)
// and inert until a name is entered; selecting RESTRICTED forces the
// restricted-content toggle on; toasts "USER CREATED · INVITE LINK
// COPIED" on success. Built on the shared SheetOrModal primitive.
//
// Ground-truthed deviations from the prototype's literal fields (this
// lane's freeze report has the full table — see UsersSection.tsx's header
// for the role/PIN mismatch already logged there):
//   - CreateUserRequest REQUIRES username, email, and password — none of
//     which the prototype's sheet collects. A user cannot be created with
//     just a name; those three fields are added below (Name maps to
//     displayName, which stays optional). "Create user disabled until
//     named" becomes "disabled until every required field is filled" —
//     the honest version of the same affordance, keeping Name first/
//     prominent per the prototype.
//   - Role chips: MEMBER/RESTRICTED/GUEST -> Member/Admin (2 options,
//     `isAdmin`). GUEST doesn't exist server-side at all; RESTRICTED as a
//     ROLE doesn't either (see UsersSection.tsx's header) — reusing the
//     existing SegmentedControl the codebase already uses for this exact
//     admin y/n choice (apps/web/src/app/admin/users/page.tsx, pre-IA).
//   - Restricted-content toggle "forced on by RESTRICTED role": no admin
//     endpoint sets ANOTHER user's restricted-zone opt-in/PIN at all (only
//     the self-service PUT /users/me/restricted exists) — there is nothing
//     honest to force. Replaced with the one REAL, admin-settable, always-
//     available restriction field on CreateUserRequest: `maxContentRating`
//     (a content-rating ceiling), unconditional — not tied to role,
//     because no real link between the two exists.
//   - Toast copy: "· INVITE LINK COPIED" is dropped — there is no
//     invite-link/magic-link feature anywhere in this codebase (grepped;
//     none). Toasting a capability that doesn't exist would be exactly the
//     fabrication U9 forbids. "USER CREATED" alone is the honest version of
//     the same confirmation, same visual treatment (uppercase mono pill).

import { useState } from "react";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { TextInput } from "../../ui/Input.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useToast } from "../../ui/Toast.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./shared.module.css";

type User = components["schemas"]["User"];

export function AddUserSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (u: User) => void;
}): React.JSX.Element {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [maxContentRating, setMaxContentRating] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = name.trim().length > 0 && username.trim().length > 0 && email.trim().length > 0 && password.length > 0;

  function reset(): void {
    setName("");
    setUsername("");
    setEmail("");
    setPassword("");
    setIsAdmin(false);
    setMaxContentRating("");
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await apiPost("/users", {
        body: { username, email, password, displayName: name, isAdmin, maxContentRating: maxContentRating || null },
      });
      showToast(`USER CREATED — ${user.username.toUpperCase()}`);
      onCreated(user);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to create user.");
      setSubmitting(false);
    }
  }

  return (
    <SheetOrModal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add user"
    >
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex Rivera" required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Username</span>
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Email</span>
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Password</span>
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <div className={styles.formRow}>
          <span className={styles.label}>Role</span>
          <SegmentedControl options={["Member", "Admin"]} defaultValue="Member" onChange={(v) => setIsAdmin(v === "Admin")} />
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Content rating ceiling (optional — blank = no ceiling)</span>
          <TextInput value={maxContentRating} onChange={(e) => setMaxContentRating(e.target.value)} placeholder="e.g. PG-13" />
        </label>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.actions}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
            {submitting ? "Creating…" : "Create user"}
          </Button>
        </div>
      </form>
    </SheetOrModal>
  );
}
