// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/RemoteAccessSection.tsx
//
// STATE.md "Loombre Remote ..." (Batch-1 lane U1) — this lane SUPERSEDES
// the honest-placeholder body the prior lane shipped (see git history):
// that version only ever read GET /system/capabilities's static
// `remote-access` flag ("Not yet implemented") and the env-pinned network/
// tls registry cards. Entry state now comes from the real
// GET /admin/remote/state (RG15's DERIVED activePath — no `none` means the
// hero+CTA; any other value means the management view), and the three-path
// wizard (R8) lives INLINE in this same section (RG10) rather than as a
// separate route.
//
// UI DECISIONS FLAGGED (per this lane's report):
//   1. Entry-state layout: hero card + CTA when activePath is 'none';
//      PathManagementCard (name, per-path status, Switch/Disable, the
//      posture-card seam, devices link) when a path is active. The wizard
//      replaces this area entirely while open (RG10: inline, not a modal).
//   2. Disclosure choice: the env-pinned network/tls category cards (real,
//      preserved unchanged) now sit under a collapsed "Advanced network
//      settings" <details> disclosure (LibrariesPanel.tsx's own
//      unmatched-items disclosure is the house pattern) rather than always
//      rendering inline — with the wizard + management view now the
//      section's primary content, the low-level env-pinned rows read as
//      secondary reference material, not something every visit needs open.
//
// Deep links (STATE.md freeze decision 5 — "make
// /settings/remote-access?path=... REAL", posture-model.ts's own
// POSTURE_CHECK_FIX_ACTIONS hrefs): `?path=<PathId>` opens the wizard
// directly; `&step=<PathFlowStepId>` additionally seeks to that step
// (ignored if it isn't a real step of that path). When the requested path
// IS already the active one, deriveEntryStage (frozen, wizard-state.ts)
// resolves that to the posture-handoff stage instead of path-flow — there
// is nothing left to configure, only to review. useSearchParams requires a
// Suspense boundary (search/page.tsx and browse/page.tsx's own established
// convention) — provided locally here so any page that renders this
// section stays correct without its own wrapping.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { components } from "@loombre/sdk";
import { deriveEntryStage, PATH_FLOW_STEPS, type PathFlowStepId, type PathId, type StageId } from "@loombre/shared/remote";
import { SettingsCategoryCard } from "../../admin/settings/SettingsCategoryCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import { RemoteWizard } from "../remote-wizard/RemoteWizard.js";
import { HeroCard } from "../remote-wizard/HeroCard.js";
import { PathManagementCard } from "../remote-wizard/PathManagementCard.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./RemoteAccessSection.module.css";

type RemoteState = components["schemas"]["RemoteState"];

const SELECTABLE_PATHS: readonly PathId[] = ["remote", "tunnel", "direct"];

function parsePathParam(raw: string | null): PathId | null {
  return raw !== null && (SELECTABLE_PATHS as readonly string[]).includes(raw) ? (raw as PathId) : null;
}

function parseStepParam(path: PathId, raw: string | null): PathFlowStepId | undefined {
  if (raw === null) return undefined;
  const steps: readonly string[] = PATH_FLOW_STEPS[path];
  return steps.includes(raw) ? (raw as PathFlowStepId) : undefined;
}

interface WizardSeed {
  initialStage?: StageId | undefined;
  initialPath?: PathId | undefined;
  initialStep?: PathFlowStepId | undefined;
}

function RemoteAccessSectionInner({ heading }: { heading: string | null }): React.JSX.Element {
  const searchParams = useSearchParams();
  const { schema, settings, error: settingsError, refetch: refetchSettings } = useAdminSettingsData();

  const [remoteState, setRemoteState] = useState<RemoteState | null>(null);
  const [stateUnavailable, setStateUnavailable] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSeed, setWizardSeed] = useState<WizardSeed | null>(null);
  const deepLinkHandled = useRef(false);

  async function refetchState(): Promise<void> {
    try {
      const res = await apiGet("/admin/remote/state");
      setRemoteState(res);
      setStateUnavailable(false);
      setStateError(null);
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 501) {
        // Not implemented on this build yet — honest degraded state, NOT
        // an error banner: nothing can be "active" on a server that
        // doesn't support this at all, so the hero/CTA is still the
        // truthful default (HeroCard's `degraded` flag says so explicitly).
        setRemoteState(null);
        setStateUnavailable(true);
        setStateError(null);
      } else {
        setStateError(apiErrorCopy(err, "Failed to load remote-access status."));
      }
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refetchState();
  }, []);

  // Freeze decision 5: resolve the deep link exactly once, against the
  // first settled state read (success OR 501 — either way "loaded" is a
  // real answer to "is the requested path currently active").
  useEffect(() => {
    if (!loaded || deepLinkHandled.current) return;
    deepLinkHandled.current = true;

    const pathParam = parsePathParam(searchParams.get("path"));
    if (!pathParam) return;

    const activePath = remoteState?.activePath ?? "none";
    if (activePath === pathParam) {
      setWizardSeed({ initialStage: deriveEntryStage({ activePath }), initialPath: pathParam });
    } else {
      setWizardSeed({ initialPath: pathParam, initialStep: parseStepParam(pathParam, searchParams.get("step")) });
    }
    setWizardOpen(true);
  }, [loaded]);

  function openWizard(seed: WizardSeed | null): void {
    setWizardSeed(seed);
    setWizardOpen(true);
  }

  function closeWizard(): void {
    setWizardOpen(false);
    setWizardSeed(null);
  }

  const networkEntries = schema?.entries.filter((entry) => entry.category === "network") ?? [];
  const tlsEntries = schema?.entries.filter((entry) => entry.category === "tls") ?? [];
  const valuesByKey = new Map((settings?.settings ?? []).map((s) => [s.key, s] as const));

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      {!loaded ? (
        <Skeleton radius="lg" height={160} />
      ) : wizardOpen ? (
        <RemoteWizard
          initialStage={wizardSeed?.initialStage}
          initialPath={wizardSeed?.initialPath}
          initialStep={wizardSeed?.initialStep}
          onCancel={closeWizard}
          onFinished={() => {
            closeWizard();
            void refetchState();
          }}
        />
      ) : stateError ? (
        <p className={styles.errorText}>{stateError}</p>
      ) : remoteState && remoteState.activePath !== "none" ? (
        <PathManagementCard state={remoteState} onSwitchPath={() => openWizard(null)} onChanged={() => void refetchState()} />
      ) : (
        <HeroCard degraded={stateUnavailable} onStart={() => openWizard(null)} />
      )}

      <details className={styles.advancedDisclosure}>
        <summary className={styles.advancedSummary}>Advanced network settings</summary>
        <div className={styles.advancedBody}>
          <p className={styles.helpText}>
            No "detected reverse proxy" probe or proxy-log token-redaction verification exists on this build —
            omitted rather than shown as a fake confirmation. What IS configurable today is the trust-proxy / CORS /
            TLS environment configuration below (all environment-pinned, never editable from this surface).
          </p>
          {settingsError && <p className={styles.errorText}>{settingsError}</p>}
          {!schema || !settings ? (
            <Skeleton radius="lg" height={160} />
          ) : networkEntries.length > 0 || tlsEntries.length > 0 ? (
            <>
              {networkEntries.length > 0 && (
                <SettingsCategoryCard category="network" entries={networkEntries} valuesByKey={valuesByKey} onChanged={refetchSettings} />
              )}
              {tlsEntries.length > 0 && (
                <SettingsCategoryCard category="tls" entries={tlsEntries} valuesByKey={valuesByKey} onChanged={refetchSettings} />
              )}
            </>
          ) : (
            <p className={styles.helpText}>No network/TLS keys reported by this build.</p>
          )}
        </div>
      </details>
    </div>
  );
}

export function RemoteAccessSection({ heading }: { heading: string | null }): React.JSX.Element {
  return (
    <Suspense fallback={<Skeleton radius="lg" height={160} />}>
      <RemoteAccessSectionInner heading={heading} />
    </Suspense>
  );
}
