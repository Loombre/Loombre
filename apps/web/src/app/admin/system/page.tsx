// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/system/page.tsx
//
// Phase 4 deliverable D: System panel. Six cards:
//   1. SystemInfo (version/os/tier/node/uptime)
//   2. CapabilityReport (backends × decode/encode/toneMap matrix, probe
//      age, ffmpeg hash prefix) — null envelope rendered honestly
//   3. Update notice (GET /system/update, verification rendered honestly —
//      'signature-invalid' is a WARNING, not an error)
//   4. Provider keys notice (STATE.md Addendum A, decision AD6/A9 — lane
//      S2): a search of this whole repo at authoring time found NO
//      pre-existing UI element linking to docs/env instructions for TMDB/
//      TVDB keys to "relink" (apps/worker/src/index.ts's own admin-notice
//      is a boot-time console.warn only, never surfaced to any web
//      client) — see this lane's final report. This card is that notice,
//      built fresh, pointing at the Plugins tab of the unified Settings
//      surface, /settings/plugins (Wave 2 lane L1 moved provider-key
//      management there — the definitive place those keys are now
//      configured) rather than at any
//      env-var documentation.
//   5. Crash files (list + monospace content viewer + download button +
//      reveal-in-folder note pointing at the desktop controller apps —
//      this web surface can only display content, not open an OS file
//      browser; that's the tray/menubar apps' job, per apps/server/src/
//      ipc/crash-dir.ts's own header)
//   6. Logs tail (lines selector + auto-refresh TOGGLE that polls — no
//      socket, per the task brief)

import { useEffect, useState } from "react";
import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Card } from "../../../components/ui/Card.js";
import { Button } from "../../../components/ui/Button.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { EmptyState } from "../../../components/admin/EmptyState.js";
import { formatFfmpegHashPrefix, formatProbeAge } from "../../../lib/admin-capability-format.js";
import { formatOsLabel } from "../../../lib/os-label.js";
import { describeUpdateVerification } from "../../../lib/admin-update-notice.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./page.module.css";
import { FolderOpen, KeyRound } from "lucide-react";

type SystemInfo = components["schemas"]["SystemInfo"];
type SystemUpdateInfo = components["schemas"]["SystemUpdateInfo"];
type CapabilityReport = components["schemas"]["CapabilityReport"];
type CrashFile = components["schemas"]["CrashFile"];
type ProviderKeyStatus = components["schemas"]["ProviderKeyStatus"];

function SystemInfoCard(): React.JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/info")
      .then(setInfo)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load system info."));
  }, []);

  return (
    <Card>
      <h2 className={styles.cardTitle}>System</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {!info ? (
        <Skeleton radius="md" height={80} />
      ) : (
        <dl className={styles.factGrid}>
          <dt>Version</dt>
          <dd>{info.version}</dd>
          <dt>OS</dt>
          {/* AUD-A4v4-005: proper-noun label map, not text-transform:
              capitalize — that rendered "Macos". */}
          <dd>{formatOsLabel(info.os)}</dd>
          <dt>Tier</dt>
          <dd>T{info.tier}</dd>
          <dt>Node</dt>
          <dd>{info.nodeVersion ?? "—"}</dd>
          <dt>Uptime</dt>
          <dd>{info.uptimeMs != null ? `${Math.floor(info.uptimeMs / 60_000)} min` : "—"}</dd>
        </dl>
      )}
    </Card>
  );
}

function CapabilitiesCard(): React.JSX.Element {
  const [report, setReport] = useState<CapabilityReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/admin/capabilities")
      .then((res) => setReport(res.report))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load capabilities."));
  }, []);

  return (
    <Card>
      <h2 className={styles.cardTitle}>Verified hardware capabilities</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {report === undefined ? (
        <Skeleton radius="md" height={120} />
      ) : report === null ? (
        <EmptyState
          icon={FolderOpen}
          title="No probe has run yet"
          body="The worker runs a hardware capability self-test at first boot (and on driver/ffmpeg changes). Nothing has been verified yet on this instance."
        />
      ) : (
        <>
          <dl className={styles.factGrid}>
            <dt>Platform</dt>
            <dd>{formatOsLabel(report.platform)}</dd>
            <dt>ffmpeg build</dt>
            <dd title={report.ffmpegBuildHash} className={styles.mono}>
              {formatFfmpegHashPrefix(report.ffmpegBuildHash)}
            </dd>
            <dt>GPU</dt>
            <dd>{report.gpuFingerprint ?? "unknown (best-effort probe failed)"}</dd>
            <dt>Probed</dt>
            <dd>{formatProbeAge(report.verifiedAtMs, Date.now())}</dd>
          </dl>
          <div className={styles.matrixWrap}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Decode</th>
                  <th>Encode</th>
                  <th>Tone-map</th>
                </tr>
              </thead>
              <tbody>
                {report.backends.map((backend) => (
                  <tr key={backend.position}>
                    <td className={styles.backendName}>{backend.name}</td>
                    <td>{backend.decode.length > 0 ? backend.decode.join(", ") : "—"}</td>
                    <td>{backend.encode.length > 0 ? backend.encode.join(", ") : "—"}</td>
                    <td>{backend.toneMap.length > 0 ? backend.toneMap.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function UpdateNoticeCard(): React.JSX.Element {
  const [info, setInfo] = useState<SystemUpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/update")
      .then(setInfo)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load update status."));
  }, []);

  return (
    <Card>
      <h2 className={styles.cardTitle}>Updates</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {!info ? (
        <Skeleton radius="md" height={80} />
      ) : (
        <>
          {(() => {
            const verification = describeUpdateVerification(info.verification);
            return (
              <div className={styles.updateBanner} data-tone={verification.tone}>
                <span className={styles.updateBannerLabel}>{verification.label}</span>
                <p className={styles.updateBannerDetail}>{verification.detail}</p>
              </div>
            );
          })()}
          <dl className={styles.factGrid}>
            <dt>Current version</dt>
            <dd>{info.currentVersion}</dd>
            <dt>Channel</dt>
            <dd>{info.channel}</dd>
            <dt>Latest known</dt>
            <dd>{info.latestVersion ?? "—"}</dd>
            <dt>Update available</dt>
            <dd>{info.updateAvailable ? "Yes" : "No"}</dd>
            <dt>Checked</dt>
            <dd>{info.checkedAtMs != null ? new Date(info.checkedAtMs).toLocaleString() : "never"}</dd>
          </dl>
          {info.notesUrl && (
            <a href={info.notesUrl} target="_blank" rel="noreferrer noopener" className={styles.notesLink}>
              Release notes
            </a>
          )}
        </>
      )}
    </Card>
  );
}

/** STATE.md Addendum A decision A9/AD6: enrichment (posters, overviews,
 *  cast) needs at least one metadata provider key configured (P1.9 — a
 *  keyless scan runs fine but yields 0 provider_ids/images). Reads the
 *  same GET /admin/settings the settings page itself uses (providerKeys),
 *  not a second capability surface — one source for "is a key set". */
function ProviderKeysNoticeCard(): React.JSX.Element | null {
  const [statuses, setStatuses] = useState<ProviderKeyStatus[] | null>(null);

  useEffect(() => {
    apiGet("/admin/settings")
      .then((res) => setStatuses(res.providerKeys))
      .catch(() => setStatuses(null));
  }, []);

  if (statuses === null) return null;
  const anySet = statuses.some((s) => s.set);
  if (anySet) return null;

  return (
    <Card>
      <h2 className={styles.cardTitle}>Metadata provider keys</h2>
      <EmptyState
        icon={KeyRound}
        title="No provider key configured"
        body="TMDB/TVDB enrichment (posters, overviews, cast) is inactive until at least one API key is set — a scan without one still completes, just with no provider metadata or images."
      />
      <Link href="/settings/plugins" className={styles.notesLink}>
        Configure provider keys
      </Link>
    </Card>
  );
}

function CrashFilesCard(): React.JSX.Element {
  const [files, setFiles] = useState<CrashFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/admin/crash-files")
      .then((res) => setFiles(res.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load crash files."));
  }, []);

  function openFile(name: string): void {
    setSelected(name);
    setContent(null);
    apiGet("/admin/crash-files/{name}", { params: { path: { name } } })
      .then((text) => setContent(text))
      .catch((err) => setContent(`Failed to load: ${err instanceof LoombreApiError ? err.message : "unknown error"}`));
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

const LINES_OPTIONS = ["50", "200", "500"];
const AUTO_REFRESH_INTERVAL_MS = 5000;

function LogsTailCard(): React.JSX.Element {
  const [lines, setLines] = useState(200);
  const [source, setSource] = useState<string | null | undefined>(undefined);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(currentLines: number): void {
    apiGet("/admin/logs/tail", { params: { query: { lines: currentLines } } })
      .then((res) => {
        setSource(res.source);
        setLogLines(res.lines);
      })
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load logs."));
  }

  useEffect(() => {
    load(lines);
  }, [lines]);

  // Auto-refresh: POLLS on a fixed interval — no websocket, per the task
  // brief ("logs tail with lines selector + auto-refresh toggle (poll, no
  // socket)").
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => load(lines), AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, lines]);

  return (
    <Card>
      <div className={styles.header}>
        <h2 className={styles.cardTitle}>Log tail</h2>
        <div className={styles.logControls}>
          <SegmentedControl options={LINES_OPTIONS} defaultValue="200" onChange={(v) => setLines(Number.parseInt(v, 10))} />
          <label className={styles.autoRefreshToggle}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
      {source === undefined ? (
        <Skeleton radius="md" height={120} />
      ) : source === null ? (
        <EmptyState
          icon={FolderOpen}
          title="No log file configured"
          body="LOOMBRE_LOG_FILE isn't set on this instance — stdout-only dev setups have nothing to tail here."
        />
      ) : (
        <>
          <p className={styles.helpText}>Source: {source}</p>
          <pre className={styles.logContent}>{logLines.length > 0 ? logLines.join("\n") : "(empty)"}</pre>
        </>
      )}
    </Card>
  );
}

export default function AdminSystemPage(): React.JSX.Element {
  return (
    <div className={styles.grid}>
      <SystemInfoCard />
      <CapabilitiesCard />
      <UpdateNoticeCard />
      <ProviderKeysNoticeCard />
      <CrashFilesCard />
      <LogsTailCard />
    </div>
  );
}
