-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0017_watchlists
--
-- Phosphor retheme + responsive rebuild, Wave 2 lane L3 (Watchlist + Person
-- routes) — design/phosphor/README.md's Watchlist screen + "Your Watchlist"
-- Home rail + detail-screen toggle, and the README's State management
-- section ("Shared client state: watchlist (id -> bool) ... must sync
-- across devices via the events socket").
--
-- Real columns only (CLAUDE.md invariant 3 — no JSONB): user_id FK, item_id
-- FK, added_at_ms. Mirrors migrations/0001_init.sql's `progress` table
-- EXACTLY (composite PRIMARY KEY (user_id, item_id) IS the "UNIQUE pair"
-- requirement — a user can only have one watchlist row per item, adding an
-- already-present item is an idempotent no-op via ON CONFLICT DO NOTHING,
-- see packages/db/src/query/watchlist.ts) — no separate surrogate id, no
-- separate UNIQUE constraint needed on top of the PK.
--
-- Guard posture (docs/PLAN.md §6.4): this table carries NO content_class of
-- its own (same as `progress`) — its only leak surface is "is the
-- referenced catalog_items row visible to ctx", enforced by
-- applyGuardToJoined(ctx, 'watchlists.item_id') on every read, exactly like
-- progress.ts's getContinueWatching/listProgress. Writes (addToWatchlistAndEmit)
-- additionally gate on getItemById(ctx, itemId) first — see that function's
-- header for why this makes ADD of a zone title UNREACHABLE for an
-- uncleared viewer (the item is indistinguishable from nonexistent, same as
-- upsertProgress's precedent) — enforced server-side in the query layer,
-- not merely by the client hiding the toggle button.
CREATE TABLE watchlists (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  added_at_ms   BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

COMMENT ON TABLE watchlists IS
  'One row per (user, item) the user has saved to their watchlist '
  '(design/phosphor README.md Watchlist screen + Home "Your Watchlist" '
  'rail + detail-screen toggle). UPSERT-only writes (ON CONFLICT DO '
  'NOTHING on add) make this concurrent-write-safe by construction, same '
  'as progress''s header note. No content_class of its own — visibility is '
  'entirely a function of the referenced catalog_items row (see '
  'packages/db/src/query/watchlist.ts).';

COMMENT ON COLUMN watchlists.added_at_ms IS
  'Epoch ms the item was added — the ONLY ordering key for the watchlist '
  'list (newest-first), keyset-paginated on (added_at_ms, item_id) both '
  'DESC, mirroring progress.ts''s listProgress cursor shape exactly.';

CREATE INDEX watchlists_user_added_idx
  ON watchlists (user_id, added_at_ms DESC, item_id DESC);
