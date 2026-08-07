// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/CreateInviteSheet.tsx
//
// E2: admin invite-creation flow, built on the SAME SheetOrModal primitive
// AddUserSheet.tsx already uses (the sibling precedent named in the run
// brief). Two steps in one sheet, mirroring RegisterPluginWizard.tsx's own
// form -> result shape:
//   1. "form" — optional username/display-name/email presets, an expiry
//      choice (default 72h per CreateInviteRequest's own default), and a
//      library-grants checklist listing only NON-restricted libraries — a
//      restricted-class library id 422s server-side (E2/M4: "invites can
//      never grant restricted-library access"), so this sheet doesn't even
//      OFFER one; the helper text names that rule rather than letting an
//      admin discover it as a rejected request.
//   2. "reveal" — the ONE-TIME claimUrl/claimToken (M3: "the full link is
//      shown ONCE at creation with a copy button"), via the shared
//      SecretReveal primitive (see that file's header for why it's shared
//      rather than a third hand-rolled copy of RegisterPluginWizard's
//      secretBox).
//
// M9 (public URL + the one sanctioned client-side fallback): CreateInviteResponse.claimUrl
// is publicUrl-derived and may be null when network.publicUrl is unset —
// in that case the web composes `${window.location.origin}/claim/<token>`
// itself. This is NOT a Host-header trust hole: it's the admin's own
// browser reaching this server, client-side, over the exact origin a LAN
// user reached to load this page in the first place — the server-side mail
// templates (E7) never do this; only this one admin-facing reveal does.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { TextInput } from "../../ui/Input.js";
import { Button } from "../../ui/Button.js";
import { SecretReveal } from "../../ui/SecretReveal.js";
import { Select } from "../../ui/Select.js";
import { Tag } from "../../ui/Chip.js";
import { apiGet, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { MEDIA_KIND_LABEL, enumLabel } from "../../../lib/enum-labels.js";
import styles from "./shared.module.css";

type Invite = components["schemas"]["Invite"];
type Library = components["schemas"]["Library"];

interface ExpiryOption {
  label: string;
  ms: number;
}

// Bounds per CreateInviteRequest.expiresInMs: 1h (3_600_000) .. 30d
// (2_592_000_000), default 72h (259_200_000, the E2 default this option
// list's own default entry matches exactly).
const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
  { label: "72 hours (default)", ms: 259_200_000 },
  { label: "7 days", ms: 604_800_000 },
  { label: "30 days", ms: 2_592_000_000 },
];
const DEFAULT_EXPIRY_MS = 259_200_000;

export function CreateInviteSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (invite: Invite) => void;
}): React.JSX.Element {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [expiresInMs, setExpiresInMs] = useState(DEFAULT_EXPIRY_MS);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState<{ invite: Invite; link: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then((page) => setLibraries(page.items.filter((l) => l.contentClass !== "restricted")))
      .catch(() => setLibraries([]));
  }, [open]);

  function reset(): void {
    setUsername("");
    setDisplayName("");
    setEmail("");
    setExpiresInMs(DEFAULT_EXPIRY_MS);
    setSelectedLibraryIds(new Set());
    setError(null);
    setSubmitting(false);
    setReveal(null);
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  function toggleLibrary(id: string): void {
    setSelectedLibraryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // CreateInviteRequest's username/displayName/email are all optional
      // (a preset), non-nullable strings — omitted entirely rather than
      // sent as "" so a blank field never becomes a literal empty preset.
      const body: {
        libraryIds: string[];
        expiresInMs: number;
        username?: string;
        displayName?: string;
        email?: string;
      } = {
        libraryIds: [...selectedLibraryIds],
        expiresInMs,
      };
      if (username.trim()) body.username = username.trim();
      if (displayName.trim()) body.displayName = displayName.trim();
      if (email.trim()) body.email = email.trim();

      const res = await apiPost("/invites", { body });
      // M9: publicUrl-derived claimUrl, or the sanctioned browser-origin
      // fallback when the public URL setting is unset — see this file's
      // header.
      const link = res.claimUrl ?? `${window.location.origin}/claim/${res.claimToken}`;
      setReveal({ invite: res.invite, link });
      onCreated(res.invite);
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to create invite.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetOrModal open={open} onClose={handleClose} title={reveal ? "Invite created" : "Create invite"}>
      {reveal ? (
        <div className={styles.form}>
          <SecretReveal
            label="Invite link"
            value={reveal.link}
            warning="This will not be shown again — copy it now and send it however you like."
          />
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <label className={styles.field}>
            <span className={styles.label}>Username preset (optional)</span>
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Leave blank to let them choose" />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Display name preset (optional)</span>
            <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Email (optional — the invite is sent here when mail is configured)</span>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>Expires</span>
            <Select
              value={expiresInMs}
              onChange={(e) => setExpiresInMs(Number(e.target.value))}
              options={EXPIRY_OPTIONS.map((opt) => ({ value: String(opt.ms), label: opt.label }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Library access</span>
            {/* E2/M4: restricted-class libraries are never offered here —
                the server 422s a restricted-class or unknown library id on
                creation, and invites can never grant admin either (no such
                field exists on this request at all). */}
            <p className={styles.note}>
              Restricted libraries can&apos;t be granted by invite — the server rejects them, and admin role can only
              be granted afterward, by an admin.
            </p>
            {/* AUD-A3b-004: the ordinary loading state renders muted, not in
                the danger/error style — .errorText is reserved for the
                empty-state and real submission errors. */}
            {!libraries ? (
              <p className={styles.explainer}>Loading libraries…</p>
            ) : libraries.length === 0 ? (
              <p className={styles.errorText}>No non-restricted libraries exist yet.</p>
            ) : (
              <div className={styles.userChecklist}>
                {libraries.map((lib) => (
                  <label key={lib.id} className={styles.checklistRow}>
                    <input
                      type="checkbox"
                      checked={selectedLibraryIds.has(lib.id)}
                      onChange={() => toggleLibrary(lib.id)}
                    />
                    <span>{lib.name}</span>
                    <Tag>{enumLabel(MEDIA_KIND_LABEL, lib.mediaKind)}</Tag>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <p className={styles.errorText}>{error}</p>}
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create invite"}
            </Button>
          </div>
        </form>
      )}
    </SheetOrModal>
  );
}
