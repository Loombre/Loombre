// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/CrashFilesCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted verbatim from the
// deleted app/admin/system/page.tsx, now composed on the merged Dashboard
// (app/admin/page.tsx) instead. Same GET /admin/crash-files(+/{name})
// endpoints, same list + monospace content viewer + download button +
// reveal-in-folder note pointing at the desktop controller apps (this web
// surface can only display content, not open an OS file browser — that's
// the tray/menubar apps' job, per apps/server/src/ipc/crash-dir.ts's own
// header).

import { useState } from "react";
import { useEffect } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../EmptyState.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./system-cards.module.css";
import { FolderOpen } from "lucide-react";

type CrashFile = components["schemas"]["CrashFile"];

export function CrashFilesCard(): React.JSX.Element {
  const [files, setFiles] = useState<CrashFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/admin/crash-files")
      .then((res) => setFiles(res.items))
      .catch((err) => setError(apiErrorCopy(err, "Failed to load crash files.")));
  }, []);

  function openFile(name: string): void {
    setSelected(name);
    setContent(null);
    apiGet("/admin/crash-files/{name}", { params: { path: { name } } })
      .then((text) => setContent(text))
      .catch((err) => setContent(`Failed to load: ${apiErrorCopy(err, "unknown error")}`));
  }

  function download(): void {
    if (selected === null || content === null) return;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selected;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <h2 className={styles.cardTitle}>Crash files</h2>
      <p className={styles.helpText}>
        Local-only (D14) — nothing here is ever transmitted anywhere. To open this file's folder in your OS file
        browser, use the desktop tray/menubar app installed alongside this server (its "reveal in folder" action
        talks to a different, local-only surface than this web admin).
      </p>
      {error && <p className={styles.errorText}>{error}</p>}
      {files === null ? (
        <Skeleton radius="md" height={60} />
      ) : files.length === 0 ? (
        <EmptyState icon={FolderOpen} title="No crash files" body="Nothing has crashed on this instance." />
      ) : (
        <div className={styles.crashLayout}>
          <ul className={styles.crashList}>
            {files.map((file) => (
              <li key={file.name}>
                <button
                  type="button"
                  className={styles.crashItem}
                  data-active={file.name === selected}
                  onClick={() => openFile(file.name)}
                >
                  <span className={styles.crashName}>{file.name}</span>
                  <span className={styles.crashMeta}>
                    {(file.sizeBytes / 1024).toFixed(1)} KB · {new Date(file.mtimeMs).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div className={styles.crashViewer}>
              <div className={styles.crashViewerHeader}>
                <span>{selected}</span>
                <Button variant="secondary" onClick={download} disabled={content === null}>
                  Download
                </Button>
              </div>
              <pre className={styles.crashContent}>{content ?? "Loading…"}</pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
