// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/data-freedom/ExportDataCard.tsx
//
// GET /export (docs/PLAN.md §8.4, P12 "data freedom without API
// compatibility") had zero UI anywhere in apps/web — a fully implemented,
// contract-first, e2e-tested backend capability with no button, link, or
// fetch reaching it from the product (77-agent review). POST /import is
// wired, but only inside the first-run setup wizard's RestoreStep.tsx —
// this card is the missing other half of the round-trip: an ongoing,
// reachable-after-setup way to get your own data back out.
//
// authenticated-but-not-admin (apps/server/src/catalog/data-freedom.
// controller.ts's own header: "GET /export stays authenticated-but-not-
// admin — its own admin-only `users` phase is already filtered inside
// packages/db/src/query/export.ts"), so this card is for every signed-in
// user, not gated to admins.
//
// The contract declares the 200 response as `application/json` (an
// ExportArchive), so apiGet("/export") returns the already-parsed object,
// not a stream/Blob — this re-serializes it client-side into a downloadable
// file, the same createObjectURL + <a download> pattern
// apps/web/src/components/admin/system/CrashFilesCard.tsx (D-5, Wave 2 —
// formerly app/admin/system/page.tsx's inline card of the same name,
// extracted+moved in this run) already uses for crash-file downloads.

import { useState } from "react";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { apiGet, LoombreApiError } from "../../lib/api-client.js";
import styles from "./ExportDataCard.module.css";

type Status = "idle" | "downloading" | "done" | "error";

/** ISO-ish, filesystem-safe timestamp — matches the archive's own
 *  `exportedAtMs`, not the client clock, so the filename names the moment
 *  the SERVER built the archive. */
function filenameFor(exportedAtMs: number): string {
  return `loombre-export-${new Date(exportedAtMs).toISOString().replace(/[:.]/g, "-")}.json`;
}

export function ExportDataCard(): React.JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    setStatus("downloading");
    setError(null);
    try {
      const archive = await apiGet("/export");
      const blob = new Blob([JSON.stringify(archive)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFor(archive.exportedAtMs);
      a.click();
      URL.revokeObjectURL(url);
      setStatus("done");
    } catch (err) {
      // rateLimit.export (packages/shared/src/settings-registry.ts) defaults
      // to 5/hour — a bare RFC 9457 title ("Too Many Requests") doesn't say
      // why or what to do about it, so this is the one status worth a
      // bespoke message (same convention as RestrictedProvider.tsx's own
      // 429 case). Every other failure surfaces the server's own message.
      const message =
        err instanceof LoombreApiError
          ? err.status === 429
            ? "Too many exports — you can download up to 5 per hour. Try again later."
            : err.message
          : "Could not download your data.";
      setStatus("error");
      setError(message);
    }
  }

  return (
    <Card>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Download your data</h2>
        <p className={styles.sectionBody}>
          Get an open JSON archive of everything you're entitled to see — libraries, catalog items, watch progress,
          and playlists. No proprietary lock-in: an admin can restore this same file into a fresh, empty instance.
        </p>
        <div className={styles.actions}>
          {status === "error" && error && (
            <span className={styles.status} data-tone="error">
              {error}
            </span>
          )}
          {status === "done" && (
            <span className={styles.status} data-tone="success">
              Downloaded.
            </span>
          )}
          <Button type="button" variant="secondary" onClick={() => void handleDownload()} disabled={status === "downloading"}>
            {status === "downloading" ? "Preparing…" : "Download my data"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
