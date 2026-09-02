// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/DirectoryPicker.tsx
//
// The "Browse" half of a library-path field — used by the Add-library
// dialog (AddLibrarySheet) and by the setup wizard's library step
// (app/setup/_components/LibraryStep.tsx), which is a fully authenticated
// admin by the time it renders and so reaches the same admin-only
// endpoint unchanged.
//
// WHY THIS IS NOT AN <input type="file" webkitdirectory>. A library path
// names a directory on the SERVER's filesystem. The browser can only see
// the machine it is running on, and that is frequently not the server —
// the Docker distribution puts the web UI in a different container
// entirely, and a LAN user administering the server from a laptop is the
// normal case, not an edge case. An OS file dialog would return a path
// that is either meaningless to the server or, worse, coincidentally
// valid and pointing somewhere wrong. So the SERVER enumerates
// (GET /admin/filesystem/directories, admin-only, directory names only)
// and this component walks that listing.
//
// The free-text field it sits beside stays fully functional and is NOT
// replaced: a headless install, a path that only exists inside a
// container, or a mount this host cannot reach all still need typing.
// Browse is an affordance, not a gate.

import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { Button } from "../../ui/Button.js";
import { CommandBlock } from "../../ui/CommandBlock.js";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import styles from "./DirectoryPicker.module.css";

type DirectoryListing = components["schemas"]["DirectoryListing"];
type FilesystemPermissionRemediation = components["schemas"]["FilesystemPermissionRemediation"];

/**
 * Duck-typed, defensive parse of the `remediation` RFC 9457 extension
 * member (packages/contract/openapi.yaml's FilesystemPermissionRemediation)
 * off a caught error's `.problem` (LoombreApiError.problem is `unknown` —
 * packages/sdk/src/client.ts). `remediation` is additive and only present
 * on `code: "filesystem-permission-denied"` on a platform with a scripted
 * grant recipe (macOS + _loombre today) — absent on Linux/dev/container
 * installs, and ANY malformed shape (a future contract change, a proxy
 * stripping extension members, etc.) is treated exactly like absent rather
 * than risking a render crash or a half-filled grant panel: null here means
 * "fall back to the plain `detail` paragraph," never "show something wrong."
 */
function parseRemediation(err: unknown): FilesystemPermissionRemediation | null {
  if (err === null || typeof err !== "object") return null;
  const problem = (err as { problem?: unknown }).problem;
  if (problem === null || typeof problem !== "object") return null;
  if ((problem as { code?: unknown }).code !== "filesystem-permission-denied") return null;

  const remediation = (problem as { remediation?: unknown }).remediation;
  if (remediation === null || typeof remediation !== "object") return null;
  const { summary, commands, verify, note } = remediation as Record<string, unknown>;
  if (typeof summary !== "string" || summary.length === 0) return null;
  if (typeof verify !== "string" || verify.length === 0) return null;
  if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === "string")) {
    return null;
  }
  // `note` is optional (absent = nothing to add beyond summary), but when
  // present it must be a string like everything else here — a malformed
  // member means a malformed body, and the fallback is the whole detail
  // paragraph, not a panel missing one line.
  if (note !== undefined && typeof note !== "string") return null;
  const parsed: FilesystemPermissionRemediation = { summary, commands, verify };
  if (note !== undefined && note.length > 0) parsed.note = note;
  // The native-helper handoff is optional and additive: a value that is not
  // a loombre:// URL is dropped (never navigated to), while the commands —
  // the complete recipe on their own — stay.
  const nativeGrantUrl = (remediation as { nativeGrantUrl?: unknown }).nativeGrantUrl;
  if (typeof nativeGrantUrl === "string" && nativeGrantUrl.startsWith("loombre://")) {
    parsed.nativeGrantUrl = nativeGrantUrl;
  }
  return parsed;
}

/** How long the picker keeps re-checking after "Allow in Loombre" — long
 *  enough to read the consent dialog and click, short enough that a
 *  cancelled dialog doesn't leave a request looping in the background. */
const NATIVE_GRANT_RECHECK_INTERVAL_MS = 1500;
const NATIVE_GRANT_RECHECK_LIMIT = 40;

function openExternalDefault(url: string): void {
  // A custom-scheme navigation from a click handler: the browser asks
  // "Open Loombre.app?" and hands the URL to the app; the page stays put.
  window.location.assign(url);
}

export interface DirectoryPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen absolute path. The caller decides what to do
   *  with it (AddLibrarySheet appends it as a new line). */
  onSelect: (path: string) => void;
  /** Opens the native-helper URL (remediation.nativeGrantUrl). Injectable
   *  because jsdom cannot navigate; defaults to window.location.assign. */
  openExternal?: (url: string) => void;
}

export function DirectoryPicker({
  open,
  onClose,
  onSelect,
  openExternal = openExternalDefault,
}: DirectoryPickerProps): React.JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The path that produced the current `error` — kept so "Check again" (the
  // remediation panel's re-list affordance) can re-run EXACTLY the browse
  // that failed, without the caller having to remember it.
  const [deniedPath, setDeniedPath] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<FilesystemPermissionRemediation | null>(null);
  // True from the "Allow in Loombre" click until the denied path lists
  // successfully (or the re-check budget runs out): the picker re-runs the
  // browse on a timer so the grant made in the native dialog shows up
  // without a further click here.
  const [awaitingNativeGrant, setAwaitingNativeGrant] = useState(false);
  const recheckCount = useRef(0);

  /** `quiet` = a background re-check: leaves the current panel and listing
   *  in place until there is a RESULT, instead of blanking them to a
   *  skeleton on every tick. */
  const load = useCallback((path: string | null, quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
      setRemediation(null);
    }
    // Typed query params, not a hand-built URL: apiGet is generic over the
    // SDK's literal path union, so a template string is not even
    // assignable — which is the generated client doing its job. It also
    // handles the encoding, so a path with spaces or a '#' cannot escape.
    // Omitting `path` entirely = the roots listing.
    apiGet("/admin/filesystem/directories", path === null ? undefined : { params: { query: { path } } })
      .then((next) => {
        setListing(next as DirectoryListing);
        setError(null);
        setRemediation(null);
        setDeniedPath(null);
        setAwaitingNativeGrant(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // The server distinguishes these cases deliberately (422 not
        // absolute, 403 unreadable, 404 missing) and its `detail` says
        // what to do about each — the macOS-installer 403 even names the
        // service account and where media should live instead. Detail-
        // first via apiErrorMessage (V-UX F2/F3): bare err.message is only
        // the problem TITLE, which is how a field tester once stared at
        // the single word "Forbidden". The last good listing deliberately
        // stays up under the error, so a sibling folder remains pickable.
        setError(apiErrorMessage(err, "Could not read that directory."));
        setDeniedPath(path);
        setRemediation(parseRemediation(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!awaitingNativeGrant || deniedPath === null || !open) return;
    recheckCount.current = 0;
    const timer = setInterval(() => {
      recheckCount.current += 1;
      if (recheckCount.current > NATIVE_GRANT_RECHECK_LIMIT) {
        setAwaitingNativeGrant(false);
        return;
      }
      load(deniedPath, true);
    }, NATIVE_GRANT_RECHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [awaitingNativeGrant, deniedPath, open, load]);

  useEffect(() => {
    if (!open) return;
    // Always reopen at the roots rather than wherever the last session
    // ended: a stale deep path that has since been unmounted would open
    // the picker straight into an error.
    load(null);
  }, [open, load]);

  const atRoots = listing?.path === null;

  return (
    <SheetOrModal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      sub="Folders on the machine running Loombre — not on this computer, if they are different."
    >
      <div className={styles.picker}>
        <div className={styles.crumbRow}>
          <code className={styles.currentPath}>{listing?.path ?? "This server"}</code>
          <Button
            type="button"
            variant="ghost"
            onClick={() => load(listing?.parent ?? null)}
            // At a root there is nowhere up to go — the server reports
            // parent:null precisely so this can be disabled rather than
            // navigating to itself.
            disabled={loading || atRoots}
          >
            Up
          </Button>
        </div>

        {error &&
          (remediation ? (
            // The rc.6 field screenshot this replaces: a long red paragraph
            // and nowhere to go from there. summary is the one-line
            // "what's wrong," the CommandBlock is the exact fix pre-filled
            // with the REAL denied path, and "Check again" re-runs the same
            // browse in place so the grant/verify loop stays in-app.
            <div className={styles.grantPanel}>
              <p className={styles.error}>{remediation.summary}</p>
              {/* The server's scope note — what this grant exposes, what it
                  leaves private, and (for the two-step home-folder flow)
                  what comes next — read BEFORE the command it describes. */}
              {remediation.note !== undefined && <p className={styles.grantNote}>{remediation.note}</p>}
              {remediation.nativeGrantUrl !== undefined && (
                // The no-Terminal path: the macOS menubar app runs as the
                // signed-in user, so it can apply this exact grant behind a
                // native consent dialog. The URL only reaches it when this
                // browser is on that Mac — hence the commands stay below as
                // the fallback, and the caption says so.
                <div className={styles.nativeGrant}>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={loading}
                    onClick={() => {
                      setAwaitingNativeGrant(true);
                      openExternal(remediation.nativeGrantUrl!);
                    }}
                  >
                    Allow in Loombre…
                  </Button>
                  <span className={styles.grantHint}>
                    {awaitingNativeGrant
                      ? "Waiting for you to click Allow in the Loombre dialog — re-checking automatically."
                      : "Opens a permission dialog in the Loombre menu bar app (when this browser is on the Mac running Loombre)."}
                  </span>
                </div>
              )}
              <CommandBlock commands={remediation.commands} ariaLabel="Copy permission grant commands" />
              <p className={styles.grantCaption}>
                {remediation.nativeGrantUrl !== undefined ? "Or run this in Terminal, then" : "Run this in Terminal, then"}{" "}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => deniedPath !== null && load(deniedPath)}
                  disabled={loading}
                >
                  Check again
                </Button>
              </p>
              {/* finding 6: `verify` is required by the contract, computed
                  and validated server-side, and was never rendered — a
                  muted one-liner so an operator can prove the grant worked
                  without guessing the command themselves. */}
              <p className={styles.grantVerify}>
                Prove it worked: <code>{remediation.verify}</code>
              </p>
              <p className={styles.grantHint}>
                Prefer not to change permissions? The install guide's media-permissions section lists where media
                can live without any.
              </p>
            </div>
          ) : (
            <p className={styles.error}>{error}</p>
          ))}

        {loading ? (
          <div className={styles.list}>
            <Skeleton radius="md" height={32} />
            <Skeleton radius="md" height={32} />
            <Skeleton radius="md" height={32} />
          </div>
        ) : (
          <ul className={styles.list}>
            {listing?.entries.length === 0 && (
              <li className={styles.empty}>No sub-folders here. You can still choose this folder.</li>
            )}
            {listing?.entries.map((entry) => (
              <li key={entry.path}>
                {/* readable:false = the server itself cannot descend into
                    it (the installers' least-privilege service accounts
                    cannot read personal home folders). Marked and dimmed,
                    NOT hidden or disabled: hiding would misrepresent the
                    filesystem, and clicking is exactly how the server's
                    actionable 403 guidance surfaces. */}
                <button
                  type="button"
                  className={entry.readable ? styles.entry : `${styles.entry} ${styles.entryUnreadable}`}
                  onClick={() => load(entry.path)}
                >
                  <span className={styles.entryName}>{entry.name}</span>
                  {!entry.readable && <span className={styles.noAccessBadge}>No access</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            // Choosing the CURRENT folder, not a highlighted child: a media
            // library is the folder you have navigated into. Disabled at
            // the roots listing, where `path` is null and there is nothing
            // concrete to choose.
            disabled={loading || listing?.path == null}
            onClick={() => {
              if (listing?.path == null) return;
              onSelect(listing.path);
              onClose();
            }}
          >
            Use this folder
          </Button>
        </div>
      </div>
    </SheetOrModal>
  );
}
