// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/HealthCards.tsx
//
// Admin dashboard health cards (Phosphor retheme Wave 2, Lane L2 —
// design/phosphor/README.md "Admin dashboard": "Four health cards (CPU
// with a 10-segment bar, GPU/NVENC + session count, memory, storage
// pool)"). Ground-truthed against the contract (packages/contract/
// openapi.yaml) and apps/server/src/catalog/admin.controller.ts's
// GET /system/info: only StoragePoolStats (usedBytes/totalBytes) exists
// anywhere in this codebase. There is no CPU load, GPU utilization, or
// memory-usage endpoint ANYWHERE — CapabilityReport (GET /admin/
// capabilities) is a static hardware capability MATRIX (decode/encode/
// tone-map support per backend), not a live utilization metric.
//
// Per U9 ("never fabricate" — the run law this whole page is built under):
// the CPU, GPU/transcode, and memory cards are OMITTED entirely, not
// rendered with placeholder/zero values. Logged here (and in this lane's
// freeze report) rather than silently dropped — a future lane wiring real
// os.loadavg()/GPU-query/process.memoryUsage() endpoints can add their
// cards back additively without touching this file's storage-pool logic.
// Session count (the GPU card's other stated metric) is NOT lost — it
// already surfaces prominently in StreamsPanel's "ACTIVE STREAMS · n"
// heading just below.

import { useStoragePool, formatStoragePoolMeter } from "../../lib/storage-pool.js";
import styles from "./HealthCards.module.css";

export function HealthCards(): React.JSX.Element | null {
  const pool = useStoragePool(true);
  if (!pool) return null; // no libraries yet, or every filesystem probe failed — never fabricated (U9)

  const meter = formatStoragePoolMeter(pool);

  return (
    <div className={styles.grid}>
      <div className={styles.card}>
        <span className={styles.label}>Storage pool</span>
        <span className={styles.value}>
          {meter.usedLabel} / {meter.totalLabel} {meter.unit}
        </span>
        <div className={styles.track} role="progressbar" aria-valuenow={meter.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className={styles.fill} style={{ width: `${meter.percent}%` }} />
        </div>
      </div>
    </div>
  );
}
