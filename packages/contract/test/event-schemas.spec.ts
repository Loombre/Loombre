// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/event-schemas.spec.ts
//
// Ajv validation for the event-schemas directory (docs/PLAN.md §4.3,
// event-schemas/README.md). Asserts:
//   1. Every *.schema.json file is a syntactically valid, Ajv-compilable
//      draft 2020-12 schema.
//   2. envelope.schema.json's closed `type` enum has exactly one payload
//      schema file per entry, named `<type>.schema.json` (dots literal) —
//      no enum value without a file, no file without an enum value.
//   3. Every payload schema uses `additionalProperties: false` at the top
//      level (event-schemas/README.md's additive-only policy).
//   4. A minimal well-formed sample envelope + payload for each closed type
//      validates successfully end to end.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// draft 2020-12 schemas ($schema: .../2020-12/schema) need the Ajv2020
// build — the default `Ajv` export only ships the draft-07 meta-schema.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, "../event-schemas");

function loadSchema(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, filename), "utf8")) as Record<
    string,
    unknown
  >;
}

const envelope = loadSchema("envelope.schema.json");
const envelopeTypeEnum = (
  (envelope.properties as Record<string, { enum: string[] }>).type.enum
) as string[];

const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
const payloadFiles = schemaFiles.filter((f) => f !== "envelope.schema.json");

// L3 (owner brief): envelope.schema.json carries one custom vendor keyword,
// `x-loombre-admin-only-event-types` (event-schemas/README.md "Admin-only
// event types" — a validation-inert machine-readable mirror of
// packages/shared/src/admin-only-event-types.ts, parity-tested by
// admin-only-event-types-parity.spec.ts). Ajv's strict mode otherwise
// throws "unknown keyword" for it; registering it explicitly (rather than
// disabling strictSchema wholesale) keeps strict mode catching genuine
// schema-authoring typos everywhere else.
function registerAdminOnlyKeyword(instance: Ajv2020): void {
  instance.addKeyword({ keyword: "x-loombre-admin-only-event-types", schemaType: "array" });
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
registerAdminOnlyKeyword(ajv);
addFormats(ajv);

describe("event-schemas (docs/PLAN.md §4.3)", () => {
  it("every *.schema.json file compiles under Ajv (draft 2020-12)", () => {
    for (const file of schemaFiles) {
      // Fresh instance per file: the shared `ajv` below caches compiled
      // schemas by $id, and would throw "already exists" on a second
      // compile of the same file.
      const freshAjv = new Ajv2020({ allErrors: true, strict: true });
      registerAdminOnlyKeyword(freshAjv);
      addFormats(freshAjv);
      const schema = loadSchema(file);
      expect(() => freshAjv.compile(schema), `${file} failed to compile`).not.toThrow();
    }
  });

  it("envelope enum has exactly 30 types (15 through Addendum A + 6 plugin.* [LPP] + 2 watchlist.* [W2 L3] + 1 metadata.match-candidates [W2 L2] + 1 user.restricted-pin-reset [H2] + 1 probe.failed [owner ledger L1] + 1 stash.provider.disabled [Stash SQLite metadata sync, S3/K12] + 2 stash.sync.* [Stash SQLite metadata sync, S8/K12, Lane C] + 1 mail.failed [optional mail transport run, E6/M6])", () => {
    expect(envelopeTypeEnum).toHaveLength(30);
    expect(envelopeTypeEnum).toEqual(
      expect.arrayContaining([
        "item.added",
        "item.updated",
        "file.relocated",
        "playback.started",
        "playback.ended",
        "playback.progress",
        "progress.updated",
        "user.created",
        "library.created",
        "scan.started",
        "scan.completed",
        "restricted.locked",
        "restricted.unlocked",
        "watchlist.added",
        "watchlist.removed",
        "job.updated",
        "settings.updated",
        "plugin.registered",
        "plugin.updated",
        "plugin.enabled",
        "plugin.disabled",
        "plugin.removed",
        "plugin.health-changed",
        "metadata.match-candidates",
        "user.restricted-pin-reset",
        "probe.failed",
        "stash.provider.disabled",
        "stash.sync.started",
        "stash.sync.completed",
      ]),
    );
  });

  it("every envelope enum value has exactly one matching payload schema file, bijectively", () => {
    const expectedFiles = envelopeTypeEnum.map((t) => `${t}.schema.json`).sort();
    expect(payloadFiles.slice().sort()).toEqual(expectedFiles);
  });

  it("every payload schema declares additionalProperties: false at the top level", () => {
    for (const file of payloadFiles) {
      const schema = loadSchema(file);
      expect(schema.additionalProperties, `${file} must set additionalProperties: false`).toBe(
        false,
      );
    }
  });

  it("envelope.schema.json itself declares additionalProperties: false", () => {
    expect(envelope.additionalProperties).toBe(false);
  });

  describe("sample payload validation per type", () => {
    const validateEnvelope = ajv.compile(envelope);

    const samples: Record<string, Record<string, unknown>> = {
      "item.added": {
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        itemType: "movie",
        contentClass: "general",
        parentId: null,
        addedAtMs: 1_700_000_000_000,
      },
      "item.updated": {
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        itemType: "movie",
        contentClass: "general",
        changedFields: ["title", "overview"],
        updatedAtMs: 1_700_000_000_000,
      },
      "file.relocated": {
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        mediaFileId: "018f6f1e-0000-7000-8000-000000000003",
        previousPath: "/old/path.mkv",
        newPath: "/new/path.mkv",
        contentHash: "abc123",
        relocatedAtMs: 1_700_000_000_000,
      },
      "playback.started": {
        sessionId: "018f6f1e-0000-7000-8000-000000000004",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        deviceId: "018f6f1e-0000-7000-8000-000000000006",
        decision: "direct-play",
        startedAtMs: 1_700_000_000_000,
      },
      "playback.ended": {
        sessionId: "018f6f1e-0000-7000-8000-000000000004",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        deviceId: "018f6f1e-0000-7000-8000-000000000006",
        reason: "completed",
        endedAtMs: 1_700_000_001_000,
      },
      "playback.progress": {
        sessionId: "018f6f1e-0000-7000-8000-000000000004",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        deviceId: "018f6f1e-0000-7000-8000-000000000006",
        positionMs: 30_000,
        durationMs: 6_480_000,
        updatedAtMs: 1_700_000_030_000,
      },
      "progress.updated": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        positionMs: 1000,
        state: "in-progress",
        playCount: 1,
        updatedAtMs: 1_700_000_000_000,
      },
      "user.created": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
        username: "casual",
        isAdmin: false,
        createdAtMs: 1_700_000_000_000,
      },
      "library.created": {
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        name: "Movies",
        mediaKind: "movie",
        contentClass: "general",
        createdAtMs: 1_700_000_000_000,
      },
      "scan.started": {
        jobId: "018f6f1e-0000-7000-8000-000000000007",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        full: true,
        startedAtMs: 1_700_000_000_000,
      },
      "scan.completed": {
        jobId: "018f6f1e-0000-7000-8000-000000000007",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        full: true,
        itemsAdded: 1,
        itemsUpdated: 0,
        itemsRemoved: 0,
        durationMs: 5000,
        status: "succeeded",
        completedAtMs: 1_700_000_005_000,
      },
      "restricted.locked": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
      },
      "restricted.unlocked": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
      },
      "watchlist.added": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
      },
      "watchlist.removed": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
        itemId: "018f6f1e-0000-7000-8000-000000000001",
      },
      "job.updated": {
        jobId: "018f6f1e-0000-7000-8000-000000000006",
        jobType: "scan",
        status: "active",
        progress: { current: 150, total: 500, phase: "probe" },
        errorMessage: null,
        updatedAtMs: 1_753_300_000_000,
      },
      "settings.updated": {
        actorUserId: "018f6f1e-0000-7000-8000-000000000005",
        key: "transcode.maxSimultaneousTranscodes",
        oldValue: 1,
        newValue: 2,
      },
      "plugin.registered": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        baseUrl: "http://127.0.0.1:4123",
        contentClass: "general",
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypes: [],
        registeredAtMs: 1_700_000_000_000,
      },
      "plugin.updated": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        change: "manifest",
        oldValue: "0.1.0",
        newValue: "0.1.1",
        updatedAtMs: 1_700_000_000_000,
      },
      "plugin.enabled": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        enabledAtMs: 1_700_000_000_000,
      },
      "plugin.disabled": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        reason: "breaker",
        disabledAtMs: 1_700_000_000_000,
      },
      "plugin.removed": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        removedAtMs: 1_700_000_000_000,
      },
      "plugin.health-changed": {
        pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
        name: "lpp-reference-provider",
        previousState: "unknown",
        newState: "healthy",
        changedAtMs: 1_700_000_000_000,
      },
      "metadata.match-candidates": {
        itemId: "018f6f1e-0000-7000-8000-000000000001",
        jobId: "018f6f1e-0000-7000-8000-000000000008",
        candidates: [
          { provider: "tmdb", externalId: "603", title: "The Matrix", year: 1999, confidence: 97.5, isBest: true },
          { provider: "tmdb", externalId: "604", title: "The Matrix Reloaded", year: 2003, confidence: 41.2, isBest: false },
        ],
        searchedAtMs: 1_700_000_000_000,
      },
      "user.restricted-pin-reset": {
        userId: "018f6f1e-0000-7000-8000-000000000005",
        username: "casual",
        actor: "cli",
      },
      "probe.failed": {
        mediaFileId: "018f6f1e-0000-7000-8000-000000000003",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        path: "/media/movies/Garbage File.mkv",
        code: "nonzero-exit",
      },
      "stash.provider.disabled": {
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        seenVersion: 58,
        supportedMin: 67,
        supportedMax: 85,
        notice: "Stash schema v58 unsupported; supported: 67-85",
      },
      "stash.sync.started": {
        jobId: "018f6f1e-0000-7000-8000-000000000009",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        mode: "full",
        startedAtMs: 1_700_000_000_000,
      },
      "stash.sync.completed": {
        jobId: "018f6f1e-0000-7000-8000-000000000009",
        libraryId: "018f6f1e-0000-7000-8000-000000000002",
        mode: "full",
        status: "succeeded",
        counts: { matched: 100, updated: 12, unmatched: 3, stale: 1, skipped: 0 },
        durationMs: 45_000,
        completedAtMs: 1_700_000_045_000,
      },
      "mail.failed": {
        templateId: "invite",
        to: "someone@example.com",
        smtpError: "535 5.7.8 Authentication failed",
        jobId: "018f6f1e-0000-7000-8000-00000000000a",
      },
    };

    it("samples cover every enum type", () => {
      expect(Object.keys(samples).sort()).toEqual(envelopeTypeEnum.slice().sort());
    });

    for (const type of envelopeTypeEnum) {
      it(`payload sample for ${type} validates against both envelope and its payload schema`, () => {
        const payload = samples[type];
        expect(payload, `no sample registered for ${type}`).toBeDefined();

        const envelopeSample = {
          id: "018f6f1e-0000-7000-8000-00000000000f",
          type,
          tsMs: 1_700_000_000_000,
          actorUserId: null,
          payload,
        };
        const envelopeValid = validateEnvelope(envelopeSample);
        expect(envelopeValid, ajv.errorsText(validateEnvelope.errors)).toBe(true);

        const payloadSchema = loadSchema(`${type}.schema.json`);
        const validatePayload = ajv.compile(payloadSchema);
        const payloadValid = validatePayload(payload);
        expect(payloadValid, ajv.errorsText(validatePayload.errors)).toBe(true);
      });
    }
  });
});
