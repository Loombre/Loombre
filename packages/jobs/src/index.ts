// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/index.ts — public package barrel.

export type {
  JobPayloads,
  JobType,
  ScanJobPayload,
  ProbeJobPayload,
  ImageJobPayload,
  MetadataJobPayload,
  MetadataSearchJobPayload,
  ImportJobPayload,
  ImageBackfillJobPayload,
  HwProbeJobPayload,
  TranscodeJobPayload,
  SubtitleExtractJobPayload,
  PgUpgradeJobPayload,
} from './types.js';
export { JOB_TYPES } from './types.js';

export type { JobQueue, JobHandler, EnqueueOptions, WorkOptions } from './queue.js';
export { createJobQueue } from './queue.js';

// STATE.md Phase 4 Open item ("Upgrade jobs-ledger follow-up (lane B)"):
// exported so a boot-time caller (packages/provisioning-pg, wired in a
// later wave — NOT this one) can write a 'pg-upgrade' ledger row directly,
// bypassing pg-boss entirely (see types.ts's PgUpgradeJobPayload doc
// comment for why). Same export every other lane already gets via
// createJobQueue()'s internal use of this module — just not previously
// exposed at the package boundary.
export type { Ledger } from './ledger.js';
export { createLedger } from './ledger.js';
