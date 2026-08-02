// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/UsersSection.tsx
//
// README tab 3 "Users & Profiles": "USERS · n" header, user rows (avatar,
// name, a 🔒 PIN badge for restricted profiles, role, capability chips, a
// ⋯ menu), + Add user, followed by an explainer that enforcement lives in
// the database layer, not the UI. Adapted from the pre-IA
// apps/web/src/app/admin/users/page.tsx (Phase 4 deliverable D) — same
// real endpoints (GET/POST /users, GET/PATCH/DELETE /users/{id}, GET/PUT
// /libraries/{id}/permissions for the Library-access editor). /admin/users
// is now a redirect-only stub to /settings/users (this route).
//
// RESTRICTED role / PIN badge — ground-truthed mismatch (this lane's
// freeze report has the full table; logged here rather than faked):
//   - The real User model has NO role enum at all — only `isAdmin: boolean`
//     (packages/contract/openapi.yaml's User schema). There is no MEMBER/
//     RESTRICTED/GUEST concept server-side; GUEST doesn't exist in any
//     form. The role chip below is therefore Member/Admin (2 options,
//     mapping directly to isAdmin), not the prototype's 3.
//   - There is no admin-visible signal for another user's restricted-zone
//     opt-in/PIN at all: `restrictedOptIn`/`hasPin` are exposed ONLY via
//     the self-service GET /users/me/settings and PUT /users/me/restricted
//     (no admin endpoint reads another user's restricted state) — so the
//     🔒 PIN badge is OMITTED, not faked from data this surface can't see.
//   - What IS real and admin-settable, and the closest existing analog to
//     "this is a restricted profile": `maxContentRating` — "Admin-set
//     ceiling on servable content rating (e.g. a kid profile capped at
//     PG)" per the schema's own description. Rendered as a rating-ceiling
//     chip when set; this is what the row shows in place of the PIN badge.
//   - "Capability chips" beyond role/rating ceiling: no further per-user
//     capability data exists in the User schema. Per-library access grants
//     DO exist (library_permissions) but require an N-fetch-per-user cost
//     to show inline for a whole list — kept as the existing on-demand
//     "Library access" modal action instead (unchanged since the pre-IA
//     page), not a row-level chip.
//
// Lane D additions (Optional Mail Transport + Invitation and Reset Flows
// run, STATE.md): two backend-frozen surfaces land in THIS file/area per
// the run brief's own layout call ("extend UsersSection or a sibling
// card — your layout call, record it"):
//   - RowMenu gains "Reset password" (E3a/M14) -> ResetPasswordDialog.tsx,
//     a sibling file exactly like AddUserSheet.tsx already is.
//   - The invites surface (E2) is InvitesPanel.tsx, a SIBLING CARD rendered
//     below the user list rather than folded into this component — this
//     file was already ~300 lines covering create/edit/library-access/
//     delete; a fourth flow (create-invite/reveal/list/revoke) belongs in
//     its own file for the same reason AddUserSheet already is one.
//   - Email is now OPTIONAL everywhere it appears here (E4/M1): the
//     row sub-line, EditUserModal, and AddUserSheet all handle a null
//     email honestly instead of assuming one always exists.

import { useEffect, useState } from "react";
import { Users as UsersIcon } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { Avatar } from "../../ui/Card.js";
import { TextInput } from "../../ui/Input.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Tag } from "../../ui/Chip.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Modal } from "../../admin/Modal.js";
import { RowMenu } from "../RowMenu.js";
import { AddUserSheet } from "./AddUserSheet.js";
import { ResetPasswordDialog } from "./ResetPasswordDialog.js";
import { InvitesPanel } from "./InvitesPanel.js";
import { apiDelete, apiGet, apiPatch, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./shared.module.css";

type User = components["schemas"]["User"];
type Library = components["schemas"]["Library"];

function EditUserModal({ user, onClose, onUpdated }: { user: User; onClose: () => void; onUpdated: (u: User) => void }): React.JSX.Element {
  const [email, setEmail] = useState(user.email ?? "");
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [maxContentRating, setMaxContentRating] = useState(user.maxContentRating ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await apiPatch("/users/{id}", {
        params: { path: { id: user.id } },
        body: { email: email || null, isAdmin, maxContentRating: maxContentRating || null },
      });
      onUpdated(updated);
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to update user.");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Edit "${user.username}"`} onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          <span className={styles.label}>Email (optional)</span>
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <div className={styles.formRow}>
          <span className={styles.label}>Role</span>
          <SegmentedControl key={isAdmin ? "y" : "n"} options={["Member", "Admin"]} defaultValue={isAdmin ? "Admin" : "Member"} onChange={(v) => setIsAdmin(v === "Admin")} />
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Content rating ceiling (blank = no ceiling)</span>
          <TextInput value={maxContentRating} onChange={(e) => setMaxContentRating(e.target.value)} placeholder="e.g. PG-13" />
        </label>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LibraryAccessModal({ user, onClose }: { user: User; onClose: () => void }): React.JSX.Element {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then(async (page) => {
        setLibraries(page.items);
        const sets = await Promise.all(page.items.map((lib) => apiGet("/libraries/{id}/permissions", { params: { path: { id: lib.id } } })));
        const grantedIds = new Set<string>();
        sets.forEach((set, i) => {
          if (set.permissions.some((p) => p.userId === user.id && p.granted)) grantedIds.add(page.items[i]!.id);
        });
        setGranted(grantedIds);
      })
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load library access."));
  }, [user.id]);

  async function toggle(lib: Library): Promise<void> {
    const nextGranted = !granted.has(lib.id);
    setSaving((prev) => new Set(prev).add(lib.id));
    setError(null);
    try {
      await apiPut("/libraries/{id}/permissions", {
        params: { path: { id: lib.id } },
        body: { libraryId: lib.id, permissions: [{ userId: user.id, granted: nextGranted }] },
      });
      setGranted((prev) => {
        const next = new Set(prev);
        if (nextGranted) next.add(lib.id);
        else next.delete(lib.id);
        return next;
      });
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to update access.");
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(lib.id);
        return next;
      });
    }
  }

  const hasRestricted = libraries?.some((l) => l.contentClass === "restricted") ?? false;

  return (
    <Modal title={`Library access — ${user.username}`} onClose={onClose}>
      {hasRestricted && (
        <p className={styles.note}>
          Restricted libraries below follow the five-gate model (docs/PLAN.md §6.4): checking one grants ONLY gate 4.
          {` ${user.username} `}still needs the server&apos;s restricted capability enabled, to meet the age
          requirement, to opt in with their own PIN, and a live session unlock before anything restricted actually
          plays for them.
        </p>
      )}
      {error && <p className={styles.errorText}>{error}</p>}
      {!libraries ? (
        <div className={styles.userChecklist} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="sm" height={32} />
          ))}
        </div>
      ) : (
        <div className={styles.userChecklist}>
          {libraries.map((lib) => (
            <label key={lib.id} className={styles.checklistRow}>
              <input type="checkbox" checked={granted.has(lib.id)} disabled={saving.has(lib.id)} onChange={() => void toggle(lib)} />
              <span>{lib.name}</span>
              <Tag>{lib.mediaKind}</Tag>
              {lib.contentClass === "restricted" && <Tag>restricted</Tag>}
            </label>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

function UserRow({
  user,
  onEdit,
  onLibraryAccess,
  onResetPassword,
  onDelete,
}: {
  user: User;
  onEdit: () => void;
  onLibraryAccess: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const name = user.displayName ?? user.username;
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <Avatar label={name} size={36} />
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{name}</span>
          {/* E4/M1: email is now nullable — a username-only account has
              nothing to show here. Render the username as the sub-line
              fallback instead of an empty/undefined string, rather than a
              blank line where the email used to always be. */}
          <span className={styles.rowSub}>{user.email ?? (name !== user.username ? user.username : "No email on file")}</span>
        </div>
      </div>
      <div className={styles.rowChips}>
        <Tag>{user.isAdmin ? "admin" : "member"}</Tag>
        {user.maxContentRating && <Tag>≤ {user.maxContentRating}</Tag>}
      </div>
      <div className={styles.rowEnd}>
        <RowMenu
          label={`Manage ${user.username}`}
          actions={[
            { label: "Library access", onSelect: onLibraryAccess },
            { label: "Edit", onSelect: onEdit },
            { label: "Reset password", onSelect: onResetPassword },
            { label: "Delete", onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

export function UsersSection({ heading }: { heading: string | null }): React.JSX.Element {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [managingAccess, setManagingAccess] = useState<User | null>(null);
  const [resettingPassword, setResettingPassword] = useState<User | null>(null);
  // E3a/M14: threaded into ResetPasswordDialog so it can name the
  // admin-resetting-self case honestly (see that component's header) —
  // fetched once, not stored on every User row.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  function reload(): void {
    apiGet("/users", { params: { query: { limit: 200 } } })
      .then((page) => setUsers(page.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load users."));
  }

  useEffect(reload, []);
  useEffect(() => {
    apiGet("/users/me")
      .then((me) => setCurrentUserId(me.id))
      .catch(() => undefined);
  }, []);

  async function handleDelete(user: User): Promise<void> {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await apiDelete("/users/{id}", { params: { path: { id: user.id } } });
      setUsers((prev) => (prev ? prev.filter((u) => u.id !== user.id) : prev));
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to delete user.");
    }
  }

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <div className={styles.header}>
        <h2 className={styles.title}>
          Users{users !== null && <span className={styles.countMono}> · {users.length}</span>}
        </h2>
        {/* H16 (W3 fidelity audit): solid accent pill in the header row
            (dc:753's `+ Add user` button), not the dashed add-tile —
            that treatment stays reserved for "+ ADD LIBRARY" (dc:803),
            its actual prototype meaning. */}
        <Button type="button" variant="primary" onClick={() => setAdding(true)}>
          + Add user
        </Button>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}

      {users === null ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="md" height={56} />
          ))}
        </div>
      ) : users.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No users" body="Create the first user to get started." />
      ) : (
        <div className={styles.list}>
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              onEdit={() => setEditing(user)}
              onLibraryAccess={() => setManagingAccess(user)}
              onResetPassword={() => setResettingPassword(user)}
              onDelete={() => void handleDelete(user)}
            />
          ))}
        </div>
      )}

      <p className={styles.explainer}>
        Restricted-content enforcement is in the database query layer, not the UI (packages/db/query&apos;s
        ViewerContext guard) — nothing rendered here is the security boundary.
      </p>

      <AddUserSheet open={adding} onClose={() => setAdding(false)} onCreated={(u) => setUsers((prev) => (prev ? [u, ...prev] : [u]))} />

      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onUpdated={(u) => setUsers((prev) => (prev ? prev.map((x) => (x.id === u.id ? u : x)) : prev))}
        />
      )}
      {managingAccess && <LibraryAccessModal user={managingAccess} onClose={() => setManagingAccess(null)} />}
      {resettingPassword && (
        <ResetPasswordDialog
          user={resettingPassword}
          isSelf={currentUserId !== null && currentUserId === resettingPassword.id}
          onClose={() => setResettingPassword(null)}
        />
      )}

      <InvitesPanel />
    </div>
  );
}
