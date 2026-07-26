// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/plugins/RegisterPluginWizard.tsx
//
// LPP v1, Lane W5, mission C4: "URL entry -> PREVIEW/confirmation screen
// listing EVERY declared capability + its scope in plain language ->
// config form auto-rendered from configSchema -> event-grant selection ->
// submit -> HMAC secret displayed once (copy affordance + 'this will not
// be shown again') -> health-check result surfaced; on failure offer
// enable-anyway vs cancel."
//
// Step state/validation lives in lib/plugin-wizard-state.ts (pure,
// unit-tested there) — this component is the thin rendering/wiring layer
// over it, same split app/setup/page.tsx keeps with wizard-state.ts.
//
// WIZARD DECISION (stated per the mission brief's instruction to record
// this choice): "cancel" on the result step's failed-health-check branch
// REMOVES the just-registered plugin (an immediate DELETE), rather than
// leaving it disabled. Rationale: LD6's registerPlugin always commits the
// row before this screen can even be reached (health failure is
// non-blocking at the service level — STATE.md LPP Open item), so there is
// no true "abort" available; between "leave a half-configured, disabled,
// unhealthy plugin in the list" and "remove what was just created," the
// latter matches what an admin clicking "cancel" actually expects to
// happen. "Enable anyway" leaves the row exactly as registered (already
// enabled — LD6 commits enabled regardless of health) and simply closes
// the wizard.

"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Modal } from "../Modal.js";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { StatusPill } from "../StatusPill.js";
import { CapabilityCard } from "./CapabilityCard.js";
import { PluginConfigForm } from "./PluginConfigForm.js";
import { EventGrantsEditor } from "./EventGrantsEditor.js";
import { requestedEventTypes, type PluginConfigSchema } from "../../../lib/plugin-manifest.js";
import {
  canProceedFromConfirm,
  deriveResultViewState,
  needsGrantsStep,
  nextStep,
  previousStep,
  validatePluginUrl,
  type StepId,
} from "../../../lib/plugin-wizard-state.js";
import { apiDelete, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./RegisterPluginWizard.module.css";

type PluginManifestPreview = components["schemas"]["PluginManifestPreview"];
type RegisterPluginResponse = components["schemas"]["RegisterPluginResponse"];

/** RFC 9457's `detail` carries the useful, specific message (C2's "this
 *  Loombre doesn't support capability type 'X' yet", the SSRF rejection
 *  reason, ...) — LoombreApiError.message is only the generic `title`
 *  ("Unprocessable Entity"). Falls back to message/a generic string when
 *  the body isn't problem-shaped for some reason. */
function errorDetail(err: unknown, fallback: string): string {
  if (err instanceof LoombreApiError) {
    const problem = err.problem;
    if (typeof problem === "object" && problem !== null && "detail" in problem && typeof (problem as { detail?: unknown }).detail === "string") {
      return (problem as { detail: string }).detail;
    }
    return err.message || fallback;
  }
  return fallback;
}

function parseLanAllowlist(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function RegisterPluginWizard({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState<StepId>("url");

  const [url, setUrl] = useState("");
  const [lanAllowlistText, setLanAllowlistText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [preview, setPreview] = useState<PluginManifestPreview | null>(null);
  const [grantedCapabilityTypes, setGrantedCapabilityTypes] = useState<string[]>([]);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [eventTypeGrants, setEventTypeGrants] = useState<string[]>([]);

  const [registerError, setRegisterError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterPluginResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);

  const lanAllowlist = parseLanAllowlist(lanAllowlistText);

  async function handlePreview(): Promise<void> {
    const validationError = validatePluginUrl(url);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    setUrlError(null);
    setPreviewing(true);
    try {
      const res = await apiPost("/admin/plugins/preview", { body: { url: url.trim(), lanAllowlist } });
      setPreview(res);
      setGrantedCapabilityTypes(res.capabilities.map((c) => c.type));
      setEventTypeGrants([]);
      setStep(nextStep("url"));
    } catch (err) {
      setUrlError(errorDetail(err, "Could not read this plugin's manifest."));
    } finally {
      setPreviewing(false);
    }
  }

  function toggleCapability(type: string, checked: boolean): void {
    setGrantedCapabilityTypes((prev) => (checked ? [...new Set([...prev, type])] : prev.filter((t) => t !== type)));
  }

  async function performRegistration(finalEventGrants: string[], finalConfigValues: Record<string, unknown>): Promise<void> {
    setStep("submitting");
    setRegisterError(null);
    try {
      const res = await apiPost("/admin/plugins", {
        body: {
          url: url.trim(),
          grantedCapabilityTypes,
          eventTypeGrants: finalEventGrants,
          config: finalConfigValues,
          lanAllowlist,
          // C-2 fix wave: pins this registration to the EXACT manifest the
          // confirmation screens above rendered — the server re-fetches
          // and 409s if a plugin served something different to this call
          // than it served to the preview above (manifest TOCTOU fix).
          // exactOptionalPropertyTypes: omit the key entirely rather than
          // set it to `undefined` if preview somehow isn't loaded.
          ...(preview?.manifestDigest !== undefined ? { manifestDigest: preview.manifestDigest } : {}),
        },
      });
      setResult(res);
      setStep("result");
    } catch (err) {
      setRegisterError(errorDetail(err, "Failed to register this plugin."));
      setStep(needsGrantsStep(grantedCapabilityTypes) ? "grants" : "config");
    }
  }

  async function handleEnableAnyway(): Promise<void> {
    onRegistered();
    onClose();
  }

  async function handleRemoveAfterFailedHealth(): Promise<void> {
    if (!result) return;
    setRemoving(true);
    try {
      await apiDelete("/admin/plugins/{id}", { params: { path: { id: result.plugin.id } } });
    } finally {
      setRemoving(false);
      onRegistered();
      onClose();
    }
  }

  async function handleCopySecret(): Promise<void> {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.hmacSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser — the value is still
      // selectable/visible on screen, so this is a nicety, not a blocker.
    }
  }

  return (
    <Modal title="Register a plugin" onClose={onClose}>
      {step === "url" && (
        <div className={styles.step}>
          <p className={styles.helpText}>
            Enter the plugin&apos;s web address. Loombre will read what it declares it can do before anything is
            registered — nothing is saved until you confirm on the next screen.
          </p>
          <div className={styles.lanField}>
            <span className={styles.fieldLabel}>Plugin address</span>
            <TextInput
              placeholder="https://plugins.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div className={styles.lanField}>
            <span className={styles.fieldLabel}>Local network addresses to allow (optional)</span>
            <TextInput
              placeholder="192.168.1.50, plugin-box.local"
              value={lanAllowlistText}
              onChange={(e) => setLanAllowlistText(e.target.value)}
            />
            <p className={styles.helpText}>
              Only needed if this plugin runs on your home network rather than the open internet. List its exact
              address — Loombre refuses to reach private network addresses unless you allow them here by name.
            </p>
          </div>
          {urlError && <p className={styles.errorText}>{urlError}</p>}
          <div className={styles.actions}>
            <span />
            <div className={styles.actionsRight}>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void handlePreview()} disabled={previewing}>
                {previewing ? "Reading manifest…" : "Continue"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === "confirm" && preview && (
        <div className={styles.step}>
          <div className={styles.manifestHeader}>
            <span className={styles.pluginName}>{preview.name}</span>
            <span className={styles.pluginMeta}>
              Version {preview.version} · Published by {preview.publisher}
            </span>
            <p className={styles.helpText}>{preview.description}</p>
          </div>

          <p className={styles.helpText}>
            This plugin has asked to do the following. Turn off anything you don&apos;t want to allow before
            continuing.
          </p>
          <div className={styles.capabilityList}>
            {preview.capabilities.map((capability) => (
              <CapabilityCard
                key={capability.type}
                capability={capability}
                selection={{
                  checked: grantedCapabilityTypes.includes(capability.type),
                  onChange: (checked) => toggleCapability(capability.type, checked),
                }}
              />
            ))}
          </div>

          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(previousStep("confirm"))}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => setStep(nextStep("confirm"))}
              disabled={!canProceedFromConfirm(grantedCapabilityTypes)}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === "config" && preview && (
        <div className={styles.step}>
          <p className={styles.helpText}>Set up this plugin before it&apos;s registered.</p>
          <PluginConfigForm
            schema={preview.configSchema as PluginConfigSchema}
            initialValues={{}}
            requireAllSecrets
            submitLabel={needsGrantsStep(grantedCapabilityTypes) ? "Continue" : "Register"}
            onSubmit={async (values) => {
              setConfigValues(values);
              if (needsGrantsStep(grantedCapabilityTypes)) {
                setStep("grants");
              } else {
                await performRegistration([], values);
              }
            }}
          />
          {registerError && <p className={styles.errorText}>{registerError}</p>}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(previousStep("confirm"))}>
              Back
            </Button>
            <span />
          </div>
        </div>
      )}

      {step === "grants" && preview && (
        <div className={styles.step}>
          <EventGrantsEditor
            requestedEventTypes={requestedEventTypes(preview.capabilities)}
            grantedEventTypes={eventTypeGrants}
            onChange={setEventTypeGrants}
          />
          {registerError && <p className={styles.errorText}>{registerError}</p>}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep("config")}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void performRegistration(eventTypeGrants, configValues)}>
              Register
            </Button>
          </div>
        </div>
      )}

      {step === "submitting" && (
        <div className={styles.step}>
          <p className={styles.spinner}>Registering and running a health check…</p>
        </div>
      )}

      {step === "result" && result && (
        <div className={styles.step}>
          <div className={styles.secretBox}>
            <span className={styles.fieldLabel}>Delivery secret</span>
            <div className={styles.secretValue}>
              <code>{result.hmacSecret}</code>
              <Button variant="ghost" iconOnly onClick={() => void handleCopySecret()} title="Copy">
                <Icon icon={copied ? Check : Copy} size="dense" aria-label="Copy secret" />
              </Button>
            </div>
            <p className={styles.secretWarning}>
              This will not be shown again. Copy it now if this plugin needs it to verify what Loombre sends it.
            </p>
          </div>

          {deriveResultViewState(result.plugin.healthState) === "unhealthy-decision" ? (
            <>
              <div className={styles.healthRow}>
                <StatusPill label="Health check failed" tone="danger" />
              </div>
              <p className={styles.helpText}>
                Loombre registered this plugin, but couldn&apos;t confirm it&apos;s working right now. You can keep
                it registered and try again later, or remove it now.
              </p>
              <div className={styles.actions}>
                <Button variant="ghost" onClick={() => void handleRemoveAfterFailedHealth()} disabled={removing}>
                  {removing ? "Removing…" : "Remove this plugin"}
                </Button>
                <Button variant="primary" onClick={() => void handleEnableAnyway()}>
                  Keep it enabled anyway
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.healthRow}>
                <StatusPill
                  label={deriveResultViewState(result.plugin.healthState) === "healthy" ? "Health check passed" : "Health unknown"}
                  tone={deriveResultViewState(result.plugin.healthState) === "healthy" ? "success" : "info"}
                />
              </div>
              <div className={styles.actions}>
                <span />
                <Button variant="primary" onClick={() => void handleEnableAnyway()}>
                  Done
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
