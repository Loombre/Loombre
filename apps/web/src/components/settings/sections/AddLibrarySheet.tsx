// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AddLibrarySheet.tsx
//
// README "+ ADD LIBRARY" flow: "path, detected file count, read-only
// reassurance, kind chips, Create & scan." Built on the shared
// SheetOrModal primitive (sheet ≤767.98px / dialog above — W1b/W1a
// reconciled breakpoint), replacing the pre-IA CreateLibraryModal
// (components/admin/Modal.tsx-based) that lived in
// apps/web/src/app/admin/libraries/page.tsx.
//
// Ground-truthed deviations from the prototype's literal 4 fields (this
// lane's freeze report has the full table):
//   - "Detected file count" — NO endpoint exists (no preview/probe route
//     before creation anywhere in the contract) — OMITTED per U9, logged
//     here rather than shown as a fake number.
//   - "Name" is REQUIRED by the real CreateLibraryRequest (packages/
//     contract/openapi.yaml) but isn't one of the prototype's literal
//     fields — added, since a library cannot be created without one.
//   - "Path" (singular) becomes a multi-line paths textarea — the real
//     endpoint accepts an array of paths, and dropping that to a single
//     path would be a real capability regression versus what
//     CreateLibraryModal already shipped.
//   - "Create & scan": real behavior, not just a button label — POST
//     /libraries followed immediately by POST /libraries/{id}/scan
//     (full: false), chaining two existing endpoints. A create failure
//     never attempts the scan call.
//
// browser-admin-F7 (QA 2026-08-21, P2) — the RESTRICTED tail of that
// flow. Creating a content_class='restricted' library deliberately does
// NOT grant its creator anything: packages/db/src/query/libraries.ts
// skips the creator auto-grant for exactly that class (§6.4 gate 4,
// "default-deny, including for admins"), and GET /libraries is
// viewer-scoped, so the new library is invisible to the admin who just
// made it. That server design stays. What was broken was this dialog
// pretending otherwise — it closed on success exactly like a general
// library, the caller spliced the POST response into the list, and the
// next reload deleted the row with no explanation and no way back: the
// permissions editor is fed by the same viewer-scoped list, so an
// ungranted restricted library could not be reached from anywhere in the
// UI. It now stops on an explicit next-step panel that names both
// remaining gates and can issue the PUT /libraries/{id}/permissions the
// design itself calls for (an existence-scoped admin route — it works
// fine on a library the caller cannot yet see).

import { useState } from "react";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { TextInput } from "../../ui/Input.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useToast } from "../../ui/Toast.js";
import { apiGet, apiPost, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./shared.module.css";

type Library = components["schemas"]["Library"];
type MediaKind = components["schemas"]["MediaKind"];

// D-3 (STATE.md W2+W3): the contract's media_kind enum stays lowercase —
// these are DISPLAY labels only, title-cased, never sent to the API as-is.
// Same label-map-at-the-call-site pattern app/setup/_components/
// LibraryStep.tsx already uses for this same enum: SegmentedControl's
// `options` are the display strings; onChange maps back to the real value.
const MEDIA_KIND_LABELS: Record<string, MediaKind> = {
  Movie: "movie",
  TV: "tv",
  Music: "music",
};

export function AddLibrarySheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (lib: Library) => void;
}): React.JSX.Element {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [mediaKind, setMediaKind] = useState<MediaKind>("movie");
  const [restricted, setRestricted] = useState(false);
  const [pathsText, setPathsText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // browser-admin-F7: set only for a restricted creation — the dialog then
  // renders the grant step instead of closing.
  const [created, setCreated] = useState<Library | null>(null);
  const [granting, setGranting] = useState(false);
  const [granted, setGranted] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  const paths = pathsText
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const canSubmit = name.trim().length > 0 && paths.length > 0;

  function reset(): void {
    setName("");
    setMediaKind("movie");
    setRestricted(false);
    setPathsText("");
    setPickerOpen(false);
    setError(null);
    setSubmitting(false);
    setCreated(null);
    setGranting(false);
    setGranted(false);
    setGrantError(null);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const lib = await apiPost("/libraries", {
        body: { name, mediaKind, paths, contentClass: restricted ? "restricted" : "general" },
      });
      // "Create & scan" — real chained behavior, not fabricated: a scan
      // enqueue failure here doesn't undo the library create (same
      // best-effort posture the standalone Scan button always had), it
      // just doesn't get a "scan started" toast.
      try {
        await apiPost("/libraries/{id}/scan", { params: { path: { id: lib.id } }, body: { full: false } });
        showToast(`LIBRARY CREATED · SCAN STARTED — ${lib.name.toUpperCase()}`);
      } catch {
        showToast(`LIBRARY CREATED — ${lib.name.toUpperCase()}`);
      }
      // The caller re-reads GET /libraries off this callback — it is a
      // "the server changed, go look" signal, never the row itself.
      onCreated(lib);
      if (lib.contentClass === "restricted") {
        // Stop here: this library is NOT in the list the caller just
        // re-read, and saying so (with the grant action attached) is the
        // whole fix. Closing would reproduce the appear-then-vanish trap.
        setCreated(lib);
        setSubmitting(false);
        return;
      }
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to create library.");
      setSubmitting(false);
    }
  }

  /** browser-admin-F7: the grant the server's default-deny requires next.
   *  PUT /libraries/{id}/permissions replaces grants only for the userIds
   *  it names (packages/db putLibraryPermissionsAdmin), so submitting the
   *  single self entry cannot disturb anyone else's access — and unlike
   *  GET /libraries it is existence-scoped admin CRUD, so it reaches a
   *  library this admin cannot yet see. */
  async function handleGrantSelf(): Promise<void> {
    if (!created) return;
    setGranting(true);
    setGrantError(null);
    try {
      const me = await apiGet("/users/me");
      await apiPut("/libraries/{id}/permissions", {
        params: { path: { id: created.id } },
        body: { libraryId: created.id, permissions: [{ userId: me.id, granted: true }] },
      });
      setGranted(true);
      // Tell the caller to look again: with gate 4 satisfied the library
      // appears in its list the moment gate 5 (the live unlock) is too.
      onCreated(created);
      showToast(`ACCESS GRANTED — ${created.name.toUpperCase()}`);
    } catch (err) {
      setGrantError(err instanceof LoombreApiError ? err.message : "Failed to grant access.");
    } finally {
      setGranting(false);
    }
  }

  return (
    <SheetOrModal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={created ? "One more step" : "Add library"}
      sub={
        created
          ? `“${created.name}” exists, but restricted libraries stay hidden until you grant yourself access.`
          : "Loombre only reads these paths — scanning never renames, moves, or modifies your source files."
      }
    >
      {created ? (
        <div className={styles.form}>
          <p className={styles.note}>
            Restricted libraries are default-deny — including for the admin who created them. “{created.name}”
            will not appear in your Libraries list until <strong>both</strong> of these are true: you hold an
            explicit grant on it, and restricted content is unlocked on this device (the lock in the header).
          </p>
          {granted ? (
            <p className={styles.note}>
              Access granted. Unlock restricted content to see and manage “{created.name}” here — scanning and
              its other admin actions live on its row once it is visible.
            </p>
          ) : null}
          {grantError && <p className={styles.errorText}>{grantError}</p>}
          <div className={styles.actions}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Close
            </Button>
            {!granted && (
              <Button type="button" variant="primary" onClick={() => void handleGrantSelf()} disabled={granting}>
                {granting ? "Granting…" : "Grant yourself access"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Kind</span>
              <SegmentedControl
                options={Object.keys(MEDIA_KIND_LABELS)}
                defaultValue="Movie"
                onChange={(v) => setMediaKind(MEDIA_KIND_LABELS[v] ?? "movie")}
              />
            </label>
            <div className={styles.field}>
              <div className={styles.pathsHeader}>
                <span className={styles.label} id="library-paths-label">
                  Paths (one per line)
                </span>
                {/* Browse ADDS to the textarea rather than replacing it. A
                    headless install, a path that only exists inside a
                    container, or a mount this browser's host cannot see all
                    still need typing — see DirectoryPicker's header for why an
                    OS file dialog cannot serve this at all. */}
                <Button type="button" variant="ghost" onClick={() => setPickerOpen(true)}>
                  Browse…
                </Button>
              </div>
              <textarea
                className={styles.textarea}
                aria-labelledby="library-paths-label"
                value={pathsText}
                onChange={(e) => setPathsText(e.target.value)}
                // Platform-neutral: the old "/data/movies" is wrong on the
                // Windows install this dialog is most often used on, and a
                // placeholder that cannot be right everywhere should not
                // pretend to be an example.
                placeholder={"One folder per line, e.g.\nD:\\Media\\Movies"}
                rows={3}
                required
              />
            </div>
            <div className={styles.formRow}>
              <span className={styles.label}>Restricted content</span>
              <SegmentedControl options={["General", "Restricted"]} defaultValue="General" onChange={(v) => setRestricted(v === "Restricted")} />
            </div>
            {restricted && (
              <p className={styles.note}>
                Restricted just marks the library — visibility still requires the server capability to be enabled,
                explicit per-user grants, and each user&apos;s own age/opt-in/PIN and live unlock. Requires
                LOOMBRE_RESTRICTED_ENABLED on this instance.
              </p>
            )}
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
                {submitting ? "Creating…" : "Create & scan"}
              </Button>
            </div>
          </form>
          <DirectoryPicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelect={(picked) => {
              // Append as a new line, de-duplicating: a library with the same
              // path twice would have the scanner walk it twice for nothing.
              setPathsText((prev) => {
                const lines = prev.split("\n").map((l) => l.trim()).filter(Boolean);
                if (lines.includes(picked)) return prev;
                return [...lines, picked].join("\n");
              });
            }}
          />
        </>
      )}
    </SheetOrModal>
  );
}
