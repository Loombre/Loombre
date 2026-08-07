// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ServerPowerCard.tsx
//
// The /settings/server "Power" card: Restart server + Shut down server,
// wired to POST /system/restart and /system/shutdown (contract
// restartServer/shutdownServer — admin-only; the server flushes the 202
// BEFORE beginning its graceful teardown). Both actions gate behind the
// Phosphor danger-tinted confirm block (ProviderKeysCard precedent —
// design/phosphor/README.md "Remove requires a confirm step in a
// danger-tinted block").
//
// Restart afterwards POLLS /healthz (public liveness stub, deliberately
// NOT via apiGet — its reactive-401 retry has no meaning against a
// process that is down, and no auth is needed) and only claims "back
// online" after seeing the server DOWN at least once first — a green
// poll before the old process died proves nothing (lying-Saved law,
// applied to a lifecycle claim). Shutdown ends in a terminal notice: this
// web app cannot start a stopped server (the API that would do it just
// went away — the same IPC_SERVER_START_SEMANTICS reality the desktop
// controllers route around via launchd/SCM), so the copy points at the
// platform affordances instead of pretending.
//
// The one refusal this card can receive: 409
// `shutdown-unsupported-under-container-supervision` (Docker's
// unless-stopped restarts on any exit, so an in-process shutdown cannot
// keep the container down) — rendered verbatim from the problem detail.
//
// W14 / D-8 (locked): the two idle-row actions are same-size, ellipsis-free
// buttons, not the mismatched "Restart server…" / "Shut down server…" pair
// from the owner screenshot — sizing is a shared .powerButton min-width
// (module CSS), variants are `warning` (Restart — cautionary, reversible)
// and `danger` (Shut down — destructive). The confirm-block buttons below
// (Restart / Shut down inside .confirmActions) are unchanged: still
// `danger`, still their own existing copy and flow.

import { useEffect, useState } from "react";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import styles from "./ServerPowerCard.module.css";

export const RESTART_POLL_INTERVAL_MS = 1500;
const RESTART_DEADLINE_MS = 120_000;

type Phase =
  | "idle"
  | "confirmRestart"
  | "confirmShutdown"
  | "requestingRestart"
  | "requestingShutdown"
  | "restarting"
  | "restarted"
  | "restartTimeout"
  | "shutdownRequested";

function problemDetail(err: unknown): string | null {
  if (!(err instanceof LoombreApiError)) return null;
  const problem = err.problem;
  if (typeof problem === "object" && problem !== null && "detail" in problem) {
    const detail = (problem as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return null;
}

export function ServerPowerCard(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function requestRestart(): Promise<void> {
    setPhase("requestingRestart");
    setError(null);
    try {
      await apiPost("/system/restart", {});
      setPhase("restarting");
    } catch (err) {
      // InvitesPanel regression class: show the error AND return to an
      // actionable state — never a stuck progress block.
      setError(problemDetail(err) ?? "Could not restart the server.");
      setPhase("idle");
    }
  }

  async function requestShutdown(): Promise<void> {
    setPhase("requestingShutdown");
    setError(null);
    try {
      await apiPost("/system/shutdown", {});
      setPhase("shutdownRequested");
    } catch (err) {
      setError(problemDetail(err) ?? "Could not shut down the server.");
      setPhase("idle");
    }
  }

  // The post-restart reachability poll (HardwareStep's cancelled-flag
  // pattern). No immediate first poll: at t=0 the OLD process may still
  // be answering — a success only counts after at least one observed
  // failure ("down"), so the first check waits one interval out.
  useEffect(() => {
    if (phase !== "restarting") return;
    const base = getAuthStore().getSnapshot().serverUrl.replace(/\/$/, "");
    let cancelled = false;
    let sawDown = false;
    const startedAtMs = Date.now();
    async function isUp(): Promise<boolean> {
      try {
        const res = await fetch(`${base}/healthz`, { cache: "no-store" });
        return res.ok;
      } catch {
        return false;
      }
    }
    async function poll(): Promise<void> {
      const up = await isUp();
      if (cancelled) return;
      if (!up) {
        sawDown = true;
      } else if (sawDown) {
        setPhase("restarted");
        return;
      }
      if (Date.now() - startedAtMs > RESTART_DEADLINE_MS) {
        setPhase("restartTimeout");
      }
    }
    const timer = setInterval(() => void poll(), RESTART_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase]);

  return (
    <Card>
      <h2 className={styles.cardTitle}>Power</h2>

      {error && <p className={styles.errorText}>{error}</p>}

      {phase === "idle" && (
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>Restart server</span>
              <span className={styles.rowCaption}>
                Stops and starts the server process. Settings apply immediately when saved — restart is for changes
                made outside these screens, updates, and troubleshooting. Anything streaming is interrupted for a few
                seconds.
              </span>
            </div>
            <Button variant="warning" className={styles.powerButton} onClick={() => setPhase("confirmRestart")}>
              Restart server
            </Button>
          </div>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>Shut down server</span>
              <span className={styles.rowCaption}>
                Stops the server until it is started again from this machine. Streaming stops for every device, and
                this web app stops working.
              </span>
            </div>
            <Button variant="danger" className={styles.powerButton} onClick={() => setPhase("confirmShutdown")}>
              Shut down server
            </Button>
          </div>
        </div>
      )}

      {phase === "confirmRestart" && (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>
            Restart the server? Anyone streaming right now will be interrupted for a few seconds while it comes back.
          </span>
          <div className={styles.confirmActions}>
            <Button variant="danger" onClick={() => void requestRestart()}>
              Restart
            </Button>
            <Button variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === "confirmShutdown" && (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>
            Shut down the server? Streaming stops for every device, and this web app stops working until the server is
            started again — from the Loombre menu bar app (macOS), the tray app (Windows), or your service manager. On
            Docker installs, use <code>docker compose stop</code> instead.
          </span>
          <div className={styles.confirmActions}>
            <Button variant="danger" onClick={() => void requestShutdown()}>
              Shut down
            </Button>
            <Button variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {(phase === "requestingRestart" || phase === "requestingShutdown") && (
        <p className={styles.statusText}>Sending…</p>
      )}

      {phase === "restarting" && (
        <p className={styles.statusText} role="status">
          Restarting the server… this page will report when it is back. First restarts after an update can take a
          little longer.
        </p>
      )}

      {phase === "restarted" && (
        <div className={styles.statusRow} role="status">
          <p className={styles.statusText}>The server is back online.</p>
          <Button variant="secondary" onClick={() => setPhase("idle")}>
            OK
          </Button>
        </div>
      )}

      {phase === "restartTimeout" && (
        <div className={styles.statusRow} role="status">
          <p className={styles.statusText}>
            Still waiting on the server — it has not come back within two minutes. Check the service logs, or start it
            from the menu bar / tray / service manager.
          </p>
          <Button variant="secondary" onClick={() => setPhase("idle")}>
            OK
          </Button>
        </div>
      )}

      {phase === "shutdownRequested" && (
        <p className={styles.statusText} role="status">
          The server is shutting down. This page will stop working until the server is started again — from the
          Loombre menu bar app (macOS), the tray app (Windows), or your service manager (for example{" "}
          <code>sudo systemctl start loombre-server</code> on Linux).
        </p>
      )}
    </Card>
  );
}
