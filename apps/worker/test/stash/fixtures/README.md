# Stash schema fixtures (S3)

Checked-in `.sql` DDL+seed fixtures backing the pinned supported schema
range (`apps/worker/src/stash/guard.ts`'s `STASH_SUPPORTED_SCHEMA_MIN`/
`STASH_SUPPORTED_SCHEMA_MAX`). Built into real SQLite files at test time by
`build-fixture-db.ts` (never committed as binaries — mirrors the repo's
existing `test-fixtures/media/` "gitignored, generated" convention for the
binary artifact, while the `.sql` source itself IS checked in, per S3's
explicit "checked-in schema fixtures" requirement).

## Provenance

DDL derived from a research pass over `github.com/stashapp/stash`
(`develop` HEAD, schema 85, fetched 2026-08-01): all 85 `.up.sql` migration
files under `pkg/sqlite/migrations/` plus their Go pre/post-migration hooks
were downloaded and replayed against a real `sqlite3` CLI to get actual
`.schema` output, cross-checked against the Go hooks for schema-altering
steps a pure-SQL replay would miss (e.g. `45_postmigrate.go` dropping the
legacy `scenes_cover`/`tags_image`/etc. tables after migrating their data
into the new `blobs` table). Key source files:

- `pkg/sqlite/migrate.go`, `pkg/sqlite/database.go` — schema-version
  machinery (`schema_migrations`, golang-migrate's default driver table;
  `appSchemaVersion`).
- `pkg/sqlite/migrations/{1_initial,32_files,40_newratings,45_blobs,
  45_postmigrate.go,84_folder_basename,84_migrate.go}.up.sql` — the DDL
  evolution this fixture set is built from.
- Release tag -> schema version derived from `gh api
  repos/stashapp/stash/releases` plus a per-tag fetch of
  `pkg/sqlite/database.go`'s `appSchemaVersion` constant.

## Fidelity

These fixtures are a **representative subset** of the real upstream DDL —
only the tables/columns `apps/worker/src/stash/read-model.ts` actually
reads (per the recon pointer's field list: scenes' title/details/date/
rating/updated_at, performers' aliases/birthdate/country/measurements,
studios' parent+image, tags' hierarchy, markers' seconds+title+primary
tag, files' path/size/oshash). Notably NOT modeled (out of scope for
Loombre's read-model — S5: "Duration/resolution stay Loombre-probed"):
`video_files`' technical columns (codec/width/height/framerate/bitrate),
performer career-date columns (schema-78/85 churn, unrelated to the
mapped-field list), and the `movies`/`galleries`/`images` entity families
(Loombre's Stash provider maps `movie`-kind items only, K7).

`performer_aliases` and the exact `blobs` filesystem-fanout dual-storage
mode (see `pkg/sqlite/blob.go`/`pkg/sqlite/blob/fs.go` — a checksum row
can have `blob IS NULL` when Stash is configured for filesystem-backed
blob storage instead of in-database storage) are modeled per the research
pass's findings but are the least-verified piece (no committed Stash
instance was available to inspect directly this session) — flagged for
Lane B / the owner's real-Stash-DB validation pass (STATE.md run posture:
"subset run (~500 scenes, copied real Stash DB) is the deliverable this
session can stage").

## Release history -> schema version (informs the pinned range)

| Stash tag | Published | Schema version |
|---|---|---|
| v0.31.1 | 2026-04-13 | 85 |
| v0.31.0 | 2026-03-30 | 85 |
| v0.30.1 | 2025-12-18 | 75 |
| v0.30.0 | 2025-12-16 | 75 |
| v0.29.3 | 2025-11-06 | 72 |
| v0.29.0 | 2025-10-21 | 72 |
| v0.28.1 | 2025-03-19 | 72 |
| v0.28.0 | 2025-03-18 | 72 |
| v0.27.2 | 2024-10-15 | 68 |
| v0.27.0 | 2024-09-23 | 67 |
| v0.26.2 | 2024-06-27 | 58 |
| v0.26.0 | 2024-06-03 | 58 |

## Fixture inventory

- `schema-v67-supported-min.sql` — `STASH_SUPPORTED_SCHEMA_MIN` (v0.27.0).
  Pre-84 `folders` shape (no `basename` column) — proves the read-model's
  fallback path for that column's absence.
- `schema-v85-supported-max.sql` — `STASH_SUPPORTED_SCHEMA_MAX` (v0.31.1,
  == develop HEAD; nothing newer exists upstream as of this recon). Post-84
  `folders` shape (`basename` present).
- `schema-v58-unsupported.sql` — one version below the pinned range
  (v0.26.0) — the S3 disable-path fixture. Deliberately minimal
  (`schema_migrations` only): the guard disables before ever querying
  anything else, so no other table is needed to prove that path.

"Per supported version" (S3's phrasing) is interpreted here as
REPRESENTATIVE coverage bracketing the range plus its one meaningful
internal DDL shape change (the `folders.basename` boundary at schema 84),
not one fixture per each of the 19 individual versions 67-85 — the
guard's own logic is a simple integer-range check with no per-version
branching, so the versions in between 67 and 85 exercise no code path
these two fixtures don't already cover.

## Pin range justification

67-85 covers Stash v0.27.0 (2024-09-23) through v0.31.1 (2026-04-13) — the
newest stable release as of this recon (2026-08-01), roughly the last two
years of stable release lines. The owner runs a current Stash instance
(STATE.md run posture); pinning down to the oldest schema still in
practical use rather than the entire historical range keeps the read-model
from having to carry indefinite legacy-shape branches for versions no
supported release line still ships.
