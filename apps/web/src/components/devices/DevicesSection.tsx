// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/devices/DevicesSection.tsx
//
// GET /devices, GET/DELETE /devices/{id} (apps/server/src/catalog/
// devices.controller.ts) have existed since Phase 1 — per-device rotating
// refresh tokens with reuse-detection chain revocation (docs/PLAN.md:
// 448-449) — but had no UI anywhere in apps/web, so a user with a lost or
// stolen device had no way to see or revoke it short of direct DB access
// (77-agent review finding, feature-no-ui). This surfaces the existing
// endpoints; no contract, server, or db change needed.
//
// Deliberately its OWN component directory rather than a fourth Card
// inside components/settings/sections/AccountSection.tsx (the obvious
// home — that file's ChangePasswordSection already says "revoke them from
// Devices if you need to"): a concurrent lane owns every file under
// components/settings/**, so this ships as a standalone section + route
// instead of editing a file out of scope. See
// apps/web/src/app/settings/devices/page.tsx's header for where this
// still needs to be wired into the Settings nav.
//
// The caller's OWN device (auth-store's persisted deviceId, set at
// login/refresh — auth-store.ts's TokenPairResponse.deviceId) gets a "This
// device" badge and NO sign-out control here: revoking your own live
// session is Account's existing sign-out flow (authStore.logout(), which
// hits POST /auth/logout for the current device), not a DELETE against a
// list row — orphaning the local token state would leave the tab still
// "logged in" against a refresh token the server just invalidated.
//
// WG3 (STATE.md "Loombre Remote ...", R2 "enrolled devices appear in the
// existing devices list (kind: remote)"): Device.kind is now a REQUIRED
// SDK field ('app' | 'remote', WG2's contract addition) — a row enrolled
// through Loombre Remote (admin-initiated WireGuard enrollment, POST
// /admin/remote/wireguard/devices, never the login path) gets a "Remote"
// badge with a one-line tooltip explainer. Revoke is UNCHANGED for these
// rows: the same DELETE /devices/{id} call as every other device, which
// WG2 wired to also tear down the live WG peer server-side for kind='remote'
// (apps/server/src/catalog/devices.controller.ts) — this component doesn't
// need to know that happened, it just calls the same endpoint it always has.

import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Card } from "../ui/Card.js";
import { Button } from "../ui/Button.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { EmptyState } from "../admin/EmptyState.js";
import { apiDelete, apiGet, LoombreApiError } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import styles from "./DevicesSection.module.css";

type Device = components["schemas"]["Device"];

const PAGE_LIMIT = 50;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function DeviceRow({
  device,
  isCurrent,
  revoking,
  onRevoke,
}: {
  device: Device;
  isCurrent: boolean;
  revoking: boolean;
  onRevoke: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {device.name || "Unnamed device"}
          {isCurrent && <span className={styles.currentBadge}>This device</span>}
          {device.kind === "remote" && (
            <span
              className={styles.remoteBadge}
              title="Enrolled through Loombre Remote (WireGuard) — revoking it also removes its tunnel access."
            >
              Remote
            </span>
          )}
        </span>
        <span className={styles.rowSub}>
          {device.profileId || "unknown profile"} · last seen {formatTime(device.lastSeenAtMs)}
        </span>
      </div>
      {!isCurrent && (
        <Button type="button" variant="danger" onClick={onRevoke} disabled={revoking}>
          {revoking ? "Signing out…" : "Sign out"}
        </Button>
      )}
    </div>
  );
}

export function DevicesSection({ heading }: { heading: string | null }): React.JSX.Element {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const currentDeviceId = getAuthStore().getSnapshot().deviceId;

  function load(reset: boolean): void {
    if (!reset) setLoadingMore(true);
    apiGet("/devices", { params: { query: { limit: PAGE_LIMIT, ...(reset ? {} : cursor ? { cursor } : {}) } } })
      .then((page) => {
        setDevices((prev) => (reset || !prev ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setLoadingMore(false);
      })
      .catch((err) => {
        setError(err instanceof LoombreApiError ? err.message : "Failed to load devices.");
        setLoadingMore(false);
      });
  }

  useEffect(() => {
    // One-time initial load, same shape as admin/sessions/page.tsx's own
    // cursor list — `load` reads `cursor` fresh from state on every call,
    // so "Load more" always sees the current value despite the empty deps.
    load(true);
  }, []);

  async function handleRevoke(device: Device): Promise<void> {
    if (!window.confirm(`Sign out "${device.name || "this device"}"? It will need to log in again.`)) return;
    setRevokingId(device.id);
    setError(null);
    try {
      await apiDelete("/devices/{id}", { params: { path: { id: device.id } } });
      setDevices((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to revoke device.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
      <Card>
        <div className={styles.header}>
          <h2 className={styles.title}>
            Devices{devices !== null && <span className={styles.countMono}> · {devices.length}</span>}
          </h2>
        </div>
        <p className={styles.explainer}>
          Every device holding a valid refresh token for your account. Signing one out immediately revokes its
          refresh token — it will need to log in again.
        </p>

        {error && <p className={styles.errorBanner}>{error}</p>}

        {devices === null ? (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} radius="pill" height={56} />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <EmptyState icon={Smartphone} title="No devices" body="Devices you sign in from will show up here." />
        ) : (
          <>
            <div className={styles.list}>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  isCurrent={device.id === currentDeviceId}
                  revoking={revokingId === device.id}
                  onRevoke={() => void handleRevoke(device)}
                />
              ))}
            </div>
            {hasMore && (
              <div className={styles.loadMoreRow}>
                <Button type="button" variant="secondary" onClick={() => load(false)} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
