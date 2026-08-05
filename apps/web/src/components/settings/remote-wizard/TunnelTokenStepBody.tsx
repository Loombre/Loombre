// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/TunnelTokenStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R4, Lane U2's mission item 3) — the
// Tunnel path's "tunnel-token" step (packages/shared's frozen
// PATH_FLOW_STEPS.tunnel[0]). Masked write-only token input, following
// MailCredentialsCard.tsx's three-state pattern (idle / replacing /
// confirming, adapted here to idle / replacing — nothing to "clear" mid-
// wizard, DELETE /admin/remote/tunnel/token exists for the settled
// management view, not this flow) — the token itself NEVER round-trips
// back through this API (setRemoteTunnelToken's own contract doc: "the
// submitted token is never echoed back").
//
// VALIDATION FEEDBACK (mission: "incl. missing-scopes detail from the
// response"): unlike MailCredentialsCard's failure path (a thrown
// LoombreApiError), setRemoteTunnelToken succeeds with 200 and returns
// `{valid, detail}` — an invalid/under-scoped token is a SOFT result, not
// an exception. `detail` is rendered verbatim (the service performs a
// real, bounded Cloudflare API call to produce it — this step never
// invents its own scope-checking copy).

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { apiGet, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./TunnelTokenStepBody.module.css";

type RemoteTunnelStatus = components["schemas"]["RemoteTunnelStatus"];

type Mode = "loading" | "idle" | "replacing" | "validating";

export function TunnelTokenStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("loading");
  const [status, setStatus] = useState<RemoteTunnelStatus | null>(null);
  const [token, setToken] = useState("");
  const [validationDetail, setValidationDetail] = useState<string | null>(null);
  const [validationOk, setValidationOk] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const res = await apiGet("/admin/remote/tunnel/status");
        if (cancelled) return;
        setStatus(res);
        setMode(res.tokenConfigured ? "idle" : "replacing");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof LoombreApiError ? err.message : "Failed to load tunnel status.");
        setMode("replacing");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    if (token.trim().length === 0) {
      setError("Paste your Cloudflare API token.");
      return;
    }
    setMode("validating");
    setError(null);
    setValidationDetail(null);
    setValidationOk(null);
    try {
      const res = await apiPost("/admin/remote/tunnel/token", { body: { token: token.trim() } });
      setValidationOk(res.valid);
      setValidationDetail(res.detail);
      if (res.valid) {
        setToken("");
        const fresh = await apiGet("/admin/remote/tunnel/status");
        setStatus(fresh);
        setMode("idle");
      } else {
        setMode("replacing");
      }
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to validate this token.");
      setMode("replacing");
    }
  }

  if (mode === "loading") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Connect your Cloudflare account</p>
        <p className={styles.body}>Checking current status…</p>
      </div>
    );
  }

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Connect your Cloudflare account</p>
      <p className={styles.body}>
        Paste a scoped Cloudflare API token — Loombre uses it to create a tunnel and DNS route on your behalf. Create
        one with Cloudflare's own token creation page, scoped to Zone:DNS:Edit and Cloudflare Tunnel:Edit.
      </p>

      {mode === "idle" && status && (
        <div className={styles.idleRow}>
          <span className={styles.statusPill} data-ok={status.tokenConfigured && status.tokenScopesOk !== false}>
            {status.tokenConfigured ? "TOKEN CONFIGURED" : "NOT CONFIGURED"}
          </span>
          {status.tokenSetAtMs !== null && <span className={styles.setAt}>SET {new Date(status.tokenSetAtMs).toLocaleString()}</span>}
          <Button type="button" variant="secondary" onClick={() => setMode("replacing")}>
            Replace token
          </Button>
        </div>
      )}

      {(mode === "replacing" || mode === "validating") && (
        <div className={styles.replaceRow}>
          <TextInput
            type="password"
            placeholder="Cloudflare API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            disabled={mode === "validating"}
          />
          <Button type="button" variant="primary" onClick={() => void handleSave()} disabled={mode === "validating"}>
            {mode === "validating" ? "Validating…" : "Validate & save"}
          </Button>
        </div>
      )}

      {validationOk === false && (
        <p className={styles.errorText} role="alert">
          {validationDetail ?? "This token isn't valid."}
        </p>
      )}
      {error && <p className={styles.errorText}>{error}</p>}

      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={() => onStepComplete()} disabled={!status?.tokenConfigured}>
          Continue
        </Button>
      </div>
    </div>
  );
}
