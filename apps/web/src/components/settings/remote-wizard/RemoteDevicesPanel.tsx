// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteDevicesPanel.tsx
//
// STATE.md "Loombre Remote ..." mission item 3 (lane U3): an ADMIN-scoped
// list of every enrolled Remote (WireGuard) device across every user
// (listRemoteWireguardDevices/revokeRemoteWireguardDevice) — mounted
// inside PathManagementCard.tsx's Remote-specific section, ADDITIVE to
// (not replacing) the existing "Manage enrolled devices →" link to
// /settings/devices, which is the CALLER's own self-service device list
// (GET /devices, DevicesSection.tsx) and stays exactly as U1 built it.
// This panel is a different surface: any admin, any user's devices —
// RG3's admin-scoped revoke, distinct from the self-service one.
//
// WG2 (device_kind enum + kind column + wg_peers, plus the revoke-time
// refresh-token-revocation gap closure RG3 flags) has not landed on this
// base — both operationIds are still Wave-0 501 shells
// (apps/server/src/remote/remote-wireguard.controller.ts). A 501 renders
// as an honest "not available on this build yet" empty state, same
// posture PathManagementCard.tsx's own disable-flow 501 branch already
// established, rather than a generic error banner.
//
// Revoke uses an inline danger-tinted confirm block (ActiveNoticeCard.tsx's
// pattern — U1's own PathManagementCard.tsx disable/switch flows use the
// identical shape) rather than DevicesSection.tsx's window.confirm, per
// the mission brief's explicit preference to match U1's choices here.

import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { apiDelete, apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./RemoteDevicesPanel.module.css";

type RemoteWireguardDevice = components["schemas"]["RemoteWireguardDevice"];

const PAGE_LIMIT = 50;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function DeviceRow({
  device,
  confirming,
  revoking,
  unavailable,
  onConfirm,
  onCancelConfirm,
  onRevoke,
  onDismissUnavailable,
}: {
  device: RemoteWireguardDevice;
  confirming: boolean;
  revoking: boolean;
  unavailable: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onRevoke: () => void;
  onDismissUnavailable: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{device.name}</span>
        <span className={styles.rowSub}>
          User <span className={styles.mono}>{device.userId}</span> · tunnel IP <span className={styles.mono}>{device.tunnelIp}</span>
        </span>
        <span className={styles.rowSub}>
          Enrolled {formatTime(device.createdAtMs)} · last handshake{" "}
          {device.lastHandshakeAtMs === null ? "never" : formatTime(device.lastHandshakeAtMs)}
        </span>
      </div>

      {unavailable ? (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>Revoking isn't available in this build yet.</span>
          <Button type="button" variant="ghost" onClick={onDismissUnavailable}>
            OK
          </Button>
        </div>
      ) : confirming ? (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>Revoke "{device.name}"? It loses access immediately.</span>
          <div className={styles.confirmActions}>
            <Button type="button" variant="danger" onClick={onRevoke} disabled={revoking}>
              {revoking ? "Revoking…" : "Revoke"}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancelConfirm} disabled={revoking}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="danger" onClick={onConfirm}>
          Revoke…
        </Button>
      )}
    </div>
  );
}

export function RemoteDevicesPanel(): React.JSX.Element {
  const [devices, setDevices] = useState<RemoteWireguardDevice[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeUnavailableId, setRevokeUnavailableId] = useState<string | null>(null);

  function load(reset: boolean, nextCursor: string | null): void {
    if (!reset) setLoadingMore(true);
    apiGet("/admin/remote/wireguard/devices", { params: { query: { limit: PAGE_LIMIT, ...(nextCursor ? { cursor: nextCursor } : {}) } } })
      .then((page) => {
        setDevices((prev) => (reset || !prev ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setUnavailable(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof LoombreApiError && err.status === 501) {
          setUnavailable(true);
          setDevices([]);
          return;
        }
        setError(err instanceof LoombreApiError ? err.message : "Failed to load enrolled devices.");
      })
      .finally(() => setLoadingMore(false));
  }

  useEffect(() => {
    // One-time initial load, same convention as DevicesSection.tsx.
    load(true, null);
  }, []);

  async function handleRevoke(device: RemoteWireguardDevice): Promise<void> {
    setRevokingId(device.id);
    setError(null);
    try {
      await apiDelete("/admin/remote/wireguard/devices/{id}", { params: { path: { id: device.id } } });
      setDevices((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));
      setConfirmingId(null);
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 501) {
        setRevokeUnavailableId(device.id);
        setConfirmingId(null);
        return;
      }
      if (err instanceof LoombreApiError && err.status === 404) {
        // Already gone (revoked elsewhere) — the desired end state (this
        // device no longer has access) already holds, so drop it locally
        // rather than surfacing an error for something that's already true.
        setDevices((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));
        setConfirmingId(null);
        return;
      }
      setError(err instanceof LoombreApiError ? err.message : `Failed to revoke "${device.name}".`);
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className={styles.panel} data-testid="remote-devices-panel">
      <p className={styles.label}>Enrolled devices (all users)</p>

      {error && <p className={styles.errorText}>{error}</p>}

      {devices === null ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} radius="pill" height={56} />
          ))}
        </div>
      ) : unavailable ? (
        <EmptyState
          icon={Smartphone}
          title="Not available on this build yet"
          body="Enrolling and managing Remote devices isn't wired up on this server build yet — check back once it ships."
        />
      ) : devices.length === 0 ? (
        <EmptyState icon={Smartphone} title="No enrolled devices" body="Devices enrolled through Loombre Remote will show up here." />
      ) : (
        <>
          <div className={styles.list}>
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                confirming={confirmingId === device.id}
                revoking={revokingId === device.id}
                unavailable={revokeUnavailableId === device.id}
                onConfirm={() => setConfirmingId(device.id)}
                onCancelConfirm={() => setConfirmingId(null)}
                onRevoke={() => void handleRevoke(device)}
                onDismissUnavailable={() => setRevokeUnavailableId(null)}
              />
            ))}
          </div>
          {hasMore && (
            <div className={styles.loadMoreRow}>
              <Button type="button" variant="secondary" onClick={() => load(false, cursor)} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
