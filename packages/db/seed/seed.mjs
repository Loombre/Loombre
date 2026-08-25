#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/seed/seed.mjs
//
// Deterministic-shape seed data for local dev and the leak-impossibility
// test suite (packages/db/test/leak.spec.ts). "Deterministic" here means the
// structure, counts, and relationships are fixed and reproducible on every
// run (ids are still real loombre_uuidv7() values minted per-run via
// RETURNING, since ids are opaque and nothing depends on their literal
// bytes) — `db:reset && db:seed` always produces the same shaped dataset.
//
// RESTRICTED ZONE (AUD-A4v5-002, audit fafa47f): the restricted rows below
// are DB-level access-control fixtures for the leak suite — they seed gates
// 2-4 (admin opt-in + PIN, content_class isolation, library grant) but NOT
// gate 1, the `restricted.enabled` server setting (default false; the
// settings registry). With gate 1 off, the restricted UI, its PIN gate, and
// /restricted/* are unreachable no matter what this script seeds. To build
// an environment that can exercise the restricted zone end-to-end, opt in
// at seed time:
//
//   LOOMBRE_RESTRICTED_ENABLED=1 pnpm db:seed
//
// which additionally writes the `restricted.enabled: true` server_settings
// row (same env-var name the server itself honors — settings-registry.ts;
// note env always outranks the DB row at runtime, so exporting it to the
// server process works too). Deliberately NOT the default: enabling
// adult-content handling silently in every dev seed would be wrong.
//
// Password/PIN hashes below are PRECOMPUTED argon2id hashes, generated
// offline with @node-rs/argon2 (napi-rs prebuilt binary, no node-gyp). This
// script has no argon2 dependency of its own — see the constants below.
//
//   argon2id('loombre-seed-admin')  -> ADMIN_PASSWORD_HASH
//   argon2id('loombre-seed-casual') -> CASUAL_PASSWORD_HASH
//   argon2id('0000')               -> RESTRICTED_PIN_HASH  (admin's PIN)
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import pg from 'pg';
import {
  ensureSeedAudioFixtures,
  SEED_AUDIO_BITRATE_BPS,
  SEED_AUDIO_CHANNELS,
  SEED_AUDIO_CODEC,
  SEED_AUDIO_CONTAINER,
  SEED_AUDIO_SAMPLE_RATE,
} from './audio-fixtures.mjs';

pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

// Precomputed offline — see header comment. Not derived at runtime.
const ADMIN_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$MXoNHb/vkFj5067uEoOI6g$y17ezgyFacz9WCrXHLtnuDnOkSresjh7Wp7uavb+fAQ';
const CASUAL_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$vp5NMNsmpQki6ty4F1c80Q$5V4x9NgklMZz0t4GZuilQHDTXJZn5xh5RWvi2g37g1g';
const RESTRICTED_PIN_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Be3OO5WPRVdFZ6C2FNFC0A$gg5RJ7iQoyewaORwGbgnr/mVm5So67Sp20PS71ltAFI';

const NOW = Date.now();
// Deterministic ADULT birth date (comfortably >18y before NOW) for admin;
// casual user gets no birth_date at all (age-ineligible: gate 2 fails).
const ADMIN_BIRTH_DATE = '1988-03-14';

let tOffset = 0;
/** Monotonically increasing ms timestamp, oldest-first as calls are made,
 *  so "added_at_ms DESC" ordering in listItems/continue-watching is
 *  well-defined and stable across a single seed run. */
function nextMs() {
  tOffset += 1000;
  return NOW - 10_000_000 + tOffset;
}

async function insertOne(client, text, params) {
  const { rows } = await client.query(text, params);
  return rows[0];
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ------------------------------------------------------------------
    // users
    // ------------------------------------------------------------------
    const admin = await insertOne(
      client,
      `INSERT INTO users (username, email, password_hash, birth_date, max_content_rating, is_admin, created_at_ms, updated_at_ms)
       VALUES ('admin', 'admin@loombre.local', $1, $2, NULL, TRUE, $3, $3)
       RETURNING id`,
      [ADMIN_PASSWORD_HASH, ADMIN_BIRTH_DATE, nextMs()]
    );
    const casual = await insertOne(
      client,
      `INSERT INTO users (username, email, password_hash, birth_date, max_content_rating, is_admin, created_at_ms, updated_at_ms)
       VALUES ('casual', 'casual@loombre.local', $1, NULL, NULL, FALSE, $2, $2)
       RETURNING id`,
      [CASUAL_PASSWORD_HASH, nextMs()]
    );

    // user_settings — admin opts in to restricted content + sets a PIN;
    // casual does neither (gates 3 fails for casual by construction).
    await client.query(
      `INSERT INTO user_settings (user_id, restricted_opt_in, restricted_pin_hash, restricted_unlocked_until_ms, prefs, updated_at_ms)
       VALUES ($1, TRUE, $2, NULL, '{"theme":"dark"}'::jsonb, $3)`,
      [admin.id, RESTRICTED_PIN_HASH, nextMs()]
    );
    await client.query(
      `INSERT INTO user_settings (user_id, restricted_opt_in, restricted_pin_hash, restricted_unlocked_until_ms, prefs, updated_at_ms)
       VALUES ($1, FALSE, NULL, NULL, '{"theme":"light"}'::jsonb, $2)`,
      [casual.id, nextMs()]
    );

    // devices — one each
    await client.query(
      `INSERT INTO devices (user_id, name, platform, refresh_token_hash, profile, last_seen_ms, created_at_ms)
       VALUES ($1, 'Admin Workstation', 'web', 'seed-refresh-token-hash-admin', $2::jsonb, $3, $3)`,
      [admin.id, JSON.stringify({ codecs: ['h264', 'hevc', 'av1'], hdr: ['hdr10'] }), nextMs()]
    );
    await client.query(
      `INSERT INTO devices (user_id, name, platform, refresh_token_hash, profile, last_seen_ms, created_at_ms)
       VALUES ($1, 'Casual Living Room TV', 'tvos', 'seed-refresh-token-hash-casual', $2::jsonb, $3, $3)`,
      [casual.id, JSON.stringify({ codecs: ['h264'], hdr: [] }), nextMs()]
    );

    // ------------------------------------------------------------------
    // libraries
    // ------------------------------------------------------------------
    const libMovies = await insertOne(
      client,
      `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms)
       VALUES ('Movies', 'movie', ARRAY['/data/movies'], 'general', $1, $1) RETURNING id`,
      [nextMs()]
    );
    const libTv = await insertOne(
      client,
      `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms)
       VALUES ('TV', 'tv', ARRAY['/data/tv'], 'general', $1, $1) RETURNING id`,
      [nextMs()]
    );
    const libMusic = await insertOne(
      client,
      `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms)
       VALUES ('Music', 'music', ARRAY['/data/music'], 'general', $1, $1) RETURNING id`,
      [nextMs()]
    );
    const libRestricted = await insertOne(
      client,
      `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms)
       VALUES ('Restricted', 'movie', ARRAY['/data/restricted'], 'restricted', $1, $1) RETURNING id`,
      [nextMs()]
    );

    // ------------------------------------------------------------------
    // library_permissions — default-deny; explicit grants only
    // ------------------------------------------------------------------
    for (const lib of [libMovies, libTv, libMusic]) {
      await client.query(
        `INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`,
        [admin.id, lib.id, nextMs()]
      );
      await client.query(
        `INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`,
        [casual.id, lib.id, nextMs()]
      );
    }
    // Restricted library: admin only (gate 4). Casual gets no grant at all.
    await client.query(
      `INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`,
      [admin.id, libRestricted.id, nextMs()]
    );

    // ------------------------------------------------------------------
    // restricted gate 1 — server_settings opt-in (see header: AUD-A4v5-002)
    // ------------------------------------------------------------------
    // Same truthy vocabulary as the settings registry's parseEnvBoolean
    // (packages/shared/src/settings-registry.ts ENV_TRUE_VALUES).
    const restrictedEnabled = ['1', 'true', 'yes', 'on'].includes(
      (process.env.LOOMBRE_RESTRICTED_ENABLED ?? '').trim().toLowerCase()
    );
    if (restrictedEnabled) {
      await client.query(
        `INSERT INTO server_settings (key, value, updated_at_ms, updated_by)
         VALUES ('restricted.enabled', 'true'::jsonb, $1, $2)`,
        [nextMs(), admin.id]
      );
      console.log('seed: LOOMBRE_RESTRICTED_ENABLED set — wrote restricted.enabled=true (gate 1 OPEN).');
    } else {
      console.log(
        'seed: restricted fixtures are DB-level only (gates 2-4); gate 1 (restricted.enabled) stays OFF. ' +
          'Re-seed with LOOMBRE_RESTRICTED_ENABLED=1 to exercise the restricted zone in the UI.'
      );
    }

    // ------------------------------------------------------------------
    // people & tags (general + restricted, isolated by content_class)
    // ------------------------------------------------------------------
    const generalActors = [];
    for (const name of ['Elena Marsh', 'Devon Kade', 'Priya Anand', 'Tomas Lindqvist']) {
      generalActors.push(
        await insertOne(client, `INSERT INTO people (name, content_class) VALUES ($1, 'general') RETURNING id`, [name])
      );
    }
    const restrictedPeople = [];
    for (const name of ['Restricted Performer One', 'Restricted Performer Two', 'Restricted Performer Three']) {
      restrictedPeople.push(
        await insertOne(client, `INSERT INTO people (name, content_class) VALUES ($1, 'restricted') RETURNING id`, [name])
      );
    }

    // Leak-suite hardening fixtures (packages/db/test/leak.spec.ts,
    // guarded-query-layer wave). Neither the person nor the tags/items
    // tables carry a trigger deriving content_class from credited items —
    // it is a per-row classification the writer chooses — so these two
    // scenarios are legitimately reachable data, not hypotheticals:
    //
    //   1. A RESTRICTED-class person credited on a GENERAL item. A search
    //      match on this person's name must not surface that (otherwise
    //      visible) item to an uncleared viewer — the person's own
    //      isolation must win even though the item itself would pass the
    //      item guard on its own.
    //   2. A GENERAL-class person credited ONLY on a RESTRICTED item (no
    //      general-item credit at all). listPeople/getPersonById must NOT
    //      surface this person to an uncleared viewer — content_class
    //      alone is not sufficient; the "credited on >=1 item visible to
    //      ctx" clause has to independently hold, or the person's mere
    //      existence/name is itself a restricted-content leak.
    const restrictedCameoPerformer = await insertOne(
      client,
      `INSERT INTO people (name, content_class) VALUES ($1, 'restricted') RETURNING id`,
      ['Restricted Cameo Performer']
    );
    const marginalGeneralActor = await insertOne(
      client,
      `INSERT INTO people (name, content_class) VALUES ($1, 'general') RETURNING id`,
      ['Marginal General Actor']
    );

    const generalTags = {};
    for (const [name, kind] of [
      ['Action', 'genre'],
      ['Drama', 'genre'],
      ['Comedy', 'genre'],
      ['Sci-Fi', 'genre'],
      ['Featured', 'tag'],
    ]) {
      generalTags[name] = await insertOne(
        client,
        `INSERT INTO tags (name, content_class) VALUES ($1, 'general') RETURNING id`,
        [name]
      );
      generalTags[name].kind = kind;
    }
    const restrictedTags = {};
    for (const [name, kind] of [
      ['Restricted Genre A', 'genre'],
      ['Restricted Genre B', 'genre'],
    ]) {
      // `kind` here is set on BOTH the tag row itself (migrations/0019's
      // entity-level tags.kind, K2/S6) AND the JS-local tagRow.kind the
      // tagItem() helper below writes into the item_tags EDGE — a genre
      // tag is genre at both levels in this seed's data, matching how a
      // real Stash-mapped genre tag would land (S6's mapper sets both).
      restrictedTags[name] = await insertOne(
        client,
        `INSERT INTO tags (name, content_class, kind) VALUES ($1, 'restricted', $2) RETURNING id`,
        [name, kind]
      );
      restrictedTags[name].kind = kind;
    }

    // Restricted Content surface (STATE.md Stash run, S9/K2/S6) fixtures:
    // studios are first-class VIA tags.kind='studio' (entity level) +
    // item_tags.kind='studio' (edge level) — Lane D's zone studios
    // surface (packages/db/src/query/restricted-studios.ts) and its leak
    // suite need at least two real studio rows attached to restricted
    // movies, which no earlier fixture wave provided (tags.kind did not
    // exist before migration 0019).
    const restrictedStudioTags = {};
    for (const name of ['Nightshade Films', 'Aurora Media']) {
      restrictedStudioTags[name] = await insertOne(
        client,
        `INSERT INTO tags (name, content_class, kind) VALUES ($1, 'restricted', 'studio') RETURNING id`,
        [name]
      );
      restrictedStudioTags[name].kind = 'studio';
    }

    // Leak-suite hardening: a restricted tag sharing a NAME with a general
    // tag (tags.UNIQUE is (name, content_class), so this is two distinct
    // rows by design, not a collision the schema prevents) — proves
    // listTags/search isolate by content_class, not by name string, even
    // when the two rows are textually identical. Also a general-class tag
    // used ONLY on a restricted item, mirroring marginalGeneralActor above
    // (the "credited/used on >=1 visible item" clause, tag side).
    restrictedTags['Drama (restricted)'] = await insertOne(
      client,
      `INSERT INTO tags (name, content_class) VALUES ('Drama', 'restricted') RETURNING id`,
      []
    );
    restrictedTags['Drama (restricted)'].kind = 'genre';
    generalTags['Rare'] = await insertOne(
      client,
      `INSERT INTO tags (name, content_class) VALUES ('Rare', 'general') RETURNING id`,
      []
    );
    generalTags['Rare'].kind = 'tag';
    // A restricted-class TAG applied to a GENERAL item — the tag-side mirror
    // of restrictedCameoPerformer (a restricted person on a general item).
    // Proves the search tag-join is gated on the TAG's own content_class,
    // so searching this tag's name never surfaces the (individually visible)
    // general item to an uncleared viewer. Flagged as an untested branch by
    // the Wave-4 adversarial review (F2).
    restrictedTags['Contraband (restricted)'] = await insertOne(
      client,
      `INSERT INTO tags (name, content_class) VALUES ('Contraband', 'restricted') RETURNING id`,
      []
    );
    restrictedTags['Contraband (restricted)'].kind = 'tag';

    async function tagItem(itemId, tagRow) {
      await client.query(
        `INSERT INTO item_tags (item_id, tag_id, kind) VALUES ($1, $2, $3)`,
        [itemId, tagRow.id, tagRow.kind]
      );
    }
    async function creditItem(itemId, personId, role, credit, ord) {
      await client.query(
        `INSERT INTO item_people (item_id, person_id, role, credit, ord) VALUES ($1, $2, $3, $4, $5)`,
        [itemId, personId, role, credit, ord]
      );
    }

    async function insertCatalogItem({ libraryId, itemType, parentId = null, title, sortTitle, year = null, communityRating = null }) {
      const ms = nextMs();
      return insertOne(
        client,
        `INSERT INTO catalog_items (library_id, item_type, parent_id, title, sort_title, year, community_rating, added_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id, added_at_ms`,
        [libraryId, itemType, parentId, title, sortTitle, year, communityRating, ms]
      );
    }

    // ------------------------------------------------------------------
    // Movies (6, general)
    // ------------------------------------------------------------------
    const movieTitles = [
      ['Harbor Lights', 2019, 7.4],
      ['The Quiet Frontier', 2021, 8.1],
      ['Neon Static', 2018, 6.8],
      ['Paper Kingdoms', 2022, 7.9],
      ['Last Ferry Out', 2016, 7.2],
      ['Glass Orchard', 2023, 8.4],
    ];
    const movies = [];
    for (const [title, year, rating] of movieTitles) {
      const item = await insertCatalogItem({
        libraryId: libMovies.id,
        itemType: 'movie',
        title,
        sortTitle: title,
        year,
        communityRating: rating,
      });
      await client.query(
        `INSERT INTO movie_details (item_id, content_rating, runtime_ms, tagline, overview)
         VALUES ($1, 'PG-13', $2, $3, $4)`,
        [item.id, 108 * 60_000, `A story about ${title.toLowerCase()}.`, `${title} follows an ensemble cast through one unforgettable week.`]
      );
      movies.push({ ...item, title });
    }

    // A few actors/genres on general movies
    await creditItem(movies[0].id, generalActors[0].id, 'actor', 'Lead', 0);
    await creditItem(movies[0].id, generalActors[1].id, 'director', null, 1);
    await tagItem(movies[0].id, generalTags['Drama']);
    await creditItem(movies[1].id, generalActors[2].id, 'actor', 'Lead', 0);
    await tagItem(movies[1].id, generalTags['Action']);
    await tagItem(movies[1].id, generalTags['Featured']);
    await creditItem(movies[2].id, generalActors[3].id, 'actor', 'Supporting', 0);
    await tagItem(movies[2].id, generalTags['Sci-Fi']);

    // media_files + media_streams for a handful of movies
    for (const movie of movies.slice(0, 3)) {
      const file = await insertOne(
        client,
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms)
         VALUES ($1, $2, $3, $4, 'mkv', $5, $6::jsonb, $7)
         RETURNING id`,
        [
          movie.id,
          `/data/movies/${movie.title.replace(/\s+/g, '.')}.mkv`,
          `xxh3-${movie.id}`,
          6_400_000_000,
          108 * 60_000,
          JSON.stringify({ format: 'matroska', probed: true }),
          nextMs(),
        ]
      );
      await client.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, color_transfer, channels, sample_rate, bitrate_bps, frame_rate, language, is_default, is_forced)
         VALUES ($1, 0, 'video', 'hevc', 3840, 2160, 10, 'smpte2084', NULL, NULL, 18000000, 23.976, NULL, TRUE, FALSE)`,
        [file.id]
      );
      await client.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, color_transfer, channels, sample_rate, bitrate_bps, frame_rate, language, is_default, is_forced)
         VALUES ($1, 1, 'audio', 'eac3', NULL, NULL, NULL, NULL, 6, 48000, 640000, NULL, 'eng', TRUE, FALSE)`,
        [file.id]
      );
    }

    // ------------------------------------------------------------------
    // Series -> seasons -> episodes (2 series, 2 seasons, 6 episodes)
    // ------------------------------------------------------------------
    const seriesA = await insertCatalogItem({
      libraryId: libTv.id,
      itemType: 'series',
      title: 'Coastline Signals',
      sortTitle: 'Coastline Signals',
      year: 2020,
      communityRating: 8.0,
    });
    await client.query(
      `INSERT INTO series_details (item_id, content_rating, overview) VALUES ($1, 'TV-14', $2)`,
      [seriesA.id, 'A coastal town keeps secrets its residents cannot outrun.']
    );
    await tagItem(seriesA.id, generalTags['Drama']);
    await creditItem(seriesA.id, generalActors[0].id, 'actor', 'Lead', 0);

    const seriesB = await insertCatalogItem({
      libraryId: libTv.id,
      itemType: 'series',
      title: 'Northbound',
      sortTitle: 'Northbound',
      year: 2022,
      communityRating: 7.5,
    });
    await client.query(
      `INSERT INTO series_details (item_id, content_rating, overview) VALUES ($1, 'TV-MA', $2)`,
      [seriesB.id, 'A convoy of strangers crosses a continent that no longer wants them.']
    );
    await tagItem(seriesB.id, generalTags['Action']);

    const seasonA1 = await insertCatalogItem({
      libraryId: libTv.id,
      itemType: 'season',
      parentId: seriesA.id,
      title: 'Coastline Signals: Season 1',
      sortTitle: 'Coastline Signals: Season 1',
      year: 2020,
    });
    await client.query(`INSERT INTO season_details (item_id, season_number) VALUES ($1, 1)`, [seasonA1.id]);

    const seasonB1 = await insertCatalogItem({
      libraryId: libTv.id,
      itemType: 'season',
      parentId: seriesB.id,
      title: 'Northbound: Season 1',
      sortTitle: 'Northbound: Season 1',
      year: 2022,
    });
    await client.query(`INSERT INTO season_details (item_id, season_number) VALUES ($1, 1)`, [seasonB1.id]);

    const episodeSpecs = [
      [seasonA1, 1, 'Static on the Line'],
      [seasonA1, 2, 'Low Tide'],
      [seasonA1, 3, 'What the Radio Knew'],
      [seasonB1, 1, 'Mile Zero'],
      [seasonB1, 2, 'Convoy'],
      [seasonB1, 3, 'The Last Checkpoint'],
    ];
    const episodes = [];
    for (const [season, num, title] of episodeSpecs) {
      const ep = await insertCatalogItem({
        libraryId: libTv.id,
        itemType: 'episode',
        parentId: season.id,
        title,
        sortTitle: title,
      });
      await client.query(
        `INSERT INTO episode_details (item_id, episode_number, aired_at_ms, overview) VALUES ($1, $2, $3, $4)`,
        [ep.id, num, nextMs(), `Episode ${num}: ${title}.`]
      );
      episodes.push(ep);
    }

    // media_files for a couple of episodes
    for (const ep of episodes.slice(0, 2)) {
      const file = await insertOne(
        client,
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms)
         VALUES ($1, $2, $3, $4, 'mkv', $5, $6::jsonb, $7)
         RETURNING id`,
        [
          ep.id,
          `/data/tv/${ep.id}.mkv`,
          `xxh3-${ep.id}`,
          1_200_000_000,
          42 * 60_000,
          JSON.stringify({ format: 'matroska', probed: true }),
          nextMs(),
        ]
      );
      await client.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, color_transfer, channels, sample_rate, bitrate_bps, frame_rate, language, is_default, is_forced)
         VALUES ($1, 0, 'video', 'h264', 1920, 1080, 8, NULL, NULL, NULL, 8000000, 23.976, NULL, TRUE, FALSE)`,
        [file.id]
      );
    }

    // ------------------------------------------------------------------
    // Artist -> albums -> tracks (1 artist, 2 albums, 6 tracks)
    // ------------------------------------------------------------------
    const artist = await insertCatalogItem({
      libraryId: libMusic.id,
      itemType: 'artist',
      title: 'The Salt Layer',
      sortTitle: 'Salt Layer, The',
    });
    await client.query(`INSERT INTO artist_details (item_id, overview) VALUES ($1, $2)`, [
      artist.id,
      'A four-piece outfit blending shoegaze and coastal folk.',
    ]);

    const albumSpecs = [
      ['Low Water', 2019],
      ['Departures', 2022],
    ];
    const albums = [];
    for (const [title, year] of albumSpecs) {
      const album = await insertCatalogItem({
        libraryId: libMusic.id,
        itemType: 'album',
        parentId: artist.id,
        title,
        sortTitle: title,
        year,
      });
      await client.query(`INSERT INTO album_details (item_id, year) VALUES ($1, $2)`, [album.id, year]);
      albums.push(album);
    }

    // [album, trackNumber, discNumber, title, fixtureSlug, frequencyHz]
    //
    // d3-m1: every track gets a REAL media_files row backed by a REAL (tiny)
    // audio file, because rows alone are not enough — the music player's
    // POST /playback/sessions needs the row (getMediaInfoAssembly returns
    // undefined without one, which apps/server surfaces as 404) AND its file
    // GET stat()s media_files.path. Before this, no seeded track could ever
    // play: the mini player mounted and was skipped away within ~40 ms.
    //
    // Durations are the FILES' real durations (5-10 s, one per track so the
    // six are distinguishable), and track_details.duration_ms is written
    // from the same number — a catalog duration that disagrees with the
    // media is its own confusing bug. Distinct frequencies make the tracks
    // audibly distinct while listening to a handoff.
    const trackSpecs = [
      [albums[0], 1, 1, 'Tideline', 'seed-01-tideline', 220],
      [albums[0], 2, 1, 'Salt & Static', 'seed-02-salt-and-static', 247],
      [albums[0], 3, 1, 'Low Water', 'seed-03-low-water', 262],
      [albums[1], 1, 1, 'Departures', 'seed-04-departures', 294],
      [albums[1], 2, 1, 'Coastal Drift', 'seed-05-coastal-drift', 330],
      [albums[1], 3, 1, 'Harbor Hymn', 'seed-06-harbor-hymn', 349],
    ];
    // Idempotent + ffmpeg-optional: an existing non-empty fixture is reused,
    // and a box without ffmpeg still gets the DB rows (with a loud console
    // note), so the seeded catalog has ONE deterministic shape everywhere.
    const audio = ensureSeedAudioFixtures(
      trackSpecs.map(([, , , , slug, frequencyHz], i) => ({
        slug,
        frequencyHz,
        durationMs: (5 + i) * 1000,
      }))
    );
    for (const [i, [album, trackNum, discNum, title, slug]] of trackSpecs.entries()) {
      const fixture = audio.files[i];
      const track = await insertCatalogItem({
        libraryId: libMusic.id,
        itemType: 'track',
        parentId: album.id,
        title,
        sortTitle: title,
      });
      await client.query(
        `INSERT INTO track_details (item_id, track_number, disc_number, duration_ms) VALUES ($1, $2, $3, $4)`,
        [track.id, trackNum, discNum, fixture.durationMs]
      );
      const trackFile = await insertOne(
        client,
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id`,
        [
          track.id,
          fixture.path,
          `xxh3-${slug}`,
          fixture.sizeBytes,
          SEED_AUDIO_CONTAINER,
          fixture.durationMs,
          JSON.stringify({ format: SEED_AUDIO_CONTAINER, probed: true }),
          nextMs(),
        ]
      );
      await client.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, color_transfer, channels, sample_rate, bitrate_bps, frame_rate, language, is_default, is_forced)
         VALUES ($1, 0, 'audio', $2, NULL, NULL, NULL, NULL, $3, $4, $5, NULL, NULL, TRUE, FALSE)`,
        [trackFile.id, SEED_AUDIO_CODEC, SEED_AUDIO_CHANNELS, SEED_AUDIO_SAMPLE_RATE, SEED_AUDIO_BITRATE_BPS]
      );
    }
    await creditItem(artist.id, generalActors[1].id, 'album_artist', null, 0);

    // ------------------------------------------------------------------
    // Restricted movies (4)
    // ------------------------------------------------------------------
    // [title, year, communityRating, premiereAtMs] — Restricted Content
    // surface fixtures (STATE.md Stash run S9): varied year/rating/date so
    // Lane D's zone browse filter+sort tests (yearMin/Max, ratingMin/Max,
    // 'date' sort with a real K1 movie_details.premiere_at_ms AND the
    // NULL-sentinel case) have real, non-identical data to distinguish —
    // the earlier fixed (2021, 6.9, no date) wave only ever exercised
    // visibility, never filtering/sorting. premiereAtMs is `null` for two
    // of the four (index 2/3) on purpose: the 'date' sort's NULL-pushed-
    // last sentinel needs a real case to prove against.
    const restrictedTitles = [
      ['After Hours Redline', 2019, 6.9, Date.UTC(2019, 5, 14)],
      ['Velvet Static', 2022, 8.2, Date.UTC(2022, 10, 2)],
      ['Midnight Ledger', 2021, 5.1, null],
      ['Undertow Confidential', 2020, null, null],
    ];
    const restrictedMovies = [];
    for (const [title, year, communityRating, premiereAtMs] of restrictedTitles) {
      const item = await insertCatalogItem({
        libraryId: libRestricted.id,
        itemType: 'movie',
        title,
        sortTitle: title,
        year,
        communityRating,
      });
      await client.query(
        `INSERT INTO movie_details (item_id, content_rating, runtime_ms, tagline, overview, premiere_at_ms) VALUES ($1, 'NC-17', $2, $3, $4, $5)`,
        [item.id, 95 * 60_000, 'Not for general audiences.', `${title} — restricted-library placeholder content for Phase 0 seed data.`, premiereAtMs]
      );
      restrictedMovies.push(item);
    }
    // Restricted metadata isolation: restricted people/tags, never on general items.
    for (const [i, movie] of restrictedMovies.entries()) {
      await creditItem(movie.id, restrictedPeople[i % restrictedPeople.length].id, 'performer', 'Featured', 0);
      await tagItem(movie.id, i % 2 === 0 ? restrictedTags['Restricted Genre A'] : restrictedTags['Restricted Genre B']);
    }
    // Studio attribution (K2/S6) — two of the four scenes get a studio
    // edge, one each, so Lane D's zone studios surface + browse
    // studioTagIds filter have real, distinct fixture data; the other two
    // stay studio-less (an item with no studio chip is a legitimate,
    // tested state — Undertow Confidential/Midnight Ledger).
    await tagItem(restrictedMovies[0].id, restrictedStudioTags['Nightshade Films']);
    await tagItem(restrictedMovies[1].id, restrictedStudioTags['Aurora Media']);
    // media_files for three of the four restricted movies, with distinct
    // probed durations AND (below) distinct primary-video heights — S9's
    // browse duration/resolution filters and 'duration' sort need real,
    // non-identical values to distinguish; Undertow Confidential (index 3)
    // deliberately keeps NO media_files at all (the "unprobed, no
    // evidence" case listRestrictedBrowse's resolution/duration fields
    // must report as `null`, never a fabricated value).
    const restrictedFileDurationsMs = [95 * 60_000, 110 * 60_000, 80 * 60_000];
    const restrictedFiles = [];
    for (const [i, movie] of restrictedMovies.slice(0, 3).entries()) {
      const file = await insertOne(
        client,
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms)
         VALUES ($1, $2, $3, $4, 'mkv', $5, $6::jsonb, $7)
         RETURNING id`,
        [
          movie.id,
          `/data/restricted/${movie.id}.mkv`,
          `xxh3-${movie.id}`,
          4_800_000_000,
          restrictedFileDurationsMs[i],
          JSON.stringify({ format: 'matroska', probed: true }),
          nextMs(),
        ]
      );
      restrictedFiles.push(file);
    }
    // Primary video stream per file — one FHD, one UHD, one HD, so all
    // three non-empty RestrictedResolutionBand values have a real fixture
    // (SD has no fixture today; the band function itself is exercised by
    // packages/db/test/restricted-browse.spec.ts's unit cases instead).
    const restrictedFileResolutions = [
      { width: 1920, height: 1080, hdr: 'none' }, // After Hours Redline -> FHD
      { width: 3840, height: 2160, hdr: 'hdr10' }, // Velvet Static -> UHD
      { width: 1280, height: 720, hdr: 'none' }, // Midnight Ledger -> HD
    ];
    for (const [i, file] of restrictedFiles.entries()) {
      const { width, height, hdr } = restrictedFileResolutions[i];
      await client.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, color_transfer, channels, sample_rate, bitrate_bps, frame_rate, language, is_default, is_forced, hdr)
         VALUES ($1, 0, 'video', 'hevc', $2, $3, 8, NULL, NULL, NULL, 9000000, 23.976, NULL, TRUE, FALSE, $4)`,
        [file.id, width, height, hdr]
      );
    }
    // Chapter markers (K9/S7) — After Hours Redline (index 0) gets three,
    // proving the scene-detail chapters list AND its ORDER BY start_ms
    // against real, non-trivial data (the other three scenes stay
    // marker-less, the common case).
    for (const [title, startMs] of [
      ['Opening', 0],
      ['Midpoint', 32 * 60_000],
      ['Finale', 71 * 60_000],
    ]) {
      await client.query(
        `INSERT INTO chapter_markers (item_id, title, start_ms, source) VALUES ($1, $2, $3, 'stash')`,
        [restrictedMovies[0].id, title, startMs]
      );
    }
    // GET /items/{id}/chapters leak-suite contrast fixture (Lane E, S7):
    // one chapter marker on a fully GENERAL item (Harbor Lights, movies[0])
    // — chapter_markers has no content_class of its own (visibility rides
    // the owning item, packages/db/src/query/chapters.ts header), so the
    // leak proof needs a general-item marker a casual uncleared viewer
    // MUST see, alongside After Hours Redline's restricted markers the
    // SAME viewer must NOT see.
    await client.query(
      `INSERT INTO chapter_markers (item_id, title, start_ms, source) VALUES ($1, $2, $3, 'stash')`,
      [movies[0].id, 'Cold Open', 0]
    );

    // ------------------------------------------------------------------
    // Leak-suite hardening fixtures (see the person/tag creation comments
    // above for the scenarios these exercise).
    // ------------------------------------------------------------------

    // (1) restricted person credited on a GENERAL item — movies[4] "Last
    // Ferry Out" stays a fully general, otherwise-ordinary item; only its
    // credit list carries the restricted-class person.
    await creditItem(movies[4].id, restrictedCameoPerformer.id, 'guest', 'Cameo', 1);

    // (2) general person credited ONLY on a RESTRICTED item — no credit on
    // any general item anywhere in this seed.
    await creditItem(restrictedMovies[1].id, marginalGeneralActor.id, 'guest', 'Cameo', 1);

    // (3) name-collision tag: restrictedMovies[0] already carries
    // 'Restricted Genre A'; add the same-named-as-general 'Drama'
    // (restricted-class) tag alongside it.
    await tagItem(restrictedMovies[0].id, restrictedTags['Drama (restricted)']);

    // (4) general-class tag used ONLY on a restricted item (orphan check,
    // tag side).
    await tagItem(restrictedMovies[2].id, generalTags['Rare']);

    // (4b) restricted-class tag applied to a GENERAL item — mirror of (1)
    // on the tag side (Wave-4 review F2). movies[4] stays general; only its
    // tag list carries the restricted-class 'Contraband' tag.
    await tagItem(movies[4].id, restrictedTags['Contraband (restricted)']);

    // (5) missing-file visibility (docs/PLAN.md §8.2, P1.2): movies[3]
    // "Paper Kingdoms" has no media_files row from the block above (only
    // movies[0..2] got one) — give it exactly one, with missing_since_ms
    // set, so it has files AND all of them are missing. Per
    // packages/db/src/query/guard.ts this hides the item from EVERY
    // guarded read regardless of clearance; used to prove the rule holds
    // for every new query surface, not just the two Phase 0 shipped with.
    await client.query(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probe, probed_at_ms, missing_since_ms)
       VALUES ($1, $2, $3, $4, 'mkv', $5, $6::jsonb, $7, $8)`,
      [
        movies[3].id,
        `/data/movies/${movies[3].title.replace(/\s+/g, '.')}.mkv`,
        `xxh3-${movies[3].id}`,
        5_600_000_000,
        101 * 60_000,
        JSON.stringify({ format: 'matroska', probed: true }),
        nextMs(),
        nextMs(),
      ]
    );

    // ------------------------------------------------------------------
    // progress — continue-watching for both users (general), admin also
    // has progress on one restricted item.
    // ------------------------------------------------------------------
    await client.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, play_count, updated_at_ms)
       VALUES ($1, $2, $3, 'in-progress', 1, $4)`,
      [admin.id, movies[0].id, 42 * 60_000, nextMs()]
    );
    await client.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, play_count, updated_at_ms)
       VALUES ($1, $2, 0, 'played', 1, $3)`,
      [admin.id, episodes[0].id, nextMs()]
    );
    await client.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, play_count, updated_at_ms)
       VALUES ($1, $2, $3, 'in-progress', 1, $4)`,
      [casual.id, movies[1].id, 17 * 60_000, nextMs()]
    );
    await client.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, play_count, updated_at_ms)
       VALUES ($1, $2, 0, 'played', 2, $3)`,
      [casual.id, episodes[3].id, nextMs()]
    );
    // Admin's restricted-item progress — only reachable through the guard
    // when restrictedCleared is true; exercised by leak.spec.ts.
    await client.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, play_count, updated_at_ms)
       VALUES ($1, $2, $3, 'in-progress', 1, $4)`,
      [admin.id, restrictedMovies[0].id, 30 * 60_000, nextMs()]
    );

    // ------------------------------------------------------------------
    // A couple of images + one job + one event, for completeness
    //
    // AUD-W6-002 (audit fafa47f): every `file_path` below (and in
    // insertImage's callers further down) is a ROW-ONLY fixture — no
    // backing blob is ever written to disk at that path. That is
    // deliberate here: these rows exist to exercise getImageEntityAccess
    // (packages/db/src/query/images.ts) and the leak suite's
    // visible-vs-gated branches per entity_type, which only needs a real
    // DB row + a real `blurhash` (present on every row below, so the
    // client-side blurhash fallback still renders something) — not a real
    // decodable file. A consequence, confirmed organic by a visual sweep
    // of a seeded env: GET /images/** 404s/ORB-blocks for every one of
    // these paths, so any screenshot/visual pass against a plain `pnpm
    // db:seed` environment exercises ONLY the blurhash-fallback rendering
    // path, never real poster/art decoding — that is expected, not a bug
    // in the seed OR in image serving. A visual check that specifically
    // needs real decodable art has to seed its own blob files (matching
    // apps/worker/src/image/pipeline.ts's `<LOOMBRE_DATA_DIR ?? ./data>/
    // images/<entityType>/<entityId>/<kind>-<width>.<ext>` layout) and
    // point file_path at them separately — still out of scope here.
    // (Contrast the MUSIC tracks above, which DO get real blobs via
    // seed/audio-fixtures.mjs: nothing renders a missing poster as a hard
    // failure, but a track with no file on disk cannot play at all — see
    // d3-m1 and that module's header.)
    // ------------------------------------------------------------------
    await client.query(
      `INSERT INTO images (entity_type, entity_id, kind, source, width, height, blurhash, file_path, created_at_ms)
       VALUES ('catalog_item', $1, 'poster', 'local', 1000, 1500, 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', $2, $3)`,
      [movies[0].id, `/data/images/${movies[0].id}-poster.jpg`, nextMs()]
    );

    // getImageEntityAccess fixtures (packages/db/src/query/images.ts):
    // one row per entity_type covering both the "owning entity is
    // visible" and "owning entity is restricted/hidden" branches. images
    // is a polymorphic table (0001_init.sql comment: "catalog items today;
    // people/tags potentially later") — entity_type values here are
    // 'catalog_item' | 'person' | 'tag' | 'library', matching what the
    // internal writer already uses for items (above) and what the query
    // layer's entityType param accepts.
    async function insertImage(entityType, entityId, kind, blurhash, pathSuffix) {
      await client.query(
        `INSERT INTO images (entity_type, entity_id, kind, source, width, height, blurhash, file_path, created_at_ms)
         VALUES ($1, $2, $3, 'local', 400, 600, $4, $5, $6)`,
        [entityType, entityId, kind, blurhash, `/data/images/${pathSuffix}`, nextMs()]
      );
    }
    // item branch: one general (visible), one restricted (gated)
    await insertImage('catalog_item', movies[1].id, 'poster', 'L4PZfSi_.AyE_3t7t7R**0o#DgR5', `${movies[1].id}-poster.jpg`);
    await insertImage('catalog_item', restrictedMovies[0].id, 'poster', 'L4PZfSi_.AyE_3t7t7R**0o#DgR6', `${restrictedMovies[0].id}-poster.jpg`);
    // person branch: one general (visible + has a visible credit), one
    // restricted (gated by content_class alone)
    await insertImage('person', generalActors[0].id, 'thumb', 'L2PZfSi_.AyE_3t7t7R**0o#DgR7', `person-${generalActors[0].id}.jpg`);
    await insertImage('person', restrictedPeople[0].id, 'thumb', 'L2PZfSi_.AyE_3t7t7R**0o#DgR8', `person-${restrictedPeople[0].id}.jpg`);
    // tag branch: one general, one restricted
    await insertImage('tag', generalTags['Drama'].id, 'thumb', 'L1PZfSi_.AyE_3t7t7R**0o#DgR9', `tag-${generalTags['Drama'].id}.jpg`);
    await insertImage('tag', restrictedTags['Restricted Genre A'].id, 'thumb', 'L1PZfSi_.AyE_3t7t7R**0o#DgRa', `tag-${restrictedTags['Restricted Genre A'].id}.jpg`);
    // library branch: one general, one restricted
    await insertImage('library', libMovies.id, 'backdrop', 'L0PZfSi_.AyE_3t7t7R**0o#DgRb', `library-${libMovies.id}.jpg`);
    await insertImage('library', libRestricted.id, 'backdrop', 'L0PZfSi_.AyE_3t7t7R**0o#DgRc', `library-${libRestricted.id}.jpg`);
    await client.query(
      `INSERT INTO jobs (type, status, priority, attempts, subject_item_id, created_at_ms, updated_at_ms, started_at_ms, finished_at_ms)
       VALUES ('scan.library', 'completed', 0, 1, NULL, $1, $1, $1, $1)`,
      [nextMs()]
    );
    // readEventsForViewer fixtures (packages/db/src/query/events.ts) — one
    // event per payload shape / visibility branch the function handles,
    // schema-valid per packages/contract/event-schemas/*.schema.json (the
    // Phase 0 placeholder event here was NOT schema-valid — missing
    // libraryId/contentClass/addedAtMs — so it silently matched neither the
    // guarded nor pass-through branch; replaced rather than left stale).
    async function insertEvent(type, actorUserId, payload) {
      await client.query(
        `INSERT INTO events (type, ts_ms, actor_user_id, payload, processed_at_ms)
         VALUES ($1, $2, $3, $4::jsonb, $2)`,
        [type, nextMs(), actorUserId, JSON.stringify(payload)]
      );
    }
    // denormalized-payload branch, general (visible to everyone with the library)
    await insertEvent('item.added', admin.id, {
      itemId: movies[0].id,
      libraryId: libMovies.id,
      itemType: 'movie',
      contentClass: 'general',
      parentId: null,
      addedAtMs: nextMs(),
    });
    // denormalized-payload branch, restricted (gate 5 required)
    await insertEvent('item.added', admin.id, {
      itemId: restrictedMovies[0].id,
      libraryId: libRestricted.id,
      itemType: 'movie',
      contentClass: 'restricted',
      parentId: null,
      addedAtMs: nextMs(),
    });
    // library.created, restricted — gate 4 (membership) alone must not be
    // enough; requires gate 5 too, same as the item.added case above.
    await insertEvent('library.created', admin.id, {
      libraryId: libRestricted.id,
      name: 'Restricted',
      mediaKind: 'movie',
      contentClass: 'restricted',
      createdAtMs: nextMs(),
    });
    // library-join branch (payload carries libraryId only, no contentClass)
    await insertEvent('scan.completed', admin.id, {
      jobId: '00000000-0000-7000-8000-000000000000',
      libraryId: libRestricted.id,
      full: true,
      itemsAdded: 4,
      itemsUpdated: 0,
      itemsRemoved: 0,
      durationMs: 1200,
      status: 'succeeded',
      errorMessage: null,
      completedAtMs: nextMs(),
    });
    // item-join branch (payload carries itemId only) — restricted item
    await insertEvent('file.relocated', null, {
      itemId: restrictedMovies[1].id,
      mediaFileId: '00000000-0000-7000-8000-000000000001',
      previousPath: '/data/restricted/old-path.mkv',
      newPath: `/data/restricted/${restrictedMovies[1].id}.mkv`,
      contentHash: `xxh3-${restrictedMovies[1].id}`,
      relocatedAtMs: nextMs(),
    });
    // pass-through branch — no item/library association at all
    await insertEvent('user.created', null, {
      userId: casual.id,
      username: 'casual',
      isAdmin: false,
      createdAtMs: nextMs(),
    });

    await client.query('COMMIT');
    console.log('seed: committed successfully.');

    // ------------------------------------------------------------------
    // Report row counts
    // ------------------------------------------------------------------
    const tables = [
      'users', 'user_settings', 'devices', 'libraries', 'library_permissions',
      'catalog_items', 'movie_details', 'series_details', 'season_details',
      'episode_details', 'artist_details', 'album_details', 'track_details',
      'provider_ids', 'people', 'item_people', 'tags', 'item_tags',
      'item_attributes', 'media_files', 'media_streams', 'progress',
      'playback_sessions', 'events', 'jobs', 'images',
    ];
    for (const t of tables) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      console.log(`  ${t.padEnd(20)} ${rows[0].n}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('seed: failed, rolled back.', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
