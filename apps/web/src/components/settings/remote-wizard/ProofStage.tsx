// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/ProofStage.tsx
//
// STATE.md "Loombre Remote ..." (R6, Lane U2's mission item 5) — REPLACES
// U1's whole-component placeholder outright (that file's own header:
// "no QR library exists yet... P1's probe-token endpoints are still 501
// shells on this lane's base"; both are now real — RG8's QrCode component,
// this lane's own build, and P1's remote-probes.controller.ts, already
// landed with real behavior on this lane's base).
//
// FLOW: read the active path's expected public endpoint (GET
// /admin/remote/state) -> mint a one-time probe (POST
// /admin/remote/probes) -> render its QR + URL + the "phone on cellular"
// instruction -> poll GET /admin/remote/probes/{id} (HardwareStep.tsx's
// own setInterval-poll pattern) until arrived/expired -> green success on
// arrival, or per-path diagnosis (diagnosis-guidance.ts, P1's own module —
// the SAME function apps/server/src/remote/diagnose-reachability.ts uses,
// so this UI's guidance text and the server's own `detail` field can never
// drift apart) on expiry, with a WAN-address card (RG11) feeding a fresh
// POST /admin/remote/diagnosis, an honest 15-minute countdown, and a
// re-mint button.
//
// HONEST 501 (found while building this lane, not named in the mission's
// own per-lane brief): GET /admin/remote/state is STILL a Wave-0
// conforming-501 shell on this lane's actual base (apps/server/src/remote/
// remote-state.controller.ts — no lane has replaced it yet, unlike every
// OTHER endpoint this stage touches, which P1 landed real). Without it
// there is no `expectedEndpoint` to mint a probe against, so this stage
// degrades the SAME honest way every other 501-dependent screen in this
// lane does, rather than crashing or fabricating an endpoint.
//
// CGNAT ROUTING (R5: "the wizard offers 'switch to Tunnel' routing on
// cgnat"): `onSwitchToTunnel` is optional so RemoteWizard.tsx can wire it
// (restarting path-flow with path='tunnel') without ProofStage owning any
// stage-navigation concerns beyond its own three callbacks.

import { useEffect, useRef, useState } from "react";
import type { components } from "@loombre/sdk";
import {
  buildWanAddressCard,
  diagnosisGuidance,
  type DiagnosisCode,
  type PathId,
  type RouterBrandId,
} from "@loombre/shared/remote";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { QrCode } from "../../ui/QrCode.js";
import { apiGet, apiPost, LoombreApiError , apiErrorMessage } from "../../../lib/api-client.js";
import { RouterBrandPicker, RouterCardPanel } from "./RouterCardView.js";
import { PATH_LABELS } from "./path-labels.js";
import styles from "./ProofStage.module.css";

type RemoteState = components["schemas"]["RemoteState"];
type RemoteProbeToken = components["schemas"]["RemoteProbeToken"];
type RemoteDiagnosisResult = components["schemas"]["RemoteDiagnosisResult"];

export interface ProofStageProps {
  path: PathId;
  onComplete: () => void;
  onBack: () => void;
  /** R5's CGNAT routing — omitted (button hidden) when the embedding
   *  doesn't offer a path switch (there is always one from RemoteWizard.tsx
   *  today; declared optional so ProofStage stays usable standalone). */
  onSwitchToTunnel?: () => void;
}

type Phase = "loading" | "unavailable" | "noEndpoint" | "minting" | "pending" | "arrived" | "expired";

const POLL_INTERVAL_MS = 4_000;
const COUNTDOWN_TICK_MS = 1_000;

function resolveExpectedEndpoint(path: PathId, state: RemoteState): string | null {
  switch (path) {
    case "remote":
      return state.wireguard.endpointHost;
    case "tunnel":
      return state.tunnel.hostname;
    case "direct":
      return state.direct.domain;
  }
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ProofStage({ path, onComplete, onBack, onSwitchToTunnel }: ProofStageProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [probe, setProbe] = useState<RemoteProbeToken | null>(null);
  const [probeId, setProbeId] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<RemoteDiagnosisResult | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [wanAddress, setWanAddress] = useState("");
  const [wanBrand, setWanBrand] = useState<RouterBrandId>("generic");
  const [diagnosing, setDiagnosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mintedForEndpoint = useRef<string | null>(null);

  // 1. Resolve the active path's expected public endpoint.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const state = await apiGet("/admin/remote/state");
        if (cancelled) return;
        const resolved = resolveExpectedEndpoint(path, state);
        setEndpoint(resolved);
        setPhase(resolved ? "minting" : "noEndpoint");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof LoombreApiError && err.status === 501) {
          setPhase("unavailable");
        } else {
          setError(apiErrorMessage(err, "Failed to read remote-access status."));
          setPhase("noEndpoint");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 2. Mint a probe once an endpoint is known (and again on re-mint, via
  // mintedForEndpoint's ref guard against re-minting on every render).
  useEffect(() => {
    if (phase !== "minting" || endpoint === null) return;
    if (mintedForEndpoint.current === endpoint) return;
    let cancelled = false;
    mintedForEndpoint.current = endpoint;
    async function mint(): Promise<void> {
      try {
        const res = await apiPost("/admin/remote/probes", { body: { expectedEndpoint: endpoint!, path } });
        if (cancelled) return;
        setProbe(res);
        setProbeId(res.id);
        setDiagnosis(null);
        setPhase("pending");
      } catch (err) {
        if (cancelled) return;
        setError(apiErrorMessage(err, "Failed to mint a reachability probe."));
        mintedForEndpoint.current = null;
      }
    }
    void mint();
    return () => {
      cancelled = true;
    };
  }, [phase, endpoint, path]);

  // 3. Poll while pending (HardwareStep.tsx's own setInterval pattern).
  useEffect(() => {
    if (phase !== "pending" || probeId === null) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const res = await apiGet("/admin/remote/probes/{id}", { params: { path: { id: probeId! } } });
        if (cancelled) return;
        if (res.status === "arrived") {
          setPhase("arrived");
        } else if (res.status === "expired") {
          setDiagnosis(res.diagnosis);
          setPhase("expired");
        }
      } catch {
        // Transient poll failures don't abort the flow — the next tick
        // retries; the probe's own server-side expiry is the real backstop.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, probeId]);

  // 4. Live countdown while pending (an honest client clock, no server
  // clock-skew correction — the probe's OWN expiry, confirmed by the poll
  // above, is what actually ends the window; this is display only).
  useEffect(() => {
    if (phase !== "pending") return;
    const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  function handleRemint(): void {
    setProbe(null);
    setProbeId(null);
    setDiagnosis(null);
    setWanAddress("");
    setError(null);
    mintedForEndpoint.current = null;
    setPhase("minting");
  }

  async function handleCheckWanAddress(): Promise<void> {
    if (wanAddress.trim().length === 0 || endpoint === null) return;
    setDiagnosing(true);
    setError(null);
    try {
      const res = await apiPost("/admin/remote/diagnosis", {
        body: { expectedEndpoint: endpoint, wanAddress: wanAddress.trim(), path },
      });
      setDiagnosis(res);
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to run diagnosis."));
    } finally {
      setDiagnosing(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className={styles.stage} role="status">
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.body}>Checking status…</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className={styles.stage} role="status">
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.unavailable}>The reachability check isn't available on this build yet.</p>
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "noEndpoint") {
    return (
      <div className={styles.stage} role="status">
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.body}>
          {PATH_LABELS[path]} doesn't have a public endpoint configured yet — finish the setup steps for this path
          before running the reachability check.
        </p>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "minting") {
    return (
      <div className={styles.stage} role="status">
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.body}>Preparing a one-time reachability check…</p>
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    );
  }

  if (phase === "arrived") {
    return (
      <div className={styles.stage}>
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.successText} role="status">
          It works — your phone reached {PATH_LABELS[path]} from outside your network, end to end.
        </p>
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="button" variant="primary" onClick={onComplete}>
            Continue →
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "expired") {
    const code: DiagnosisCode = diagnosis?.code ?? "unknown";
    const guidance = diagnosisGuidance(path, code);
    const showSwitchToTunnel = code === "cgnat" && path !== "tunnel" && onSwitchToTunnel !== undefined;

    return (
      <div className={styles.stage}>
        <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
        <p className={styles.expiredText} role="status">
          This code expired before your phone reached {PATH_LABELS[path]}.
        </p>
        <p className={styles.body}>{guidance}</p>
        {diagnosis?.detail && <p className={styles.detailText}>{diagnosis.detail}</p>}

        {code !== "cgnat" && (
          <div className={styles.wanSection}>
            <RouterBrandPicker legend="Where's your router's internet address?" value={wanBrand} onChange={setWanBrand} />
            <RouterCardPanel card={buildWanAddressCard(wanBrand)} />
            <div className={styles.wanRow}>
              <TextInput
                placeholder="e.g. 203.0.113.5"
                value={wanAddress}
                onChange={(e) => setWanAddress(e.target.value)}
                disabled={diagnosing}
              />
              <Button type="button" variant="secondary" onClick={() => void handleCheckWanAddress()} disabled={diagnosing}>
                {diagnosing ? "Checking…" : "Check"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          {showSwitchToTunnel && (
            <Button type="button" variant="secondary" onClick={onSwitchToTunnel}>
              Switch to Tunnel
            </Button>
          )}
          <Button type="button" variant="primary" onClick={handleRemint}>
            Mint a new code
          </Button>
        </div>
      </div>
    );
  }

  // phase === "pending"
  const remainingMs = probe ? Math.max(0, probe.expiresAtMs - nowMs) : 0;

  return (
    <div className={styles.stage}>
      <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
      <p className={styles.subtitle}>
        Scan this code with a phone on <strong>cellular data — turn off Wi-Fi first</strong>, not your home network.
        The phone is the real outside test, not a third-party checking service.
      </p>

      <div className={styles.qrRow}>
        {probe && <QrCode value={probe.qrPayload} label={`Reachability proof for ${PATH_LABELS[path]}`} />}
        <div className={styles.qrText}>
          <p className={styles.qrLabel}>Or open this URL directly on your phone:</p>
          <p className={styles.qrUrl}>{probe?.probeUrl}</p>
          <p className={styles.countdown} role="timer">
            Expires in {formatCountdown(remainingMs)}
          </p>
        </div>
      </div>

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="ghost" onClick={handleRemint}>
          Mint a new code
        </Button>
      </div>
    </div>
  );
}
