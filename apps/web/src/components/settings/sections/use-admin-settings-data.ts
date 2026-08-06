// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/use-admin-settings-data.ts
//
// Shared GET /admin/settings/schema + GET /admin/settings fetch (+
// `settings.updated` live refetch), extracted from the pre-IA
// apps/web/src/app/admin/settings/page.tsx (STATE.md Addendum A, decisions
// A6/A7/A8/A9) so PlaybackSection, RemoteAccessSection, PluginsSection, and
// AdvancedSection — the four Settings-IA tabs that all read the SAME
// registry snapshot — share one fetch instead of four independent copies.
// Behavior is unchanged from that page: re-fetch GET /admin/settings after
// every successful write (never trust a locally-computed post-write state),
// and refetch on the `settings.updated` websocket event so a second open
// admin session stays in sync.

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { getEventsSocket } from "../../../lib/events-socket.js";

type AdminSettingsSchemaResponse = components["schemas"]["AdminSettingsSchemaResponse"];
type AdminSettingsResponse = components["schemas"]["AdminSettingsResponse"];

export interface AdminSettingsData {
  schema: AdminSettingsSchemaResponse | null;
  settings: AdminSettingsResponse | null;
  error: string | null;
  refetch: () => void;
  /** Full reload (schema + settings) that also clears `error` first —
   *  the retry affordance for the tabs that can render nothing without a
   *  schema (AUD-A3b-002). Distinct from `refetch`, which stays
   *  settings-only for the ordinary post-write path and never needs to
   *  re-pull the schema. */
  retry: () => void;
}

export function useAdminSettingsData(): AdminSettingsData {
  const [schema, setSchema] = useState<AdminSettingsSchemaResponse | null>(null);
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);

  const refetch = useCallback(() => {
    apiGet("/admin/settings")
      .then(setSettings)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load settings."));
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setLoadGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([apiGet("/admin/settings/schema"), apiGet("/admin/settings")])
      .then(([schemaRes, settingsRes]) => {
        if (cancelled) return;
        setSchema(schemaRes);
        setSettings(settingsRes);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof LoombreApiError ? err.message : "Failed to load settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadGeneration]);

  useEffect(() => {
    const socket = getEventsSocket();
    return socket.subscribe("settings.updated", () => refetch());
  }, [refetch]);

  return { schema, settings, error, refetch, retry };
}
