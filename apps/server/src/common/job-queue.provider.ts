// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/job-queue.provider.ts
//
// The one @loombre/jobs JobQueue handle apps/server holds (CLAUDE.md
// invariant 6 — "long-running work goes through the job queue; nothing
// spawns ffmpeg inline"): POST /libraries/{id}/scan enqueues 'scan',
// POST /import enqueues 'import'. Same connection-string convention as
// DbProvider (DATABASE_URL env, docker-compose.dev.yml's host port default).
//
// 'import' STUB REMOVED (Phase 4 lane E): apps/worker/src/import now
// registers the real handler (apps/worker/src/index.ts:
// `queue.work('import', createImportConsumerHandler({db}))`), following the
// exact same pattern every OTHER job type's handler already uses (scan,
// probe, metadata, image, ...) — this provider goes back to being what its
// name says: a queue HANDLE for enqueueing, never a handler REGISTRATION
// site. See packages/jobs/src/types.ts's ImportJobPayload doc for the full
// job-payload/mode design and apps/worker/src/import/consumer.ts's module
// header for the archive-apply consumer itself.
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createJobQueue, type JobQueue } from "@loombre/jobs";

const DEFAULT_DATABASE_URL = "postgres://loombre:loombre@localhost:5442/loombre";

@Injectable()
export class JobQueueProvider implements OnModuleDestroy {
  readonly queue: JobQueue;

  constructor() {
    const connectionString = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
    this.queue = createJobQueue(connectionString);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.stop();
  }
}
