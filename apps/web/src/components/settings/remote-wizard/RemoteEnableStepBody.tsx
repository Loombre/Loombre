// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteEnableStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R1/R2/R3, Lane U2's mission item 2) —
// the FIRST of the Remote path's two real steps ("remote-enable" in
// packages/shared's frozen PATH_FLOW_STEPS.remote). Enables the in-process
// WireGuard listener (POST /admin/remote/wireguard/enable), then shows two
// pieces of instructional content BEFORE the enrollment step: the
// official WireGuard app install pointer, and the UDP port-forward
// instruction card (router-cards.ts, parameterized with this instance's
// OWN listen port from the enable response — RG9's default 51820 is only
// a default, never assumed here).
//
// HONEST 501 (WG1/WG2 not landed on this lane's base — verified against
// apps/server/src/remote/remote-wireguard.controller.ts, which is still
// the Wave-0 conforming-501 shell for every wireguard op): both the
// initial status read AND the enable action can 501. Same PathManagementCard
// convention (err.status === 501 -> an honest "not available on this
// build" state, never a generic error).
//
// Idempotent-friendly (RG10 staged validate->stage->commit spirit): reads
// current status on mount so re-entering this step after Remote is
// already enabled (e.g. Back then forward, or a deep link) shows the
// success view directly rather than forcing a redundant enable click.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { buildPortForwardCard, type RouterBrandId } from "@loombre/shared/remote";
import { Button } from "../../ui/Button.js";
import { apiGet, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { RouterBrandPicker, RouterCardPanel } from "./RouterCardView.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./RemoteEnableStepBody.module.css";

type RemoteWireguardStatus = components["schemas"]["RemoteWireguardStatus"];

type Phase = "checking" | "unavailable" | "idle" | "enabling" | "error" | "enabled";

const WIREGUARD_INSTALL_URL = "https://www.wireguard.com/install/";

export function RemoteEnableStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<RemoteWireguardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useState<RouterBrandId>("generic");

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const res = await apiGet("/admin/remote/wireguard/status");
        if (cancelled) return;
        setStatus(res);
        setPhase(res.enabled ? "enabled" : "idle");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof LoombreApiError && err.status === 501) {
          setPhase("unavailable");
        } else {
          setError(apiErrorMessage(err, "Failed to load Loombre Remote status."));
          setPhase("idle");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleEnable(): Promise<void> {
    setPhase("enabling");
    setError(null);
    try {
      const res = await apiPost("/admin/remote/wireguard/enable", {});
      setStatus(res);
      setPhase("enabled");
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 501) {
        setPhase("unavailable");
        return;
      }
      setError(apiErrorMessage(err, "Failed to enable Loombre Remote."));
      setPhase("idle");
    }
  }

  if (phase === "checking") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Enable Loombre Remote</p>
        <p className={styles.body}>Checking current status…</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Enable Loombre Remote</p>
        <p className={styles.unavailable}>Loombre Remote isn't available on this build yet.</p>
        <div className={styles.stepActions}>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (phase === "idle" || phase === "enabling") {
    return (
      <div className={styles.step}>
        <p className={styles.stepTitle}>Enable Loombre Remote</p>
        <p className={styles.body}>
          This turns on Loombre's built-in WireGuard listener — a private network baked into Loombre itself. No
          kernel module, no admin/root access, and it only ever exposes Loombre's own listener, never your whole
          network.
        </p>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.stepActions}>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack} disabled={phase === "enabling"}>
              Back
            </Button>
          )}
          <Button type="button" variant="primary" onClick={() => void handleEnable()} disabled={phase === "enabling"}>
            {phase === "enabling" ? "Enabling…" : "Enable Loombre Remote"}
          </Button>
        </div>
      </div>
    );
  }

  // phase === "enabled"
  const port = status?.listenPort ?? null;

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enable Loombre Remote</p>
      <p className={styles.successText} role="status">
        Loombre Remote is on — listening on UDP port {port}, subnet {status?.subnet}.
      </p>

      <div className={styles.section}>
        <p className={styles.sectionHeading}>1. Install the WireGuard app</p>
        <p className={styles.body}>
          Before enrolling a device, install the official WireGuard app on it — it's free, from the WireGuard
          project itself, for every major platform.
        </p>
        <a href={WIREGUARD_INSTALL_URL} target="_blank" rel="noreferrer noopener" className={styles.link}>
          wireguard.com/install →
        </a>
      </div>

      {port !== null && (
        <div className={styles.section}>
          <p className={styles.sectionHeading}>2. Forward a port on your router (optional, but usually needed)</p>
          <p className={styles.body}>
            For a device to reach Loombre Remote from outside your home network, your router needs to forward UDP
            port {port} to this server. Skip this if every device that will connect is always on the same network as
            this server.
          </p>
          <RouterBrandPicker value={brand} onChange={setBrand} />
          <RouterCardPanel card={buildPortForwardCard(brand, { protocol: "udp", externalPort: port, internalPort: port })} />
        </div>
      )}

      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={() => onStepComplete()}>
          Continue
        </Button>
      </div>
    </div>
  );
}
