// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/import/index.ts — public barrel for the
// data-freedom import consumer (P1.17/docs/PLAN.md §8.4, Phase 4 lane E).
//
// `createImportConsumerHandler` is a FACTORY — call it with real deps to
// get the JobHandler<'import'> a `queue.work('import', ...)` call expects,
// matching every other apps/worker consumer's wiring convention
// (apps/worker/src/index.ts). `runImport` is the typed, directly-callable
// core (tests and any future in-process caller) — see consumer.ts's module
// header for the full design.

export { runImport, createImportConsumerHandler, type ImportConsumerDeps } from './consumer.js';
export { validateArchive, checkReferentialIntegrity } from './validate.js';
export type {
  ArchiveItem,
  ArchiveLibrary,
  ArchiveMediaFile,
  ArchivePersonCredit,
  ArchiveProgress,
  ArchiveUser,
  ExportArchive,
  ImportMode,
  ImportResult,
  ImportSectionCounts,
} from './types.js';
export { ImportValidationError, ImportConflictError } from './types.js';
