// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/storage-pool.ts
//
// Sidebar POOL meter (STATE.md Phosphor retheme, W1c "contract enablers"
// lane; design/phosphor/README.md Shell spec: "POOL 43.1 / 60.8 TB", 71%
// bar). GET /system/info's additive `storagePool` field
// (packages/contract/openapi.yaml) is admin-only and null when there are
// no libraries yet or every filesystem probe failed server-side — this
// hook mirrors that honesty: it hides (returns null) rather than ever
// rendering a fabricated number, on ANY of {non-admin, network error,
// 403/404, storagePool itself being null}.
//
// Item 7 (an upstream media server-study Wave A, /system/info triple-fetch): this used to
// run its own independent useEffect + apiGet("/system/info") — one of
// three call sites racing the same request on every Dashboard load (see
// lib/system-info.ts's header for the full writeup). It now delegates to
// the shared useSystemInfo() data layer and just plucks storagePool back
// out, so Sidebar (mounted in the app shell around every admin page)
// shares the SAME request as DashboardHeader/SystemInfoCard instead of
// firing its own.

import type { components } from "@loombre/sdk";
import { useSystemInfo } from "./system-info.js";

export type StoragePoolStats = components["schemas"]["StoragePoolStats"];

/** GET /system/info is admin-only — a non-admin caller gets `null` without
 *  even attempting the request. Any fetch failure also resolves to `null`
 *  — the caller hides the meter on `null`, never renders zeros. */
export function useStoragePool(isAdmin: boolean): StoragePoolStats | null {
  const { info } = useSystemInfo(isAdmin);
  return info?.storagePool ?? null;
}

const BYTES_PER_KB = 1024;
const TB = BYTES_PER_KB ** 4;
const GB = BYTES_PER_KB ** 3;
const MB = BYTES_PER_KB ** 2;

export interface StoragePoolMeter {
  /** e.g. "43.1" */
  usedLabel: string;
  /** e.g. "60.8" */
  totalLabel: string;
  /** e.g. "TB" */
  unit: string;
  /** 0-100, rounded, clamped — the bar's fill width. */
  percent: number;
}

/** Pure display formatting for the POOL meter — README "POOL 43.1 / 60.8
 *  TB" with a percent-filled bar. Auto-scales the unit off `totalBytes`
 *  (TB down to GB down to MB) so a small instance doesn't render "0.0
 *  TB". */
export function formatStoragePoolMeter(stats: StoragePoolStats): StoragePoolMeter {
  const { usedBytes, totalBytes } = stats;
  const unit = totalBytes >= TB ? "TB" : totalBytes >= GB ? "GB" : "MB";
  const divisor = unit === "TB" ? TB : unit === "GB" ? GB : MB;

  const percent = totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100))) : 0;

  return {
    usedLabel: (usedBytes / divisor).toFixed(1),
    totalLabel: (totalBytes / divisor).toFixed(1),
    unit,
    percent,
  };
}
