// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/system-info.ts
//
// Shared GET /system/info data layer (item 7, Wave A). Before
// this file, three independent call sites raced the same admin-only
// endpoint on every Dashboard load: app/admin/page.tsx's DashboardHeader
// (version/uptime status line), components/admin/system/SystemInfoCard.tsx
// (the full OS/tier/node fact card), and lib/storage-pool.ts's
// useStoragePool (Sidebar's POOL meter, mounted in the app shell around
// EVERY admin page) — each ran its own useEffect + apiGet, so a single
// Dashboard navigation fired the identical request three times.
//
// This module is the shared de-dup layer for the DASHBOARD cluster that
// used to race: a module-level cache + in-flight-promise de-dup means N
// consumers mounting within the same tick share exactly one network
// request; each subscribes via useSystemInfo() instead of fetching for
// itself. Cached for the lifetime of the module (a page load) — same
// "fetch once" horizon every prior per-component useEffect already had
// (none polled or refetched on focus), just shared instead of duplicated.
//
// NOTE: it is the shared path for the Dashboard consumers, not the sole
// caller of GET /system/info in the whole app. Two settings-only screens —
// components/settings/SettingsHub.tsx and
// components/settings/sections/AboutSection.tsx — still call
// apiGet("/system/info") directly; each mounts ALONE on its own settings
// page (one fetch, no race), so they were deliberately left off the hook.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "./api-client.js";

export type SystemInfo = components["schemas"]["SystemInfo"];

interface SystemInfoState {
  info: SystemInfo | null;
  error: unknown;
}

type Listener = (state: SystemInfoState) => void;

const EMPTY_STATE: SystemInfoState = { info: null, error: null };

let state: SystemInfoState = EMPTY_STATE;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(next: SystemInfoState): void {
  state = next;
  for (const listener of listeners) listener(state);
}

function ensureFetched(): void {
  if (inFlight || state.info) return;
  inFlight = apiGet("/system/info")
    .then((info) => {
      publish({ info, error: null });
    })
    .catch((error: unknown) => {
      publish({ info: null, error });
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Test-only reset — the cache is deliberately module-level (that's the
 *  whole de-dup mechanism), which would otherwise leak a resolved value
 *  across unrelated test cases. Never called from application code. */
export function resetSystemInfoCache(): void {
  state = EMPTY_STATE;
  inFlight = null;
}

/** Subscribes to the shared GET /system/info cache. `enabled=false` (a
 *  non-admin viewer — the endpoint is admin-only, mirroring useStoragePool's
 *  pre-existing honesty rule) never fetches and always reports
 *  `{ info: null, error: null }`. */
export function useSystemInfo(enabled = true): SystemInfoState {
  const [local, setLocal] = useState<SystemInfoState>(enabled ? state : EMPTY_STATE);

  useEffect(() => {
    if (!enabled) return;
    const listener: Listener = (next) => setLocal(next);
    listeners.add(listener);
    setLocal(state);
    ensureFetched();
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);

  return enabled ? local : EMPTY_STATE;
}
