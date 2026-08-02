// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/InvitesPanel.tsx
//
// E2: the admin invites surface — sibling card to UsersSection (this
// lane's layout call, recorded in UsersSection.tsx's header and this run's
// freeze report), rendered below the user list at /settings/users. Create
// flow lives in CreateInviteSheet.tsx; this file is the list + per-row
// revoke.
//
// Visibility call (task spec: "the revoked/claimed rows visible or
// filtered — your call, record it"): ALL statuses are shown, not just
// pending. An admin who just revoked or an invite that got claimed is
// exactly the confirmation they're looking for a moment later, and hiding
// history here would just move the question to "did that actually work" —
// there's no separate audit surface for invites elsewhere in this app.
// Each row's status chip (pending/claimed/revoked/expired) makes the state
// unambiguous, and only "pending" rows offer Revoke — GET /invites already
// paginates (cursor/limit), so this scales the same way every other list
// in this surface does.

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { CreateInviteSheet } from "./CreateInviteSheet.js";
import { describeInviteStatus } from "../../../lib/admin-status.js";
import { apiDelete, apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./shared.module.css";
import inviteStyles from "./InvitesPanel.module.css";

type Invite = components["schemas"]["Invite"];

function presetSummary(invite: Invite): string {
  const parts: string[] = [];
  if (invite.usernamePreset) parts.push(invite.usernamePreset);
  if (invite.displayNamePreset && invite.displayNamePreset !== invite.usernamePreset) parts.push(invite.displayNamePreset);
  if (invite.email) parts.push(invite.email);
  return parts.length > 0 ? parts.join(" · ") : "No presets — the claimant chooses everything";
}

function InviteRow({ invite, onRevoked }: { invite: Invite; onRevoked: (id: string) => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusInfo = describeInviteStatus(invite.status);

  async function handleRevoke(): Promise<void> {
    setRevoking(true);
    setError(null);
    try {
      await apiDelete("/invites/{id}", { params: { path: { id: invite.id } } });
      // `confirming` is THIS ROW's own local state — onRevoked updates the
      // PARENT's invite list (a new `status: "revoked"` prop lands here on
      // the next render), but without also clearing `confirming` the row
      // would keep rendering the confirm block forever, stuck out of sync
      // with its own now-current status. Found by this file's own test.
      setConfirming(false);
      setRevoking(false);
      onRevoked(invite.id);
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to revoke invite.");
      setRevoking(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className={inviteStyles.confirmBlock}>
        <span className={inviteStyles.confirmText}>Revoke the invite for {presetSummary(invite)}? This cannot be undone.</span>
        <div className={inviteStyles.confirmActions}>
          <Button type="button" variant="danger" onClick={() => void handleRevoke()} disabled={revoking}>
            {revoking ? "Revoking…" : "Revoke"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={revoking}>
            Cancel
          </Button>
        </div>
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{presetSummary(invite)}</span>
          <span className={styles.rowSub}>
            Created {new Date(invite.createdAtMs).toLocaleString()} · Expires {new Date(invite.expiresAtMs).toLocaleString()}
          </span>
        </div>
      </div>
      <div className={styles.rowChips}>
        <StatusPill label={statusInfo.label} tone={statusInfo.tone} />
      </div>
      <div className={styles.rowEnd}>
        {invite.status === "pending" && (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}

export function InvitesPanel(): React.JSX.Element {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function reload(): void {
    apiGet("/invites", { params: { query: { limit: 200 } } })
      .then((page) => setInvites(page.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load invites."));
  }

  useEffect(reload, []);

  return (
    <div className={inviteStyles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          Invites{invites !== null && <span className={styles.countMono}> · {invites.length}</span>}
        </h2>
        <Button type="button" variant="primary" onClick={() => setCreating(true)}>
          + Create invite
        </Button>
      </div>

      <p className={styles.explainer}>
        Anyone with an invite link can create their own account with the presets and library grants you choose here —
        an invite can never grant admin role or restricted-library access (E2). Mail is optional: with nothing
        configured, copy the link and send it however you like.
      </p>

      {error && <p className={styles.errorBanner}>{error}</p>}

      {invites === null ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} radius="md" height={56} />
          ))}
        </div>
      ) : invites.length === 0 ? (
        <EmptyState icon={Mail} title="No invites yet" body="Create an invite link to bring in a new user." />
      ) : (
        <div className={styles.list}>
          {invites.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              onRevoked={(id) => setInvites((prev) => (prev ? prev.map((i) => (i.id === id ? { ...i, status: "revoked", revokedAtMs: Date.now() } : i)) : prev))}
            />
          ))}
        </div>
      )}

      <CreateInviteSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(invite) => setInvites((prev) => (prev ? [invite, ...prev] : [invite]))}
      />
    </div>
  );
}
