// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/user-settings.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for H1 (owner ledger item 6, closed): GET/PUT /users/me/settings
// now REALLY persists user_settings.prefs (apps/server/src/catalog/
// users.controller.ts's putMySettings, via @loombre/db's updateUserPrefs),
// and the §2.6 TrackSelection cascade (apps/server/src/playback/
// resolve-selection.ts) genuinely consumes the stored preference — the
// "seam" the owner brief calls out explicitly, not just a round-trip.
//
// Self-sufficient: own ensureTestDatabase suffix, own reset+reseed — same
// convention as apps/server/test/playback.e2e.spec.ts, whose fixture-
// insertion pattern (raw Kysely inserts for a multi-stream media_files row)
// this file reuses directly.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function loginDeviceProfile(profileId: string) {
  return {
    profileId,
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

// The seam-proving fixture's own device profile: supports h264/1080p8bit
// video, ONLY aac (2ch) audio (so the 'flac' audio stream below is always
// audio-codec-unsupported, and the 'aac' one is always a clean copy —
// isolating WHICH stream got selected via the resulting plan().audio.action
// rather than needing plan() to echo back a raw stream index, which
// PlaybackPlanAudio's §5 shape doesn't carry), and renders 'subrip' text
// subtitles.
function seamDeviceProfile() {
  return {
    profileId: "user-settings-seam-device",
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let casualToken: string;
let seamItemId: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "user-settings-e2e-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "user_settings_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "user-settings-e2e-casual",
    deviceProfile: loginDeviceProfile("user-settings-e2e-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  // §2.6 seam fixture: one video stream, TWO audio streams (distinguishable
  // by codec support so the resulting plan() output reveals which one was
  // selected), TWO forced subtitle streams (distinguishable by streamIndex,
  // which PlaybackPlanSubtitle DOES carry).
  const db = createDb(databaseUrl);
  try {
    const harborLights = await db
      .selectFrom("catalog_items")
      .select(["id", "library_id"])
      .where("title", "=", "Harbor Lights")
      .executeTakeFirstOrThrow();
    const now = Date.now();

    const item = await db
      .insertInto("catalog_items")
      .values({
        library_id: harborLights.library_id,
        item_type: "movie",
        parent_id: null,
        title: "Preference Seam Fixture",
        sort_title: "preference seam fixture",
        year: null,
        community_rating: null,
        added_at_ms: now,
        updated_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    seamItemId = item.id;

    const file = await db
      .insertInto("media_files")
      .values({
        item_id: seamItemId,
        path: `/data/movies/preference-seam-fixture-${seamItemId}.mkv`,
        content_hash: `e2e-seam-fixture-hash-${seamItemId}`,
        size_bytes: 10_000,
        container: "mkv",
        duration_ms: 90 * 60_000,
        probed_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("media_streams")
      .values({
        file_id: file.id,
        stream_index: 0,
        stream_type: "video",
        codec: "h264",
        width: 1920,
        height: 1080,
        bit_depth: 8,
        frame_rate: 24,
        is_default: true,
        is_forced: false,
      })
      .execute();

    // Audio index 1: 'eng', isDefault, codec 'flac' — NOT in the seam
    // device's audio list -> always audio-codec-unsupported -> transcode.
    await db
      .insertInto("media_streams")
      .values({
        file_id: file.id,
        stream_index: 1,
        stream_type: "audio",
        codec: "flac",
        channels: 2,
        sample_rate: 48000,
        language: "eng",
        is_default: true,
        is_forced: false,
      })
      .execute();

    // Audio index 2: 'fra', NOT isDefault, codec 'aac' — matches the seam
    // device's only audio entry exactly -> always a clean copy.
    await db
      .insertInto("media_streams")
      .values({
        file_id: file.id,
        stream_index: 2,
        stream_type: "audio",
        codec: "aac",
        channels: 2,
        sample_rate: 48000,
        language: "fra",
        is_default: false,
        is_forced: false,
      })
      .execute();

    // Subtitle index 3: forced, 'eng'.
    await db
      .insertInto("media_streams")
      .values({
        file_id: file.id,
        stream_index: 3,
        stream_type: "subtitle",
        codec: "subrip",
        language: "eng",
        is_default: false,
        is_forced: true,
      })
      .execute();

    // Subtitle index 4: forced, 'fra'.
    await db
      .insertInto("media_streams")
      .values({
        file_id: file.id,
        stream_index: 4,
        stream_type: "subtitle",
        codec: "subrip",
        language: "fra",
        is_default: false,
        is_forced: true,
      })
      .execute();
  } finally {
    await db.destroy();
  }
}, 30_000);

afterAll(async () => {
  await app.close();
});

function casual() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casualToken}`),
    put: (url: string) => request(app.getHttpServer()).put(url).set("Authorization", `Bearer ${casualToken}`),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${casualToken}`),
  };
}

/** A schema-valid PUT body, with overrides — every test starts from a full
 *  valid shape so it only has to spell out what it's actually testing. */
function settingsBody(overrides: Record<string, unknown> = {}) {
  return {
    restrictedOptIn: false,
    locale: "en-US",
    theme: "system",
    subtitlePreferredLanguage: null,
    audioPreferredLanguage: null,
    autoplayNextEpisode: true,
    updatedAtMs: 0,
    ...overrides,
  };
}

async function planForSeamFixture(prefs: { audioPreferredLanguage?: string | null; subtitlePreferredLanguage?: string | null }) {
  await casual()
    .put("/users/me/settings")
    .send(
      settingsBody({
        audioPreferredLanguage: prefs.audioPreferredLanguage ?? null,
        subtitlePreferredLanguage: prefs.subtitlePreferredLanguage ?? null,
      }),
    );
  return casual()
    .post("/playback/plan")
    .send({
      itemId: seamItemId,
      device: seamDeviceProfile(),
      network: { maxBitrateBps: 50_000_000, isLocal: true },
      mode: "stream",
    });
}

describe("GET/PUT /users/me/settings (H1: user_settings.prefs is a real writer)", () => {
  // packages/db/seed/seed.mjs seeds casual's user_settings.prefs with ONLY
  // `{"theme":"light"}` (no locale/language/autoplay keys at all) — this
  // doubles as proof that mapSettings' per-key fallback (A-5) is genuinely
  // per-KEY, not "any prefs at all short-circuits every default": the one
  // key seed actually set is honored, every other key still falls back.
  it("GET reflects seed's real (partial) prefs, defaulting every key seed never set", async () => {
    const res = await casual().get("/users/me/settings");
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe("light");
    expect(res.body.locale).toBe("en-US");
    expect(res.body.subtitlePreferredLanguage).toBeNull();
    expect(res.body.audioPreferredLanguage).toBeNull();
    expect(res.body.autoplayNextEpisode).toBe(true);
  });

  it("PUT persists locale/theme/language prefs/autoplay, and GET reflects them afterward", async () => {
    const put = await casual()
      .put("/users/me/settings")
      .send(
        settingsBody({
          locale: "fr-FR",
          theme: "dark",
          subtitlePreferredLanguage: "fra",
          audioPreferredLanguage: "jpn",
          autoplayNextEpisode: false,
        }),
      );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.locale).toBe("fr-FR");
    expect(put.body.theme).toBe("dark");
    expect(put.body.subtitlePreferredLanguage).toBe("fra");
    expect(put.body.audioPreferredLanguage).toBe("jpn");
    expect(put.body.autoplayNextEpisode).toBe(false);

    const get = await casual().get("/users/me/settings");
    expect(get.status).toBe(200);
    expect(get.body).toEqual(put.body);
  });

  it("a null language preference clears back to no-preference", async () => {
    await casual()
      .put("/users/me/settings")
      .send(settingsBody({ audioPreferredLanguage: "eng", subtitlePreferredLanguage: "eng" }));
    const cleared = await casual()
      .put("/users/me/settings")
      .send(settingsBody({ audioPreferredLanguage: null, subtitlePreferredLanguage: null }));
    expect(cleared.status).toBe(200);
    expect(cleared.body.audioPreferredLanguage).toBeNull();
    expect(cleared.body.subtitlePreferredLanguage).toBeNull();
  });

  it("restrictedOptIn is accepted but IGNORED — it never changes via this endpoint", async () => {
    const before = await casual().get("/users/me/settings");
    const put = await casual()
      .put("/users/me/settings")
      .send(settingsBody({ restrictedOptIn: !before.body.restrictedOptIn }));
    expect(put.status).toBe(200);
    expect(put.body.restrictedOptIn).toBe(before.body.restrictedOptIn);
  });

  it("updatedAtMs is accepted but IGNORED — no optimistic-concurrency check exists", async () => {
    const put = await casual().put("/users/me/settings").send(settingsBody({ updatedAtMs: 123 }));
    expect(put.status).toBe(200);
    expect(put.body.updatedAtMs).not.toBe(123);
    expect(typeof put.body.updatedAtMs).toBe("number");
  });

  it("an unknown property -> 422 (additionalProperties:false)", async () => {
    const res = await casual()
      .put("/users/me/settings")
      .send(settingsBody({ notARealField: true }));
    expect(res.status).toBe(422);
  });

  it("an invalid theme -> 422", async () => {
    const res = await casual().put("/users/me/settings").send(settingsBody({ theme: "sepia" }));
    expect(res.status).toBe(422);
  });

  it("a language code that is well-shaped but not a known language -> 422", async () => {
    const res = await casual().put("/users/me/settings").send(settingsBody({ audioPreferredLanguage: "xxx" }));
    expect(res.status).toBe(422);
  });

  it("a locale over 35 characters -> 422", async () => {
    const res = await casual()
      .put("/users/me/settings")
      .send(settingsBody({ locale: "x".repeat(36) }));
    expect(res.status).toBe(422);
  });

  it("bodyless PUT -> 422 (locale/theme/etc. are all required)", async () => {
    const res = await casual().put("/users/me/settings").send();
    expect(res.status).toBe(422);
  });

  // The "lying-save bug" this closes (commit 9552333): a rejected PUT must
  // never be indistinguishable from a successful one at the HTTP layer —
  // the web layer's own "Saved" idiom (AccountSection.test.tsx) depends on
  // a non-2xx status to show the error state instead.
  it("a rejected PUT does not persist any of its fields (locale stays whatever it was before)", async () => {
    const before = await casual().get("/users/me/settings");
    const rejected = await casual()
      .put("/users/me/settings")
      .send(settingsBody({ locale: before.body.locale === "keep-me" ? "changed" : "keep-me", theme: "not-a-real-theme" }));
    expect(rejected.status).toBe(422);

    const after = await casual().get("/users/me/settings");
    expect(after.body.locale).toBe(before.body.locale);
  });
});

describe("§2.6 TrackSelection consumes DB-stored prefs (H1 seam, docs/PLAYBACK.md §2.6)", () => {
  it("no audio preference -> isDefault stream (index 1, 'eng'/flac) -> audio-codec-unsupported/transcode", async () => {
    const res = await planForSeamFixture({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.audio.action).toBe("transcode");
    const codes = (res.body.reasons as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toContain("audio-codec-unsupported");
  });

  it("audioPreferredLanguage:'fra' (stored via PUT) -> the 'fra'/aac stream is selected -> a clean copy", async () => {
    const res = await planForSeamFixture({ audioPreferredLanguage: "fra" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.audio.action).toBe("copy");
    const codes = (res.body.reasons as Array<{ code: string }>).map((r) => r.code);
    expect(codes).not.toContain("audio-codec-unsupported");
  });

  it("no subtitle preference -> forced subtitle auto-matches the RESOLVED audio language ('fra' pref -> 'fra' forced subtitle, index 4)", async () => {
    const res = await planForSeamFixture({ audioPreferredLanguage: "fra" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.subtitle.strategy).not.toBe("none");
    expect(res.body.subtitle.streamIndex).toBe(4);
  });

  it("an explicit subtitlePreferredLanguage OVERRIDES the audio-language auto-match (A-2): 'eng' pref selects the 'eng' forced subtitle (index 3) even though audio resolves to 'fra'", async () => {
    const res = await planForSeamFixture({ audioPreferredLanguage: "fra", subtitlePreferredLanguage: "eng" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.audio.action).toBe("copy"); // still the 'fra' stream
    expect(res.body.subtitle.strategy).not.toBe("none");
    expect(res.body.subtitle.streamIndex).toBe(3);
  });

  it("an unset audioPreferredLanguage combined with a subtitlePreferredLanguage still honors the subtitle preference alone", async () => {
    const res = await planForSeamFixture({ subtitlePreferredLanguage: "eng" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Audio falls back to isDefault ('eng'/flac); subtitle pref 'eng' also
    // matches the resolved audio language here, so both agree on index 3 —
    // this case is about the pref being READ from the DB and applied, not
    // about disambiguating it from the audio-language fallback (the
    // previous test already isolates that).
    expect(res.body.subtitle.streamIndex).toBe(3);
  });
});
