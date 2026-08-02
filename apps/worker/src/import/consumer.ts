// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/import/consumer.ts
//
// The real 'import' job consumer (docs/PLAN.md §8.4, Phase 4 lane E) —
// replaces the Phase 1 stub (apps/server/src/common/job-queue.provider.ts,
// now deleted) that unconditionally failed every job with
// `not-implemented-phase-2`. One job = one ExportArchive apply, following
// the exact registration pattern every other apps/worker consumer uses
// (apps/worker/src/index.ts: `queue.work('import', createImportConsumerHandler(deps))`).
//
// ============================================================================
// What the archive CAN and CANNOT carry (read this before touching anything
// below — every "why is this field always null/empty" question traces back
// here). packages/contract/openapi.yaml's ExportArchive is frozen for this
// lane ("shapes are law"); these are load-bearing findings from reading it
// closely, not assumptions:
//
//   - MediaFileSummary (the only media_files representation the archive
//     carries, via Movie/Episode/Track.mediaFiles) has NO path and NO
//     content_hash field — only id/versionLabel/container/width/height/
//     sizeBytes/durationMs. media_files.path is TEXT NOT NULL UNIQUE
//     (migrations/0001_init.sql), so a real path can never be restored.
//     Import instead writes a SYNTHESIZED, never-real placeholder path
//     (`loombre-import-placeholder://<itemId>/<index>`, guaranteed unique)
//     and sets missing_since_ms = import time IMMEDIATELY — this is
//     deliberately the exact same state P1.2's missing-file machinery
//     already produces for a real scanner-discovered missing file, not a
//     new state invented for import (mission instruction: "verify this
//     works rather than inventing a state"). content_hash stays NULL,
//     which correctly makes the row invisible to findFileByContentHash's
//     rename/relink matching (packages/db/src/internal/files.ts) — so a
//     LATER real scan of the restored library's (also-restored) paths
//     self-heals cleanly: the scanner's own natural-key identity
//     resolution (findMovieByTitleYear/findSeasonByNumber/etc.,
//     src/internal/catalog.ts — the SAME functions this consumer's
//     merge-skip-existing mode reuses below) matches the real file to the
//     ALREADY-RESTORED catalog item by title/year/season/episode number
//     and simply adds a fresh, real media_files row alongside the
//     placeholder; the placeholder is reaped by the ordinary 72h
//     hard-cascade sweep on that library's next full scan
//     (apps/worker/src/scan/scanner.ts) with zero import-specific cleanup
//     code required. One direct, verified consequence worth knowing about
//     up front: packages/db/src/query/guard.ts's missing-file visibility
//     clause hides a LEAF item (movie/episode/track) from every guarded
//     read the instant ALL its media_files rows are missing — which is
//     true of every freshly-imported leaf item with a mediaFiles entry,
//     immediately after import, until a rescan (or manual relink) finds
//     the real file. Container items (series/season/artist/album, which
//     never own media_files rows directly) are unaffected and stay
//     visible throughout. This is not a bug: it is the SAME rule that
//     already hides any other item whose file went missing, applied
//     consistently.
//
//   - ImageDescriptor has no file_path either (only kind/width/height/
//     blurhash/dominantColor) — there is no way to reconstruct an `images`
//     row from an archive at all (the real image bytes were never
//     exported, only descriptors of already-computed variants). Import
//     writes ZERO images rows. Restored items simply have none until a
//     metadata/image refresh re-ingests them.
//
//   - No item schema exposes provider ids anywhere (grep of the whole
//     contract for "providerIds"/"ProviderId" is empty — packages/db's own
//     exportData() computes them but data-freedom.controller.ts never puts
//     them on the wire). Import writes ZERO provider_ids rows and cannot
//     use provider ids as a natural key (the mission's own suggested
//     natural key for items). It instead reuses the scanner's own
//     structural natural-key functions (title/year, season/episode number,
//     etc. — packages/db/src/internal/catalog.ts) for merge-skip-existing,
//     which is the CORRECT choice anyway: those are the same keys the
//     self-heal rescan path above depends on staying in sync with.
//
//   - Only genre-kind tags round-trip: every item schema exposes `genres:
//     string[]` but NONE expose a general `tags` field (item_tags also has
//     a `kind: 'tag'` variant used internally by the metadata pipeline,
//     packages/db/migrations/0001_init.sql — the contract simply never
//     surfaces it). Import writes item_tags rows with kind='genre' only.
//     Season/Episode/Track have no `genres` field in the contract at all
//     (only Movie/Series/Artist/Album do) and Season/Track/Album have no
//     `people` field either (only Movie/Series/Episode/Artist do) — this
//     module writes exactly the relations each item type's OWN contract
//     schema exposes, nothing invented, nothing silently dropped.
//     people/tags ids are never preserved even on an empty target (only
//     findOrCreatePerson/findOrCreateTag by name+contentClass, matching how
//     the scanner/metadata consumer already create them) — not called out
//     as a preservation requirement anywhere in the mission text, and the
//     archive doesn't carry a person/tag id todo the credit against.
//
//   - ExportUser is explicitly documented in the contract as "sans secrets
//     (no password hash, no PIN hash, no tokens)". Every restored user gets
//     the SAME well-formed-but-unmatchable argon2id sentinel apps/server's
//     own auth.controller.ts already uses for its constant-time-login dummy
//     comparison (packages/db/src/internal/import-users.ts's
//     IMPORT_PLACEHOLDER_PASSWORD_HASH) — they cannot log in until an admin
//     resets their password. birth_date/max_content_rating and the entire
//     user_settings row (restricted opt-in/PIN/prefs) are likewise never in
//     the archive and are never fabricated.
//
//   - Progress carries no userId at all (ExportUser-adjacent but it isn't
//     one — packages/contract/openapi.yaml's Progress schema is
//     {itemId, positionMs, durationMs, state, playCount, updatedAtMs}, full
//     stop) because GET /export's `progress` array is always the EXPORTING
//     viewer's own progress only (packages/db/src/query/export.ts's module
//     header). Every progress row this import writes is attributed to
//     `payload.requestedByUserId` — the user who is CURRENTLY authenticated
//     and running the import — which is exactly correct for the
//     "restore my own backup" use case the wizard and every realistic
//     export/reimport cycle actually is, and is the only identity available
//     to attribute it to; cross-user archive transplantation would need a
//     contract change this lane does not make.
//
//   - library_permissions rows are never in the archive at all. A restored
//     GENERAL library auto-grants the importing admin (payload.
//     requestedByUserId) exactly once, at library-creation time, mirroring
//     packages/db/src/query/libraries.ts's createLibrary() precedent
//     verbatim (see packages/db/src/internal/libraries.ts's
//     grantLibraryPermission doc comment for the full rationale, including
//     why RESTRICTED libraries are deliberately excluded from this
//     auto-grant). Every OTHER user's — and every merge-matched
//     pre-existing library's — permissions are simply not restored; an
//     admin must re-grant them by hand. Flagged prominently in this lane's
//     report as a real, user-facing "your restored admin doesn't
//     automatically see libraries owned by other restored users" gap.
//
//   - `playlists` is validated for shape (the contract requires the array
//     key) but never written anywhere: no `playlists` table exists in
//     packages/db/migrations at all, and GET /export always emits `[]`
//     (data-freedom.controller.ts hardcodes it) — there is nothing to
//     restore FROM today and nowhere to restore TO if there were.
//
// ============================================================================
// Conflict policy (deliverable 1's "DECIDE, implement, and document"):
//
//   EMPTY-TARGET CHECK (packages/db/src/internal/import-target-state.ts):
//   the target is "empty enough" for ID-preservation restore iff libraries,
//   catalog_items, and progress are ALL literally empty, AND every row
//   currently in `users` has a username that also appears somewhere in
//   archive.users. That last clause is not a loophole, it is the P4.10
//   wizard-restore seam made to actually work: POST /import requires an
//   admin JWT (AuthGuard), and the ONLY way to get one on a fresh install is
//   the onboarding wizard's own create-first-admin step (P4.10) — so by the
//   time a wizard-driven import ever runs, the target NECESSARILY already
//   has exactly one users row (the wizard's own freshly-created admin,
//   almost always username "admin"). A literal "zero rows anywhere" rule
//   would make 'fail-if-not-empty' — the mission's own recommended safe
//   default for wizard restore — impossible to ever satisfy from the
//   wizard, which cannot be the intent. See the module-level "wizard-restore
//   seam" note in this lane's report for exactly what lane C needs to do
//   with this.
//
//   MODE (payload.mode, packages/jobs/src/types.ts, default
//   'fail-if-not-empty' when omitted — POST /import's request body is
//   closed to exactly ExportArchive, so no HTTP caller can set this today;
//   see that type's doc comment):
//     - Empty target: BOTH mode values behave identically (nothing can
//       conflict on an empty target either way) — every row is created with
//       its archive id preserved verbatim. Recorded in the result as
//       `preservedIds: true`.
//     - Non-empty target + 'fail-if-not-empty': the WHOLE job fails before
//       a single write, naming which table already had unexpected data.
//       This is the safe default specifically because silently merging into
//       a caller's live, already-populated instance without being asked is
//       the wrong failure mode for a data-freedom "restore" primitive.
//     - Non-empty target + 'merge-skip-existing': every library/item/user
//       is looked up by NATURAL KEY (the exact same identity-resolution
//       functions the scanner itself already uses for libraries/items —
//       see packages/db/src/internal/catalog.ts and this file's
//       findLibraryByNameAndKind — plus username for users) scoped to
//       already-remapped parent ids; a match is left COMPLETELY untouched
//       (including all of its sub-resources — genres/people/mediaFiles are
//       only ever written for a NEWLY created row, never merged into an
//       existing one) and counted 'skipped'; no match creates a fresh row
//       with a FRESH (never archive-preserved) id and counts 'created'.
//       Every section reports {created, skipped} (users additionally
//       reports `selfMatched` — see below).
//
//   USERS' self-match special case: within the users section specifically,
//   an archive row whose username matches the CALLER's (requestedByUserId's)
//   own already-existing row is left untouched — crucially, its real,
//   just-set password is NEVER overwritten with the unmatchable sentinel —
//   and counted `selfMatched` rather than a plain natural-key `skipped`.
//   This is what makes the wizard flow work end to end: the wizard's own
//   admin survives the import with the password the operator just chose.
//
// ============================================================================
// Transaction strategy (deliverable 4's "DECIDE... whole-archive vs
// per-section, measure"): WHOLE-ARCHIVE, ONE Postgres transaction.
// Rationale: (1) the entire archive is ALREADY one fully-materialized JS
// object in this process's memory the instant this handler runs — pg-boss
// deserializes the whole JSONB job payload before calling any handler
// (packages/jobs/src/queue.ts) — so wrapping the WRITES in one transaction
// adds no additional peak-memory cost beyond the archive's own JSON size;
// there is no streaming benefit a per-section transaction would buy back.
// (2) atomicity is exactly what a "restore" operation's user expects: a
// half-applied restore (some libraries present, others missing because a
// later section hit a bad row) is a worse failure mode than "nothing
// happened, try again" — see this lane's report for the 50k-scale memory
// measurement this recommendation was contingent on.
// Real, honestly-documented cost: no OTHER connection can observe ANY
// partial state — including fine-grained progress — until COMMIT. This
// specifically means the existing scan_checkpoints table (P1.12,
// job_id-keyed phase/counter bookkeeping — the mechanism this consumer
// would otherwise reuse for "admin UI shows phases") cannot be written
// mid-run: its library_id column is NOT NULL + FK'd to `libraries`, and
// under a whole-archive transaction no library row is visible to a
// checkpoint write on a SEPARATE connection until the whole import has
// already finished. This consumer therefore writes exactly ONE checkpoint
// row, AFTER commit, with the final counts — a completion summary, not
// live phase tracking — and relies on the job ledger's own automatic
// queued->active->completed/failed status transitions (already wired by
// every job type via packages/jobs/src/queue.ts's work() wrapper, nothing
// import-specific to add) for the only WITHIN-run signal available.
// Genuinely live per-phase progress would need either per-section
// transactions with a resume story, or a progress table with no FK
// dependency on the data being restored — flagged as an open item, not
// built here (deliberately out of this lane's scope: it would mean
// abandoning whole-archive atomicity, the higher-value property).
//
// ============================================================================
// Events (deliverable 1's "emits item.added? NO — decide and document"):
// ZERO per-item/per-user events (a 50k-item archive must not flood the
// outbox — mission's own stated concern). Exactly ONE `scan.completed`
// event per library actually touched this run (newly created, OR received
// at least one item) — reused deliberately rather than `library.created`:
// library.created would be flatly WRONG for a merge-matched pre-existing
// library (it wasn't created), whereas scan.completed's payload shape
// (jobId/libraryId/full/itemsAdded/itemsUpdated/itemsRemoved/durationMs/
// completedAtMs/status) is accurate either way and its established
// consumer-facing meaning — "this library's catalog changed, re-fetch it"
// — holds true for an import exactly as it does for a scan. `full: true`
// (this is a one-shot materialization of the library's imported item set,
// closer in spirit to a full pass than an incremental delta). Written
// INSIDE the same transaction as the data it describes (the outbox
// pattern, packages/db/src/internal/events.ts's writeEvent signature
// enforces this at the type level), so a rolled-back import commits zero
// events by construction — `status` is therefore always 'succeeded' for any
// event that exists at all.

import type { JobHandler, JobPayloads } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import {
  findAlbumByTitle,
  findArtistByName,
  findEpisodeByNumber,
  findLibraryByNameAndKind,
  findMovieByTitleYear,
  findOrCreatePerson,
  findOrCreateTag,
  findSeasonByNumber,
  findSeriesByTitle,
  findTrackByNumberOrTitle,
  getImportTargetState,
  grantLibraryPermission,
  insertLibraryWithId,
  insertMediaFilePlaceholderForImport,
  insertProgressExact,
  insertUserWithId,
  replaceItemPeople,
  replaceItemTags,
  upsertCatalogItem,
  upsertSatellite,
  withTransaction,
  writeCheckpoint,
  writeEvent,
} from '@loombre/db/internal';
import { getUserByUsername } from '@loombre/db';
import { validateArchive, checkReferentialIntegrity } from './validate.js';
import {
  ImportConflictError,
  type ArchiveItem,
  type ArchiveMediaFile,
  type ArchivePersonCredit,
  type ImportMode,
  type ImportResult,
  type ImportSectionCounts,
} from './types.js';

export interface ImportConsumerDeps {
  db: DbOrTx;
  clock?: () => number;
  log?: (message: string) => void;
}

const DEFAULT_MODE: ImportMode = 'fail-if-not-empty';

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function newCounts(): ImportSectionCounts {
  return { created: 0, skipped: 0 };
}

interface LibraryTouch {
  isNew: boolean;
  itemsCreated: number;
}

/**
 * Runs one import job to completion and returns its counts. Separated from
 * createImportConsumerHandler (the thin JobHandler adapter below) so tests
 * get direct, typed access to the result — the job ledger itself has no
 * column to persist this into (see this module's header, "Transaction
 * strategy" section) — mirroring apps/worker/src/scan/scanner.ts's
 * `runScan` / `metadataConsumerHandler` split precedent.
 */
export async function runImport(
  deps: ImportConsumerDeps,
  payload: JobPayloads['import'],
  meta: { jobId: string }
): Promise<ImportResult> {
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? ((message: string) => console.log(message));
  const startedAtMs = clock();

  const archive = validateArchive(payload.archive);
  checkReferentialIntegrity(archive);

  const target = await getImportTargetState(deps.db);
  const isEmptyTarget =
    !target.hasLibraries &&
    !target.hasCatalogItems &&
    !target.hasProgress &&
    target.existingUsernames.every((u) => archive.users.some((au) => au.username === u));

  const mode = payload.mode ?? DEFAULT_MODE;
  if (!isEmptyTarget && mode === 'fail-if-not-empty') {
    const offendingTable = !target.hasLibraries
      ? !target.hasCatalogItems
        ? !target.hasProgress
          ? 'users'
          : 'progress'
        : 'catalog_items'
      : 'libraries';
    throw new ImportConflictError(
      `import: target database is not empty (table "${offendingTable}" already has data this archive doesn't account for) ` +
        `and mode is 'fail-if-not-empty' (the default) — no rows were written.`
    );
  }

  const preserveIds = isEmptyTarget;
  const result: ImportResult = {
    mode,
    preservedIds: preserveIds,
    libraries: newCounts(),
    items: newCounts(),
    users: { ...newCounts(), selfMatched: 0 },
    progress: newCounts(),
    durationMs: 0,
  };

  const libraryTouches = new Map<string, LibraryTouch>();

  await withTransaction(deps.db, async (trx) => {
    // ---- users -------------------------------------------------------
    for (let i = 0; i < archive.users.length; i++) {
      const u = archive.users[i]!;
      const existing = await getUserByUsername(trx, u.username);
      if (existing) {
        if (existing.id === payload.requestedByUserId) {
          result.users.selfMatched++;
        } else {
          result.users.skipped++;
        }
        continue;
      }
      try {
        await insertUserWithId(trx, {
          ...(preserveIds ? { id: u.id } : {}),
          username: u.username,
          email: u.email,
          displayName: u.displayName,
          isAdmin: u.isAdmin,
          createdAtMs: u.createdAtMs,
          updatedAtMs: u.createdAtMs,
        });
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          throw new ImportConflictError(
            `import: archive.users[${i}] (username "${u.username}") collides with another row in this SAME archive ` +
              `(duplicate username/email) — no rows were kept.`
          );
        }
        throw err;
      }
      result.users.created++;
    }

    // ---- libraries -----------------------------------------------------
    const libraryIdMap = new Map<string, string>(); // archive library id -> target library id
    for (const lib of archive.libraries) {
      if (preserveIds) {
        await insertLibraryWithId(trx, {
          id: lib.id,
          name: lib.name,
          mediaKind: lib.mediaKind,
          paths: lib.paths,
          contentClass: lib.contentClass,
          createdAtMs: lib.createdAtMs,
          updatedAtMs: lib.createdAtMs,
        });
        libraryIdMap.set(lib.id, lib.id);
        result.libraries.created++;
        libraryTouches.set(lib.id, { isNew: true, itemsCreated: 0 });
        if (lib.contentClass !== 'restricted') {
          await grantLibraryPermission(trx, {
            userId: payload.requestedByUserId,
            libraryId: lib.id,
            grantedAtMs: startedAtMs,
          });
        }
        continue;
      }

      const existing = await findLibraryByNameAndKind(trx, lib.name, lib.mediaKind);
      if (existing) {
        libraryIdMap.set(lib.id, existing.id);
        result.libraries.skipped++;
        continue;
      }
      const created = await insertLibraryWithId(trx, {
        name: lib.name,
        mediaKind: lib.mediaKind,
        paths: lib.paths,
        contentClass: lib.contentClass,
        createdAtMs: lib.createdAtMs,
        updatedAtMs: lib.createdAtMs,
      });
      libraryIdMap.set(lib.id, created.id);
      result.libraries.created++;
      libraryTouches.set(created.id, { isNew: true, itemsCreated: 0 });
      if (created.content_class !== 'restricted') {
        await grantLibraryPermission(trx, {
          userId: payload.requestedByUserId,
          libraryId: created.id,
          grantedAtMs: startedAtMs,
        });
      }
    }

    // ---- items (three dependency tiers: container -> mid -> leaf) ------
    const itemIdMap = new Map<string, string>(); // archive item id -> target item id
    const importNowMs = clock();

    const tier0 = archive.items.filter((i): i is Extract<ArchiveItem, { itemType: 'movie' | 'series' | 'artist' }> =>
      i.itemType === 'movie' || i.itemType === 'series' || i.itemType === 'artist'
    );
    const tier1 = archive.items.filter((i): i is Extract<ArchiveItem, { itemType: 'season' | 'album' }> =>
      i.itemType === 'season' || i.itemType === 'album'
    );
    const tier2 = archive.items.filter((i): i is Extract<ArchiveItem, { itemType: 'episode' | 'track' }> =>
      i.itemType === 'episode' || i.itemType === 'track'
    );

    function touchLibrary(targetLibraryId: string): LibraryTouch {
      let touch = libraryTouches.get(targetLibraryId);
      if (!touch) {
        touch = { isNew: false, itemsCreated: 0 };
        libraryTouches.set(targetLibraryId, touch);
      }
      return touch;
    }

    async function writeRelations(itemId: string, item: ArchiveItem): Promise<void> {
      const contentClass = item.contentClass;

      if (item.itemType === 'movie' || item.itemType === 'series' || item.itemType === 'artist' || item.itemType === 'album') {
        const tagIds = await Promise.all(
          item.genres.map(async (name) => (await findOrCreateTag(trx, name, contentClass)).id)
        );
        await replaceItemTags(
          trx,
          itemId,
          tagIds.map((tagId) => ({ tagId, kind: 'genre' as const }))
        );
      }

      if (item.itemType === 'movie' || item.itemType === 'series' || item.itemType === 'episode' || item.itemType === 'artist') {
        const people: ArchivePersonCredit[] = item.people;
        const peopleInputs = await Promise.all(
          people.map(async (p) => ({
            personId: (await findOrCreatePerson(trx, p.name, contentClass)).id,
            role: p.role,
            credit: p.credit,
            order: p.order,
          }))
        );
        await replaceItemPeople(trx, itemId, peopleInputs);
      }

      if (item.itemType === 'movie' || item.itemType === 'episode' || item.itemType === 'track') {
        const mediaFiles: ArchiveMediaFile[] = item.mediaFiles;
        for (let i = 0; i < mediaFiles.length; i++) {
          const mf = mediaFiles[i]!;
          await insertMediaFilePlaceholderForImport(trx, {
            ...(preserveIds ? { id: mf.id } : {}),
            itemId,
            placeholderPath: `loombre-import-placeholder://${itemId}/${i}`,
            container: mf.container,
            sizeBytes: mf.sizeBytes,
            durationMs: mf.durationMs,
            versionLabel: mf.versionLabel,
            missingSinceMs: importNowMs,
          });
        }
      }
    }

    async function writeSatellite(itemId: string, item: ArchiveItem): Promise<void> {
      switch (item.itemType) {
        case 'movie':
          await upsertSatellite(trx, {
            itemType: 'movie',
            item_id: itemId,
            content_rating: item.contentRating,
            runtime_ms: item.runtimeMs,
            tagline: item.tagline,
            overview: item.overview,
          });
          return;
        case 'series':
          await upsertSatellite(trx, {
            itemType: 'series',
            item_id: itemId,
            content_rating: item.contentRating,
            status: item.status,
            overview: item.overview,
          });
          return;
        case 'season':
          await upsertSatellite(trx, { itemType: 'season', item_id: itemId, season_number: item.seasonNumber });
          return;
        case 'episode':
          await upsertSatellite(trx, {
            itemType: 'episode',
            item_id: itemId,
            episode_number: item.episodeNumber,
            aired_at_ms: item.airDateMs,
            overview: item.overview,
          });
          return;
        case 'artist':
          await upsertSatellite(trx, { itemType: 'artist', item_id: itemId, overview: item.overview });
          return;
        case 'album':
          await upsertSatellite(trx, { itemType: 'album', item_id: itemId, year: item.year });
          return;
        case 'track':
          await upsertSatellite(trx, {
            itemType: 'track',
            item_id: itemId,
            track_number: item.trackNumber,
            disc_number: item.discNumber,
            duration_ms: item.durationMs,
          });
          return;
      }
    }

    async function processItem(item: ArchiveItem, targetLibraryId: string, targetParentId: string | null): Promise<void> {
      touchLibrary(targetLibraryId);

      if (preserveIds) {
        await upsertCatalogItem(trx, {
          id: item.id,
          libraryId: targetLibraryId,
          itemType: item.itemType,
          parentId: targetParentId,
          title: item.title,
          sortTitle: item.sortTitle,
          year: item.year,
          communityRating: item.communityRating,
          addedAtMs: item.addedAtMs,
          updatedAtMs: item.updatedAtMs,
        });
        itemIdMap.set(item.id, item.id);
        result.items.created++;
        touchLibrary(targetLibraryId).itemsCreated++;
        await writeSatellite(item.id, item);
        await writeRelations(item.id, item);
        return;
      }

      const existingId = await findExistingItemId(item, targetLibraryId, targetParentId);
      if (existingId) {
        itemIdMap.set(item.id, existingId);
        result.items.skipped++;
        return;
      }

      const createdRow = await upsertCatalogItem(trx, {
        libraryId: targetLibraryId,
        itemType: item.itemType,
        parentId: targetParentId,
        title: item.title,
        sortTitle: item.sortTitle,
        year: item.year,
        communityRating: item.communityRating,
        addedAtMs: item.addedAtMs,
        updatedAtMs: item.updatedAtMs,
      });
      itemIdMap.set(item.id, createdRow.id);
      result.items.created++;
      touchLibrary(targetLibraryId).itemsCreated++;
      await writeSatellite(createdRow.id, item);
      await writeRelations(createdRow.id, item);
    }

    async function findExistingItemId(
      item: ArchiveItem,
      targetLibraryId: string,
      targetParentId: string | null
    ): Promise<string | undefined> {
      switch (item.itemType) {
        case 'movie':
          return (await findMovieByTitleYear(trx, { libraryId: targetLibraryId, title: item.title, year: item.year }))?.id;
        case 'series':
          return (await findSeriesByTitle(trx, targetLibraryId, item.title))?.id;
        case 'artist':
          return (await findArtistByName(trx, targetLibraryId, item.title))?.id;
        case 'season':
          return (await findSeasonByNumber(trx, targetParentId!, item.seasonNumber))?.id;
        case 'episode':
          return (await findEpisodeByNumber(trx, targetParentId!, item.episodeNumber))?.id;
        case 'album':
          return (await findAlbumByTitle(trx, targetParentId!, item.title))?.id;
        case 'track':
          return (await findTrackByNumberOrTitle(trx, targetParentId!, { trackNumber: item.trackNumber, title: item.title }))?.id;
      }
    }

    for (const item of tier0) {
      await processItem(item, libraryIdMap.get(item.libraryId)!, null);
    }
    for (const item of tier1) {
      const parentArchiveId = item.itemType === 'season' ? item.seriesId : item.artistId;
      await processItem(item, libraryIdMap.get(item.libraryId)!, itemIdMap.get(parentArchiveId)!);
    }
    for (const item of tier2) {
      const parentArchiveId = item.itemType === 'episode' ? item.seasonId : item.albumId;
      await processItem(item, libraryIdMap.get(item.libraryId)!, itemIdMap.get(parentArchiveId)!);
    }

    // ---- progress --------------------------------------------------------
    for (const p of archive.progress) {
      const targetItemId = itemIdMap.get(p.itemId);
      if (!targetItemId) continue; // referential check already guarantees this never happens; defensive only.
      await insertProgressExact(trx, {
        userId: payload.requestedByUserId,
        itemId: targetItemId,
        positionMs: p.positionMs,
        durationMs: p.durationMs,
        state: p.state,
        playCount: p.playCount,
        updatedAtMs: p.updatedAtMs,
      });
      result.progress.created++;
    }

    // ---- one scan.completed-style summary event per touched library ------
    const completedAtMs = clock();
    for (const [targetLibraryId, touch] of libraryTouches) {
      if (!touch.isNew && touch.itemsCreated === 0) continue; // nothing actually changed there.
      await writeEvent(trx, {
        type: 'scan.completed',
        tsMs: completedAtMs,
        actorUserId: payload.requestedByUserId,
        payload: {
          jobId: meta.jobId,
          libraryId: targetLibraryId,
          full: true,
          itemsAdded: touch.itemsCreated,
          itemsUpdated: 0,
          itemsRemoved: 0,
          durationMs: completedAtMs - startedAtMs,
          status: 'succeeded',
          completedAtMs,
        },
      });
    }
  });

  result.durationMs = clock() - startedAtMs;

  // Completion-summary checkpoint (see "Transaction strategy" above for why
  // this cannot be live/mid-run). Best-effort: never fails the job over
  // bookkeeping. Needs a real, now-committed library id to satisfy
  // scan_checkpoints' NOT NULL FK — skipped when the archive touched none.
  const anyLibraryId = libraryTouches.keys().next().value;
  if (anyLibraryId) {
    try {
      await writeCheckpoint(deps.db, {
        jobId: meta.jobId,
        libraryId: anyLibraryId,
        phase: 'completed',
        filesSeen: archive.items.length,
        filesProcessed: result.items.created + result.items.skipped,
        updatedAtMs: clock(),
      });
    } catch (err) {
      log(`import job ${meta.jobId}: best-effort completion checkpoint write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`import job ${meta.jobId} completed: ${JSON.stringify(result)}`);
  return result;
}

/** Adapter for `queue.work('import', ...)` (packages/jobs/src/queue.ts's
 *  `JobHandler<'import'>` shape — returns Promise<void>). The typed result
 *  itself is only reachable by calling runImport() directly, e.g. tests and
 *  any future in-process caller — see this module's header, "Transaction
 *  strategy" section, for why nothing durable persists it today. */
export function createImportConsumerHandler(deps: ImportConsumerDeps): JobHandler<'import'> {
  return async (payload, meta) => {
    await runImport(deps, payload, meta);
  };
}
