// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/probe/terminal-failure-hook.spec.ts
//
// Owner ledger L1, adjudication A-3/A-5(d) — live-DB test for the probe
// job's onTerminalFailure hook (apps/worker/src/probe/terminal-failure-
// hook.ts), independent of pg-boss/the job queue entirely: this calls the
// hook function directly against a real media_files/catalog_items row,
// the same "test the seam, not the whole worker process" split
// packages/jobs/test/queue-driver.spec.ts uses for the queue side of A-3.
//
// This is the architecture-honest replacement for the brief's false
// "ingestion already requires a successful ffprobe" premise: a terminal
// probe failure used to write nothing durable and surface nowhere but the
// generic jobs ledger's free-text last_error. This hook turns that into an
// admin-only `probe.failed` outbox event instead.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCatalogItemById, upsertCatalogItem, createMediaFile } from "@loombre/db/internal";
import { createProbeTerminalFailureHook } from "../../src/probe/terminal-failure-hook.js";
import { ProbeError } from "../../src/probe/errors.js";
import { createLibrary, makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

describe("createProbeTerminalFailureHook (owner ledger L1, A-3/A-5d)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let libraryId: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    libraryId = await createLibrary(raw, { name: "Probe Failure Library", mediaKind: "movie", paths: ["/media/probe-fail"] });
  });

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  async function makeMediaFile(pathSuffix: string) {
    const now = Date.now();
    const item = await upsertCatalogItem(dbHandle, {
      libraryId,
      itemType: "movie",
      title: `Garbage File ${pathSuffix}`,
      sortTitle: `garbage file ${pathSuffix}`,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const file = await createMediaFile(dbHandle, {
      itemId: item.id,
      path: `/media/probe-fail/Garbage File ${pathSuffix}.mts`,
      contentHash: `hash-${pathSuffix}`,
      sizeBytes: 512,
    });
    return { item, file };
  }

  it("writes a probe.failed event with the ProbeError's code and the resolved libraryId", async () => {
    const { file } = await makeMediaFile("A");
    const hook = createProbeTerminalFailureHook(dbHandle);
    const error = new ProbeError("nonzero-exit", "ffprobe exited 1", { stderrTail: "moov atom not found" });

    await hook({ mediaFileId: file.id }, error);

    const result = await raw.query<{ payload: { mediaFileId: string; libraryId: string; path: string; code: string } }>(
      "SELECT payload FROM events WHERE type = 'probe.failed' AND payload->>'mediaFileId' = $1",
      [file.id],
    );
    expect(result.rows).toHaveLength(1);
    const payload = result.rows[0]!.payload;
    expect(payload.mediaFileId).toBe(file.id);
    expect(payload.libraryId).toBe(libraryId);
    expect(payload.path).toBe(file.path);
    expect(payload.code).toBe("nonzero-exit");
    // NEVER a free-text message — stderr tails never enter the event
    // stream (CLAUDE.md invariant 7 spirit, contract description).
    expect(JSON.stringify(payload)).not.toContain("moov atom not found");
  });

  it("maps a non-ProbeError thrown value to code 'unknown' (defensive default)", async () => {
    const { file } = await makeMediaFile("B");
    const hook = createProbeTerminalFailureHook(dbHandle);

    await hook({ mediaFileId: file.id }, new Error("some other kind of failure"));

    const result = await raw.query<{ payload: { code: string } }>(
      "SELECT payload FROM events WHERE type = 'probe.failed' AND payload->>'mediaFileId' = $1",
      [file.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.payload.code).toBe("unknown");
  });

  it("writes NO event when the media_files row is gone (deleted mid-flight) — no orphan event", async () => {
    const hook = createProbeTerminalFailureHook(dbHandle);
    const goneId = "018f0007-0000-7000-8000-000000000099";

    await hook({ mediaFileId: goneId }, new ProbeError("timeout", "ffprobe timed out"));

    const result = await raw.query<{ id: string }>(
      "SELECT id FROM events WHERE type = 'probe.failed' AND payload->>'mediaFileId' = $1",
      [goneId],
    );
    expect(result.rows).toHaveLength(0);
  });

  it("deleting the owning catalog item cascades to media_files (DB-enforced FK) — proving the 'item gone' branch is unreachable via real deletion, not merely untested", async () => {
    const { item, file } = await makeMediaFile("C");
    await raw.query("DELETE FROM catalog_items WHERE id = $1", [item.id]);

    const stillThereItem = await getCatalogItemById(dbHandle, item.id);
    expect(stillThereItem).toBeUndefined();
    // media_files.item_id is NOT NULL REFERENCES catalog_items(id) ON
    // DELETE CASCADE (migrations/0001_init.sql) — the file row is gone
    // too, so the hook's getMediaFileById guard alone is what the "item
    // gone" defensive check in the source can never actually observe
    // outside this constraint. Documented here rather than asserted as a
    // separate hook code path, since there isn't a way to construct that
    // state against a real Postgres FK.
    const fileGone = await raw.query<{ id: string }>("SELECT id FROM media_files WHERE id = $1", [file.id]);
    expect(fileGone.rows).toHaveLength(0);

    const hook = createProbeTerminalFailureHook(dbHandle);
    await hook({ mediaFileId: file.id }, new ProbeError("invalid-json", "bad json"));

    const result = await raw.query<{ id: string }>(
      "SELECT id FROM events WHERE type = 'probe.failed' AND payload->>'mediaFileId' = $1",
      [file.id],
    );
    expect(result.rows).toHaveLength(0);
  });
});
