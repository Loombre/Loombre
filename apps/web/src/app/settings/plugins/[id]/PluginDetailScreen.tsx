// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/plugins/[id]/PluginDetailScreen.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin Plugin
// detail screen — manifest summary (every declared capability + its
// household-register scope line, same CapabilityCard the registration
// wizard's confirmation screen uses), config edit (PluginConfigForm, same
// auto-rendered widget renderer, requireAllSecrets=false so a blank secret
// field leaves the existing keyring value alone), the event-grant editor
// (only shown when event-subscriber is among this plugin's granted
// capabilities), enable/disable, the refresh -> scope-diff -> re-approval
// flow, HMAC rotation (once-display, same secret-box pattern the wizard's
// result step uses), remove (window.confirm), the delivery-status panel,
// and the pseudonymization toggle — MOVED here from
// apps/web/src/app/admin/plugins/[id]/page.tsx (Dashboard -> Plugins tab),
// content otherwise UNCHANGED. Settings -> Plugins (app/settings/plugins/
// page.tsx, components/settings/sections/RegisteredPluginsPanel.tsx) is now
// the ONE surface for both LPP plugin registration and metadata provider
// keys — the admin Dashboard's separate "Plugins" tab is retired
// (components/admin/AdminNav.tsx). /admin/plugins/[id] is now a
// redirect-only stub to this route, preserving the id (same pattern
// app/admin/libraries/page.tsx already uses for the list-level redirect).
//
// Split out of page.tsx (Next rejects any export beyond default/
// route-config on a page.tsx — same reason app/claim/[token]/page.tsx
// delegates to a sibling ClaimScreen.tsx) so page.test.tsx can exercise
// this screen — including its admin-only guard below — with a plain `id`
// prop instead of driving page.tsx's `use(params)` Suspense unwrapping.
//
// This route sits one level BELOW the "plugins" settings tab (an item
// detail, not a section) — same posture as an item detail page hanging off
// a library tab — so unlike app/settings/plugins/page.tsx it does NOT
// render through SettingsShell (no tab strip): AppShell + SettingsPageLayout
// directly, matching admin/layout.tsx's own "AppShell + SettingsPageLayout,
// no full shell chrome" composition for the same reason. A plain "←
// Plugins" text link (PlaybackSection.tsx's "Advanced Server →" cross-link
// precedent) replaces the "still on the Plugins tab of AdminNav" affordance
// that came for free under /admin/*; components/shell/mobile-header.ts
// gets the equivalent back-chevron mapping for mobile.
//
// AUTHZ (verified, not assumed — LD-8's own instruction): every OTHER
// /settings/<key> route's admin-only UX guard comes from rendering through
// SettingsShell.tsx (isAdmin===false -> redirect /profile), and every
// /admin/* route's comes from app/admin/layout.tsx (isAdmin===false ->
// redirect /home) — this route renders through NEITHER (see above), so
// without its own guard a non-admin who navigated straight here would hit
// no client-side redirect at all (GET /admin/plugins/{id} would still
// 403 server-side — the REAL boundary, apps/server/test/
// settings-authz.e2e.spec.ts — but every sibling page also redirects
// before that response even lands, and this one silently wouldn't). Fixed
// via the SAME shared useAdminGuard hook (apps/web/src/lib/
// use-admin-guard.ts — opus-review LD wave, Finding 6, factored out of
// this file's own original inline copy of SettingsShell.tsx's check) —
// redirect-to-/profile, matching the "/settings* always bounces a
// non-admin to /profile" invariant section-registry.ts's header documents
// for the rest of this URL space. AppShell is mounted UNCONDITIONALLY
// (below), with only the guarded content itself withheld until isAdmin
// resolves true — the same "chrome renders during the check, never a
// blank viewport" shape app/admin/layout.tsx already uses, rather than
// this route's own earlier `return null` while resolving.
//
// Live updates: subscribes to the same 6 ADMIN_ONLY plugin.* events as the
// list panel and refetches — a second open admin tab always converges.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { SettingsPageLayout } from "../../../../components/settings/SettingsPageLayout.js";
import { Card } from "../../../../components/ui/Card.js";
import { Button } from "../../../../components/ui/Button.js";
import { Toggle } from "../../../../components/ui/Toggle.js";
import { Icon } from "../../../../components/icon/Icon.js";
import { Skeleton } from "../../../../components/skeleton/Skeleton.js";
import { StatusPill } from "../../../../components/admin/StatusPill.js";
import { CapabilityCard } from "../../../../components/admin/plugins/CapabilityCard.js";
import { PluginConfigForm } from "../../../../components/admin/plugins/PluginConfigForm.js";
import { EventGrantsEditor } from "../../../../components/admin/plugins/EventGrantsEditor.js";
import {
  describePluginStatus,
  requestedEventTypes,
  type PluginCapability,
  type PluginConfigSchema,
} from "../../../../lib/plugin-manifest.js";
import { describeDeliveryStatus, NEVER_DELIVERED_HEADLINE } from "../../../../lib/plugin-delivery-status.js";
import { apiDelete, apiGet, apiPost, apiPut, LoombreApiError } from "../../../../lib/api-client.js";
import { getEventsSocket } from "../../../../lib/events-socket.js";
import { useAdminGuard } from "../../../../lib/use-admin-guard.js";
import styles from "./page.module.css";

type AdminPlugin = components["schemas"]["AdminPlugin"];
type RefreshPluginResponse = components["schemas"]["RefreshPluginResponse"];

const LIVE_EVENT_TYPES = [
  "plugin.registered",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.removed",
  "plugin.health-changed",
];

/** The manifest snapshot is opaque JSON (contract: "the admin UI derives
 *  its capability/config display from this") — a defensive read, never
 *  trusted to be perfectly shaped (a plugin's stored snapshot always DID
 *  pass parseLppManifest server-side at write time, but this stays honest
 *  about reading an `unknown` rather than asserting it blindly). */
function readManifestSummary(manifest: unknown): {
  capabilities: PluginCapability[];
  configSchema: PluginConfigSchema;
  description: string;
  publisher: string;
} {
  const m = (manifest ?? {}) as Record<string, unknown>;
  return {
    capabilities: Array.isArray(m["capabilities"]) ? (m["capabilities"] as PluginCapability[]) : [],
    configSchema: (m["configSchema"] as PluginConfigSchema | undefined) ?? { type: "object", properties: {} },
    description: typeof m["description"] === "string" ? m["description"] : "",
    publisher: typeof m["publisher"] === "string" ? m["publisher"] : "",
  };
}

function EventGrantsSection({ plugin, onChanged }: { plugin: AdminPlugin; onChanged: () => void }): React.JSX.Element {
  const summary = readManifestSummary(plugin.manifest);
  const requested = requestedEventTypes(summary.capabilities);
  const granted = plugin.eventGrants.map((g) => g.eventType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: string[]): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await apiPut("/admin/plugins/{id}/event-grants", { params: { path: { id: plugin.id } }, body: { eventTypeGrants: next } });
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to update event grants.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h3 className={styles.sectionTitle}>Activity feed</h3>
      <EventGrantsEditor requestedEventTypes={requested} grantedEventTypes={granted} onChange={(next) => void handleChange(next)} />
      {saving && <p className={styles.description}>Saving…</p>}
      {error && <p className={styles.errorBanner}>{error}</p>}
    </Card>
  );
}

/** `deliveryStatus` panel — event-subscriber plugins only (the detail
 *  page's own gate below matches EventGrantsSection's). Recomputes its
 *  relative-time copy against `Date.now()` on every render rather than
 *  freezing it at fetch time — a page left open for a while still reads
 *  "5 minutes ago" correctly, not a stale value from when GET last ran. */
function DeliveryStatusSection({ plugin }: { plugin: AdminPlugin }): React.JSX.Element {
  const summary = plugin.deliveryStatus ? describeDeliveryStatus(plugin.deliveryStatus, Date.now()) : null;

  return (
    <Card>
      <h3 className={styles.sectionTitle}>Delivery status</h3>
      <p className={styles.description}>{summary ? summary.headline : NEVER_DELIVERED_HEADLINE}</p>
      {summary?.failureWarning && (
        <div className={styles.dangerBanner}>
          <StatusPill label="Not receiving activity" tone="danger" />
          <p className={styles.description}>{summary.failureWarning}</p>
        </div>
      )}
      {summary?.gapNotice && (
        <div className={styles.scopeChangeBanner}>
          <StatusPill label="Activity skipped" tone="warning" />
          <p className={styles.description}>{summary.gapNotice}</p>
        </div>
      )}
    </Card>
  );
}

/** The pseudonymization toggle — event-subscriber plugins only. Default ON
 *  (pseudonymizeActorIds:true): activity sent to this plugin names an
 *  anonymous per-plugin id, never a real account. Turning it OFF needs an
 *  explicit confirmation naming what changes (window.confirm, same
 *  friction-on-the-more-exposing-direction posture handleRemove/
 *  handleRotateHmac already use elsewhere on this page) — turning
 *  protection back ON needs none. */
function PseudonymizationSection({ plugin, onChanged }: { plugin: AdminPlugin; onChanged: () => void }): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Additive-optional in the contract (packages/contract/openapi.yaml's
  // AdminPlugin schema — not in `required`, so older-generated-SDK call
  // sites keep compiling); this route's own controller always sends it.
  // Undefined falls back to the migration's own DEFAULT TRUE.
  const pseudonymizeActorIds = plugin.pseudonymizeActorIds ?? true;

  async function handleToggle(enabled: boolean): Promise<void> {
    if (
      !enabled &&
      !window.confirm(`Send real account ids to "${plugin.name}" instead of anonymous ones? This takes effect for everything delivered from now on.`)
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPut("/admin/plugins/{id}/pseudonymization", { params: { path: { id: plugin.id } }, body: { enabled } });
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to update this setting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h3 className={styles.sectionTitle}>Who gets credited</h3>
      <p className={styles.description}>
        By default, Loombre tells this plugin who did something using an anonymous id — the same real account
        always gets the same anonymous id for this one plugin, but that id can&apos;t be traced back to a real
        account or matched up with any other plugin. Turning this off sends real account ids instead.
      </p>
      <label className={styles.toggleRow}>
        <Toggle checked={pseudonymizeActorIds} onChange={(checked) => void handleToggle(checked)} disabled={saving} />
        <span>{pseudonymizeActorIds ? "Sending anonymous ids" : "Sending real account ids"}</span>
      </label>
      {error && <p className={styles.errorBanner}>{error}</p>}
    </Card>
  );
}

function ReapprovalPanel({ plugin, onChanged }: { plugin: AdminPlugin; onChanged: () => void }): React.JSX.Element {
  const [preview, setPreview] = useState<components["schemas"]["PluginManifestPreview"] | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [eventTypeGrants, setEventTypeGrants] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleReview(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost("/admin/plugins/preview", { body: { url: plugin.baseUrl, lanAllowlist: plugin.lanAllowlist } });
      setPreview(res);
      setSelectedTypes(res.capabilities.map((c) => c.type));
      setEventTypeGrants(plugin.eventGrants.map((g) => g.eventType));
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to re-read this plugin's manifest.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReapprove(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/admin/plugins/{id}/reapprove`, {
        params: { path: { id: plugin.id } },
        body: {
          grantedCapabilityTypes: selectedTypes,
          eventTypeGrants,
          // C-2 fix wave: pins this re-approval to the EXACT manifest
          // "Review what changed" rendered above — the server re-fetches
          // and 409s if a plugin served something different to this call
          // (manifest TOCTOU fix). exactOptionalPropertyTypes: omit the
          // key entirely rather than set it to `undefined`.
          ...(preview?.manifestDigest !== undefined ? { manifestDigest: preview.manifestDigest } : {}),
        },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to re-approve this plugin.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <div className={styles.scopeChangeBanner}>
        <StatusPill label="Needs re-approval" tone="warning" />
        <p className={styles.description}>
          This plugin now asks for more than it was approved for last time, so Loombre turned it off until you look
          it over.
        </p>
        {!preview && (
          <Button variant="primary" onClick={() => void handleReview()} disabled={loading}>
            {loading ? "Reading manifest…" : "Review what changed"}
          </Button>
        )}
      </div>

      {preview && (
        <div className={styles.capabilityList}>
          {preview.capabilities.map((capability) => (
            <CapabilityCard
              key={capability.type}
              capability={capability}
              selection={{
                checked: selectedTypes.includes(capability.type),
                onChange: (checked) =>
                  setSelectedTypes((prev) => (checked ? [...new Set([...prev, capability.type])] : prev.filter((t) => t !== capability.type))),
              }}
            />
          ))}

          {selectedTypes.includes("event-subscriber") && (
            <EventGrantsEditor
              requestedEventTypes={requestedEventTypes(preview.capabilities)}
              grantedEventTypes={eventTypeGrants}
              onChange={setEventTypeGrants}
            />
          )}

          <Button variant="primary" onClick={() => void handleReapprove()} disabled={submitting || selectedTypes.length === 0}>
            {submitting ? "Re-approving…" : "Re-approve"}
          </Button>
        </div>
      )}

      {error && <p className={styles.errorBanner}>{error}</p>}
    </Card>
  );
}

function DetailContent({ id }: { id: string }): React.JSX.Element {
  const router = useRouter();
  const [plugin, setPlugin] = useState<AdminPlugin | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshPluginResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    apiGet("/admin/plugins/{id}", { params: { path: { id } } })
      .then((res) => setPlugin(res))
      .catch((err) => {
        if (err instanceof LoombreApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof LoombreApiError ? err.message : "Failed to load this plugin.");
      });
  }, [id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const socket = getEventsSocket();
    const unsubscribes = LIVE_EVENT_TYPES.map((type) => socket.subscribe(type, () => refetch()));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [refetch]);

  async function handleEnable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/admin/plugins/{id}/enable", { params: { path: { id } } });
      refetch();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to enable this plugin.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/admin/plugins/{id}/disable", { params: { path: { id } } });
      refetch();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to disable this plugin.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      const res = await apiPost("/admin/plugins/{id}/refresh", { params: { path: { id } } });
      setRefreshResult(res);
      refetch();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to refresh this plugin.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRotateHmac(): Promise<void> {
    if (!window.confirm("Rotate this plugin's delivery secret? The plugin will need to be reconfigured with the new value.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost("/admin/plugins/{id}/rotate-hmac", { params: { path: { id } } });
      setRotatedSecret(res.hmacSecret);
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to rotate this plugin's secret.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(): Promise<void> {
    if (!plugin) return;
    if (!window.confirm(`Remove "${plugin.name}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete("/admin/plugins/{id}", { params: { path: { id } } });
      // Relocated (LD-8): the list this pops back to now lives at
      // /settings/plugins, not /admin/plugins.
      router.push("/settings/plugins");
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to remove this plugin.");
      setBusy(false);
    }
  }

  async function handleCopyRotatedSecret(): Promise<void> {
    if (!rotatedSecret) return;
    try {
      await navigator.clipboard.writeText(rotatedSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Nicety only — the value is still visible on screen.
    }
  }

  if (notFound) {
    return <p className={styles.errorBanner}>This plugin no longer exists.</p>;
  }

  if (!plugin) {
    return (
      <div className={styles.page} aria-hidden="true">
        <Skeleton radius="lg" height={120} />
        <Skeleton radius="lg" height={200} />
      </div>
    );
  }

  const status = describePluginStatus(plugin);
  const summary = readManifestSummary(plugin.manifest);

  return (
    <div className={styles.page}>
      {error && <p className={styles.errorBanner}>{error}</p>}

      <Card>
        <div className={styles.header}>
          <div className={styles.headerMain}>
            <h1 className={styles.pluginName}>{plugin.name}</h1>
            <span className={styles.pluginUrl}>{plugin.baseUrl}</span>
            <div className={styles.metaRow}>
              <StatusPill label={status.label} tone={status.tone} />
              <span className={styles.factValue}>v{plugin.version}</span>
            </div>
            {summary.description && <p className={styles.description}>{summary.description}</p>}
          </div>
          <div className={styles.headerActions}>
            {plugin.enabled ? (
              <Button variant="secondary" onClick={() => void handleDisable()} disabled={busy}>
                Disable
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => void handleEnable()}
                disabled={busy || plugin.disabledReason === "scope-change"}
                title={plugin.disabledReason === "scope-change" ? "Review and re-approve below first" : undefined}
              >
                Enable
              </Button>
            )}
            <Button variant="secondary" onClick={() => void handleRefresh()} disabled={refreshing}>
              {refreshing ? "Checking…" : "Check for updates"}
            </Button>
            <Button variant="ghost" onClick={() => void handleRemove()} disabled={busy}>
              Remove
            </Button>
          </div>
        </div>

        <div className={styles.factsList}>
          <div className={styles.factRow}>
            <span className={styles.factLabel}>Published by</span>
            <span className={styles.factValue}>{summary.publisher || "—"}</span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factLabel}>Registered</span>
            <span className={styles.factValue}>{new Date(plugin.createdAtMs).toLocaleString()}</span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factLabel}>Last health check</span>
            <span className={styles.factValue}>{plugin.lastHealthCheckMs ? new Date(plugin.lastHealthCheckMs).toLocaleString() : "Never"}</span>
          </div>
        </div>
      </Card>

      {refreshResult && !refreshResult.expanded && (
        <Card>
          <p className={styles.description}>This plugin&apos;s details are already up to date.</p>
        </Card>
      )}

      {plugin.disabledReason === "scope-change" && <ReapprovalPanel plugin={plugin} onChanged={refetch} />}

      {refreshResult?.expanded && plugin.disabledReason === "scope-change" && (
        <Card>
          <h3 className={styles.sectionTitle}>What changed</h3>
          <ul className={styles.scopeChangeReasons}>
            {refreshResult.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h3 className={styles.sectionTitle}>What this plugin can do</h3>
        <div className={styles.capabilityList}>
          {summary.capabilities
            .filter((c) => plugin.grantedCapabilityTypes.includes(c.type))
            .map((capability) => (
              <CapabilityCard key={capability.type} capability={capability} />
            ))}
        </div>
      </Card>

      {plugin.grantedCapabilityTypes.includes("event-subscriber") && (
        <>
          <EventGrantsSection plugin={plugin} onChanged={refetch} />
          <DeliveryStatusSection plugin={plugin} />
          <PseudonymizationSection plugin={plugin} onChanged={refetch} />
        </>
      )}

      <Card>
        <h3 className={styles.sectionTitle}>Configuration</h3>
        <PluginConfigForm
          schema={summary.configSchema}
          initialValues={plugin.config as Record<string, unknown>}
          requireAllSecrets={false}
          submitLabel="Save"
          onSubmit={async (values) => {
            await apiPut("/admin/plugins/{id}/config", { params: { path: { id } }, body: { config: values } });
            refetch();
          }}
        />
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>Delivery secret</h3>
        {rotatedSecret ? (
          <div className={styles.secretBox}>
            <div className={styles.secretValue}>
              <code>{rotatedSecret}</code>
              <Button variant="ghost" iconOnly onClick={() => void handleCopyRotatedSecret()} title="Copy">
                <Icon icon={copied ? Check : Copy} size="dense" aria-label="Copy secret" />
              </Button>
            </div>
            <p className={styles.secretWarning}>This will not be shown again. Copy it now.</p>
          </div>
        ) : (
          <>
            <p className={styles.description}>
              Used to verify what Loombre sends this plugin. The value itself is never shown here — only rotating it
              produces a new one, exactly once.
            </p>
            <Button variant="secondary" onClick={() => void handleRotateHmac()} disabled={busy}>
              Rotate secret
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

export function PluginDetailScreen({ id }: { id: string }): React.JSX.Element {
  // Same guard SettingsShell.tsx applies to every OTHER /settings* URL —
  // this route renders outside that shell (see this file's header), so it
  // uses the shared hook directly rather than inheriting the check for
  // free. AppShell below is mounted unconditionally — only the guarded
  // content itself waits on `isAdmin === true` (this file's header).
  const { isAdmin } = useAdminGuard("/profile");

  return (
    <AppShell>
      {isAdmin === true && (
        <SettingsPageLayout>
          <div className={styles.wrap}>
            <Link href="/settings/plugins" className={styles.backLink}>
              ← Plugins
            </Link>
            <DetailContent id={id} />
          </div>
        </SettingsPageLayout>
      )}
    </AppShell>
  );
}
