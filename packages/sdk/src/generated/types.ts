// GENERATED — do not edit (pnpm --filter @loombre/contract codegen)

export interface paths {
    "/setup/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether this instance still needs first-boot setup
         * @description Public by necessity (the wizard runs before any credentials exist). Deliberately answers ONE boolean and nothing else — no version, no counts, no capability data (that is authenticated surface). Rate- limited like every unauthenticated endpoint.
         */
        get: operations["getSetupState"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/first-admin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the instance's first admin account (first boot only)
         * @description Succeeds ONLY while the users table is empty — the one-time escape from the admin-creates-users chicken-and-egg. Once ANY user exists this endpoint is permanently inert and returns a 404 byte-identical to an unknown route (an attacker probing a configured instance learns nothing — same posture as restricted-content 404s, docs/PLAN.md §6.4). Responds with the created admin plus a real token pair so the wizard proceeds authenticated without a second login round-trip.
         */
        post: operations["createFirstAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Authenticate with credentials and register/refresh a device */
        post: operations["authLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate a device's refresh token for a new access token */
        post: operations["authRefresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke the current device's refresh token */
        post: operations["authLogout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List devices registered to the current user */
        get: operations["listDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/devices/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a device by id */
        get: operations["getDevice"];
        put?: never;
        post?: never;
        /** Revoke a device (deletes it and invalidates its refresh token) */
        delete: operations["revokeDevice"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public feature-flag negotiation */
        get: operations["getSystemCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Admin-only instance information */
        get: operations["getSystemInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Admin-only notify-only update check
         * @description Never triggers a download and never auto-applies anything — this is display data only. Serves the server's last completed manifest check (LOOMBRE_UPDATE_CHECK=off|manual|daily, default daily; see docs/ops/updating.md for exactly what the outbound manifest request does and does not contain — zero identifying payload). When LOOMBRE_UPDATE_CHECK=off, `verification` is always `disabled` and `latestVersion`/`notesUrl`/`checkedAtMs` are always null; the manifest mirror is never contacted.
         */
        get: operations["getSystemUpdate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List users (admin) */
        get: operations["listUsers"];
        put?: never;
        /** Create a user (admin) */
        post: operations["createUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a user by id (admin) */
        get: operations["getUser"];
        put?: never;
        post?: never;
        /** Delete a user (admin) */
        delete: operations["deleteUser"];
        options?: never;
        head?: never;
        /** Update a user (admin) */
        patch: operations["updateUser"];
        trace?: never;
    };
    "/users/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current user's profile */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update the current user's own profile */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/users/me/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current user's settings */
        get: operations["getMySettings"];
        /** Replace the current user's settings */
        put: operations["putMySettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/me/restricted": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Self-service restricted-content opt-in and PIN management — the opt-in gate of the restricted-content model. Admins cannot perform this on behalf of another user — there is no admin path to this operation. */
        put: operations["putMyRestrictedSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List libraries visible to the current user */
        get: operations["listLibraries"];
        put?: never;
        /** Create a library (admin) */
        post: operations["createLibrary"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a library by id */
        get: operations["getLibrary"];
        put?: never;
        post?: never;
        /** Delete a library (admin) */
        delete: operations["deleteLibrary"];
        options?: never;
        head?: never;
        /** Update a library (admin) */
        patch: operations["updateLibrary"];
        trace?: never;
    };
    "/libraries/{id}/scan": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enqueue an incremental or full scan job for a library (admin) */
        post: operations["scanLibrary"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{id}/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get per-user permission grants for a library (admin) */
        get: operations["getLibraryPermissions"];
        /** Replace per-user permission grants for a library (admin). Restricted libraries default-deny; a grant must be explicit even for admins' own accounts — the per-library grant gate of the restricted-content model. */
        put: operations["putLibraryPermissions"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/movies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List movies */
        get: operations["listMovies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/movies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a movie by id */
        get: operations["getMovie"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List TV series */
        get: operations["listSeries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/series/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a series by id */
        get: operations["getSeries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/series/{id}/seasons": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** List seasons of a series */
        get: operations["listSeriesSeasons"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/seasons/{id}/episodes": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** List episodes of a season */
        get: operations["listSeasonEpisodes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/episodes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get an episode by id */
        get: operations["getEpisode"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List artists */
        get: operations["listArtists"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artists/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get an artist by id */
        get: operations["getArtist"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artists/{id}/albums": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** List an artist's albums */
        get: operations["listArtistAlbums"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/albums/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get an album by id */
        get: operations["getAlbum"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/albums/{id}/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** List an album's tracks */
        get: operations["listAlbumTracks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a track by id */
        get: operations["getTrack"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/people": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List credited people visible to the current user (leak-checked: content_class isolation AND credited on >=1 visible item) */
        get: operations["listPeople"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/people/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a credited person by id */
        get: operations["getPerson"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/people/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Filmography: catalog items this person is credited on that are ALSO currently visible to the caller. Same leak model as GET /people: content_class isolation on the person AND credited-on->=1-visible- item, replayed at the item-list surface instead of the count surface. */
        get: operations["listPersonItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List genres/tags visible to the current user (leak-checked, same model as /people) */
        get: operations["listTags"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Full-text search across catalog item types */
        get: operations["search"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/home/continue-watching": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** In-progress items for the current user (computed per-viewer-context; never cached across users with different restricted-content clearance) */
        get: operations["getContinueWatching"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/home/recently-added": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recently added items visible to the current user */
        get: operations["getRecentlyAdded"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/images/{entityType}/{id}/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                entityType: components["schemas"]["ImageEntityType"];
                id: components["parameters"]["IdPathParam"];
                kind: components["schemas"]["ImageKind"];
            };
            cookie?: never;
        };
        /** Fetch a pre-scaled managed image (poster/backdrop/logo/disc/thumb). One endpoint for all image kinds and entity types (anti-pattern P4: no per-kind endpoint proliferation). */
        get: operations["getImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Compute the full playback plan for a file without starting a session: runs the `@loombre/playback-engine` `plan()` against the resolved MediaInfo, the request's DeviceProfile, server-resolved NetworkConditions/ ServerPolicy/VerifiedCapabilities, and the resolved TrackSelection, and returns the FULL PlaybackPlan (ladder, ffmpegArgs, hardware routing included). This is a read-only preview: no session row is created and no job is enqueued (contrast POST /playback/sessions). */
        post: operations["computePlaybackPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Compute a plan and start a playback session (HLS packaging job or direct-play file serving handle) */
        post: operations["createPlaybackSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}/hls/media.m3u8": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Fetch the live HLS media playlist for a transcode/direct-stream/remux session. Blocks up to 8s for the initial segment to be produced (polling `status === 'active' AND produced_segment IS NOT NULL`) before returning 503. Also accepts `?token=<accessToken>` for media elements that cannot send Authorization headers. */
        get: operations["getPlaybackHlsManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}/hls/{file}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
                /** @description `runN/sNNNNNN.m4s`, `runN/sNNNNNN.ts`, or `runN/init.mp4` (fmp4 init segment) — the transcoder's per-run layout. Strictly pattern-validated; anything else is rejected (traversal-safe by construction — a client-supplied path is never trusted). */
                file: string;
            };
            cookie?: never;
        };
        /** Serve one HLS init segment/media segment for a session. Updates the session's `requested_segment` (parsed from `file`) on every call — the transcoder's pacing input. A request for a segment index outside the currently-produced window (before the current run's start, or more than 3 segments ahead of `produced_segment`) triggers a seek request (`requestSeek`) and responds 503 (hls.js-compatible retry behavior) instead of 404 while the worker restarts the pipeline. Also accepts `?token=` for media elements that cannot send Authorization headers. */
        get: operations["getPlaybackHlsFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}/subtitles/media.m3u8": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** The segmented-VTT subtitle side-track's single-segment HLS media playlist (the "segmented WebVTT side-track" strategy, `subtitle. strategy === 'hls-vtt'`). Populated by the subtitle-extract worker job enqueued at session create — works for direct-play sessions too (a session can carry an hls-vtt subtitle side-track independent of its own video/audio decision). Also accepts `?token=` for media elements that cannot send Authorization headers. */
        get: operations["getPlaybackSubtitleManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}/subtitles/{file}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
                /** @description Always `sub0.vtt` (single-segment side-track) — strictly pattern-validated. */
                file: string;
            };
            cookie?: never;
        };
        /** Serve the extracted WebVTT file. Also accepts `?token=` for media elements that cannot send Authorization headers. */
        get: operations["getPlaybackSubtitleFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get playback session state */
        get: operations["getPlaybackSession"];
        put?: never;
        post?: never;
        /** End a playback session and release its transcode slot */
        delete: operations["endPlaybackSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playback/sessions/{id}/file": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** HTTP range-request byte serving of the session's own direct-play media file. Path resolution comes ONLY from the media_files row the session references — never from client input. Also accepts `?token=<accessToken>` since an HTML `<video>`/`<audio>` element cannot set an Authorization header. */
        get: operations["getPlaybackSessionFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/progress/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        /**
         * Read the current user's watch/listen progress for a single item
         * @description Guarded like every other catalog-adjacent read: an item that doesn't exist and an item that exists but is invisible to the caller (not in an allowed library, or restricted without full gate clearance) are byte-identical 404s. No progress row for an otherwise-visible item is ALSO a 404 (there is nothing to return — this is a single-resource read, not a list).
         */
        get: operations["getProgress"];
        /** Upsert watch/listen progress for an item (also serves as a session heartbeat) */
        put: operations["putProgress"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the current user's progress records */
        get: operations["listProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/watchlist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the current user's watchlist, newest-added first
         * @description Guarded like every other per-user, item-referencing list (docs/ PLAN.md §6.4): a row whose item is not visible to the caller right now is excluded, even if it was added while the caller was fully cleared — restricted titles never appear in the watchlist, locked or not (design/phosphor README.md "Restricted content").
         */
        get: operations["listWatchlist"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/watchlist/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Add an item to the current user's watchlist (idempotent)
         * @description 404 when the item does not exist OR is not visible to the caller — indistinguishable, matching every other guarded single-item surface (getMovie/getProgress/etc.). This is also what makes adding a restricted (zone) item UNREACHABLE without full clearance: the item is invisible, not merely disallowed, so there is no signal that distinguishes "restricted" from "does not exist" (packages/db/src/ query/watchlist.ts's addToWatchlistAndEmit).
         */
        put: operations["addToWatchlist"];
        post?: never;
        /**
         * Remove an item from the current user's watchlist (idempotent)
         * @description 404 only when the ITEM itself does not exist or is not visible to the caller — removing an item that IS visible but was never watchlisted is a successful no-op (safe to invoke more than once from the inline REMOVE control).
         */
        delete: operations["removeFromWatchlist"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/unlock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify the restricted-content PIN and open a time-boxed unlock — the session-unlock gate of the restricted-content model. Unlock state never persists across logins. */
        post: operations["unlockRestricted"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/lock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Immediately end the current restricted-content unlock */
        post: operations["lockRestricted"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Aggregate item count for the restricted zone (design/phosphor README "Restricted content": the zone's EXISTENCE and aggregate count are deliberately visible to entitled users regardless of current lock state — titles/artwork never leak through this surface, count only).
         * @description 404 for a viewer with NO restricted-library entitlement at all (the earlier restricted-content gates never passed) — the zone does not exist for them, so this operation is absent rather than answering with `{count: 0}`, which would itself be a side channel.
         */
        get: operations["getRestrictedCount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the restricted zone's own items (design/phosphor README "Restricted content": the zone's OWN query surface — a dedicated read, separate from /movies /series /search, so the zone's UI never shares a code path with the general catalog's listing/search surfaces).
         * @description 404 for a viewer with NO restricted-library entitlement at all — same posture as GET /restricted/count, the zone does not exist for them. For an entitled viewer, this responds with the real page ONLY while the current session is unlock-cleared (gate 5); an entitled- but-locked viewer gets a 200 with an EMPTY page, never titles or artwork (the affordance-level PIN gate is backed by this same server-side rule, not just a client-side redirect). Deliberately no `libraryId`/`q` params: the zone's library membership is resolved server-side from the viewer's own entitlement, never client- supplied, and there is no separate zone-search endpoint — the client fetches the (small, curated) zone in full and searches/ sorts/filters it locally, which is also how genre pills are derived rather than hardcoded.
         */
        get: operations["listRestrictedZoneItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream an open JSON archive of the caller's accessible data — no proprietary lock-in. */
        get: operations["exportData"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Import a previously exported archive (admin). Long-running; runs through the job queue (CLAUDE.md invariant #6). */
        post: operations["importData"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List job ledger entries (admin) */
        get: operations["listJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Get a job ledger entry by id (admin) */
        get: operations["getJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List active playback sessions across all users (admin, now-playing presence)
         * @description Admins are NOT exempt from restricted- content gating (the grant and session-unlock gates apply): item display fields on each session row are resolved through the REQUESTING ADMIN'S OWN ViewerContext, exactly like any other catalog read. A session on an item this admin isn't currently cleared to see is still listed (the session itself — id/user/device/status/timestamps — carries no restricted content), but `itemTitle` is `null` and `contentHidden` is `true` instead of leaking the title.
         */
        get: operations["listAdminSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The verified hardware-capability report (admin)
         * @description The CURRENT hw_capability snapshot the plan() engine consumes — what this machine's ffmpeg build PROVED it can decode/encode/tone-map, per backend, in probe order. `report` is null when no probe has completed yet (fresh install before the first hwprobe job).
         */
        get: operations["getAdminCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/crash-files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List local crash files (admin)
         * @description Crash handlers write REDACTED local files under the app-data crashes dir; this lists their metadata, newest-first. Deliberately NOT cursor-paginated (bounded set: the crash writer caps retention; a documented deviation from the cursor-everywhere rule for a bounded, small, admin-only list). Sharing remains entirely manual — nothing here transmits anything anywhere.
         */
        get: operations["listCrashFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/crash-files/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one redacted crash file's content (admin) */
        get: operations["getCrashFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/logs/tail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tail of the server's log file (admin)
         * @description Reads the last N lines of the configured log file (LOOMBRE_LOG_FILE; installers point this at the service log). `source` is null with empty `lines` when no log file is configured — stdout-only dev setups have nothing to tail, and the surface says so honestly instead of pretending.
         */
        get: operations["getAdminLogsTail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/filesystem/directories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List directories on the server, for picking library paths (admin)
         * @description Backs the "Browse" affordance in the Add-library dialog. A library path names a directory on the SERVER's filesystem, and the browser cannot see that filesystem — the web client may not even be running on the same machine (Docker runs it in a separate container). An OS file dialog is therefore structurally unable to pick these paths; the server has to enumerate them.
         *
         *     Returns DIRECTORY NAMES ONLY. It never lists files, never returns file contents, and never reveals sizes — everything it exposes is already implied by the paths an admin is about to configure. Omit `path` to list this machine's roots (drive letters on Windows, "/" plus common mount points on POSIX), then walk down one level at a time via the returned entries.
         *
         *     Admin-only, and deliberately so: enumerating a server's directory tree is reconnaissance in the wrong hands. Free-text path entry stays supported alongside it, because headless and remote installs still need to type a path that this host cannot browse to.
         */
        get: operations["browseDirectories"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Effective settings + provider-key statuses (admin)
         * @description Every registered setting's CURRENT effective value (env-pin > database > registry default precedence), independent of scope — env-only entries are included read-only alongside ui-editable ones, so an operator can always see what's actually governing the running instance. `restartPendingKeys` lists requiresRestart:true keys whose effective value has changed since this server instance booted; non-empty means a restart is needed for those changes to fully take effect. `providerKeys` (A9) carries TMDB/TVDB key status only — the key value itself is never returned by any endpoint.
         */
        get: operations["getAdminSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settings/schema": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Settings registry projection (admin) — the UI form renderer's sole input
         * @description One JSON-schema-per-key projection (generated from the server's own settings registry) feeds this endpoint, the admin settings UI's dynamic widget renderer, and the generated operator/admin docs alike — nobody hand-writes a second copy of a setting's shape anywhere. Carries no live value (see AdminSettingsResponse for that) — pair with GET /admin/settings for the effective value alongside each entry's static metadata.
         */
        get: operations["getAdminSettingsSchema"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settings/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Update one UI-editable setting's value (admin)
         * @description Re-verifies the caller's admin status with a FRESH database read at mutation time (never trusted from a possibly-stale access-token claim) before anything else, including before revealing whether `key` exists at all. Ordered checks: 403 (not currently an admin, live re-verify) -> 404 (unknown key, or a scope:'env-only' key — those are never writable through this surface — the lockout boundary) -> 409 (an active env pin governs this key right now; the submitted value is discarded unconditionally, valid or not) -> 422 (schema validation, including the restricted.majorityAgeYears >=18 floor, which cannot be configured below it through any path).
         */
        put: operations["updateAdminSetting"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/provider-keys/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: components["schemas"]["ProviderName"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set (or replace) a provider API key (admin, write-only)
         * @description A9: write-only — the submitted key is never echoed back, logged, or otherwise readable again through this API (status reads — GET /admin/settings — report set/source/lastSetMs only, never the value). Stored via the platform secret keyring (packages/secrets), never in server_settings (no encryption-at-rest story there). A10 live-admin re-verify gates this exactly like updateAdminSetting.
         */
        put: operations["setAdminProviderKey"];
        post?: never;
        /**
         * Clear a provider API key (admin)
         * @description Removes the stored keyring entry. A real env var for this provider (LOOMBRE_TMDB_API_KEY / LOOMBRE_TVDB_API_KEY), if set, still wins on the next status read regardless (A8 precedence) — this only clears the keyring-stored fallback.
         */
        delete: operations["clearAdminProviderKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fetch and validate a plugin's manifest without registering it (admin)
         * @description C4's confirmation-screen data source: fetches GET <url>/lpp/manifest through the same SSRF-guarded transport registration itself uses, runs it through the staged manifest parser, and returns a summary — every declared capability with its scope, the full configSchema, and the union of requested event types. Nothing is persisted; calling this twice for the same URL never conflicts with anything, and nothing here mints a secret. An unknown capability type in the manifest fails with 422 whose `detail` states plainly that this Loombre does not support that capability type yet (C2); a SSRF-rejected URL (private/loopback/disallowed address, unless `lanAllowlist` covers it) also fails 422.
         */
        post: operations["previewAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List registered plugins, including health/breaker state (admin)
         * @description Deliberately NOT cursor-paginated (mirrors listCrashFiles' documented deviation from the cursor-everywhere rule): a self-hosted instance's plugin registry is a small, admin-managed set, not an unbounded catalog collection.
         */
        get: operations["listAdminPlugins"];
        put?: never;
        /**
         * Register a plugin (admin)
         * @description LD6's registration state machine: re-fetches and re-validates the manifest at `url` (never trusts a client-supplied preview payload), validates the submitted grants against it, validates `config` against the manifest's configSchema (secret fields route to the keyring, never to the stored plugin row), mints the delivery-signing HMAC, runs a health check, and commits the plugin enabled with the granted scope. `hmacSecret` in the response is shown EXACTLY ONCE — it is never retrievable again through any endpoint. A failed health check does NOT block registration: the row still commits, with `healthState: unhealthy`; the admin UI is expected to surface this and offer enable-anyway vs cancel (the plugin already exists at that point — cancel means the UI immediately calling removeAdminPlugin).
         */
        post: operations["registerAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Read one registered plugin (admin) */
        get: operations["getAdminPlugin"];
        put?: never;
        post?: never;
        /**
         * Remove a plugin (admin)
         * @description LD9: deletes the plugin row (plugin_event_grants CASCADE) and every keyring entry it owns — the HMAC and every secret config field. Nothing keyring-side survives.
         */
        delete: operations["removeAdminPlugin"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/config": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Update a plugin's config values (admin)
         * @description Validated against the plugin's stored manifest configSchema exactly like registration; secret fields route to the keyring, never to the plugin row's non-secret `config`.
         */
        put: operations["updateAdminPluginConfig"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/event-grants": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Update which requested event types this plugin is granted (admin)
         * @description Full-replacement grant set for the plugin's already-GRANTED event-subscriber capability — every value must be a member of that capability's manifest-declared `eventTypes` request. Does not change which capability TYPES are granted (see reapproveAdminPlugin for that) and can never widen scope beyond what registration/reapproval already approved.
         */
        put: operations["updateAdminPluginEventGrants"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/pseudonymization": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Toggle whether this plugin receives pseudonymous or real actor ids (admin)
         * @description LPP v1 mission §3.2 (Lane W5b): plugins.pseudonymize_actor_ids (migrations/0016_plugin_delivery_cursors.sql), default TRUE — every user-id-bearing field the outbox delivery loop's actor-field map names for a delivered event is replaced with a per-(plugin,user) stable pseudonym before signing and delivery. Setting `enabled: false` sends real account ids to this plugin instead, effective immediately for every batch delivered from that point on (already- delivered batches are unaffected — this is not retroactive). Requires this plugin to currently hold the event-subscriber capability grant (409 otherwise, same guard as updateAdminPluginEventGrants) — the setting has nothing to act on for a plugin that never receives the activity feed.
         */
        put: operations["updateAdminPluginPseudonymization"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-enable a manually- or breaker-disabled plugin (admin)
         * @description Resets the health breaker. A plugin currently disabled for `disabledReason: scope-change` cannot be re-enabled this way — reapproveAdminPlugin is the only door out of that state (a plain re-enable would skip the new grant validation that state exists to force).
         */
        post: operations["enableAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Manually disable a plugin (admin) */
        post: operations["disableAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-fetch a plugin's manifest and apply/flag any scope change (admin)
         * @description Any expansion (a new capability type, broader mediaKinds, a contentClass widened general -> restricted, a broader eventTypes request) auto-disables the plugin (`disabledReason: scope-change`) and leaves the previously-approved grants untouched pending reapproveAdminPlugin — `expanded: true` and `reasons` describe exactly what grew. A non-expanding refresh updates the stored manifest snapshot in place (grants only ever narrow automatically, never requiring re-approval).
         */
        post: operations["refreshAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/reapprove": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-approve a plugin after a scope-expanding refresh (admin)
         * @description Only valid while `disabledReason: scope-change`. Re-fetches the manifest fresh (time may have passed since the expansion was detected), validates the submitted grant against it exactly like registration, and re-enables the plugin with the new grant.
         */
        post: operations["reapproveAdminPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/plugins/{id}/rotate-hmac": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate a plugin's delivery-signing HMAC secret (admin)
         * @description Mints a genuinely fresh secret, overwriting the stored one — the plugin must be reconfigured with the new value out-of-band. Returned EXACTLY ONCE, never retrievable again afterward.
         */
        post: operations["rotateAdminPluginHmac"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/provider-chain": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Read a library's metadata-provider fallback chain (admin)
         * @description LPP v1, Lane W3/W5b (migrations/0015_library_provider_chains.sql). `isDefault: true` means this library has ZERO library_provider_entries rows — `entries` then reflects the legacy hardcoded per-mediaKind default chain (apps/worker/src/metadata/provider-chain-defaults.ts), shown READ-ONLY for reference; putAdminLibraryProviderChain is the only way to customize it. `eligiblePlugins` is every registered plugin whose `contentClass` strictly EQUALS this library's `contentClass` (LPP C5 STRICT, apps/server/src/plugins/scope.ts) — the admin add-entry picker's plugin choice list. `builtinProviderNames` is the closed set of built-in provider names, always eligible regardless of `contentClass`.
         */
        get: operations["getAdminLibraryProviderChain"];
        /**
         * Replace a library's metadata-provider fallback chain wholesale (admin)
         * @description `entries` is the FULL replacement chain — `position` is the array index, not supplied explicitly. An empty `entries` array clears the chain, reverting the library to the inherited legacy default (isDefault flips back to true). Rejects the WHOLE call (no partial write) on: a malformed entry (wrong shape for its `providerKind`), an unrecognized `builtinName`, a `pluginId` that does not resolve to a registered plugin, or a `pluginId` whose plugin.contentClass does not EQUAL this library's contentClass exactly (422, LPP C5 STRICT — the error names both content classes involved). 404 if the library itself does not exist.
         */
        put: operations["putAdminLibraryProviderChain"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/unmatched": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * List catalog items in a library with no provider metadata match (Fix Match, admin)
         * @description Derived, never stored: an item of an enrichable type (movie/series/artist/album) with zero provider_ids rows. Cursor- paginated, most-recently-added first. Goes through the standard catalog guard (packages/db/src/query/guard.ts's applyGuard) with the REQUESTING ADMIN'S OWN ViewerContext — admins are not exempt from restricted-content gating or from needing their own library_permissions grant (docs/PLAN.md §6.4).
         */
        get: operations["listUnmatchedLibraryItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/items/{id}/match-search": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enqueue a bounded metadata-provider candidate search for an item (Fix Match, admin)
         * @description CLAUDE.md invariant 6 (nothing spawns provider I/O inline in a request path): enqueues a 'metadata-search' job. The worker resolves the item's provider chain, searches every enabled provider, scores each result (apps/worker/src/metadata/match.ts's title/year scoring), and delivers the ranked candidate list as an admin-only `metadata.match-candidates` event over the existing events socket (GET /admin/jobs/{id} also reflects the job's own lifecycle).
         */
        post: operations["searchItemMatchCandidates"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/items/{id}/apply-match": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Apply a chosen provider match to an item (Fix Match, admin)
         * @description Enqueues the EXISTING 'metadata' job with a forced provider ref — re-fetches provider details + artwork for exactly the chosen candidate (bypassing search/pickBestMatch) and merges them through the same field-precedence engine every scan-triggered metadata job already uses (existing nfo/tag-sourced fields keep their precedence unchanged). Never touches the original media file.
         */
        post: operations["applyItemMatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description RFC 9457 problem details. Extension members are additive. */
        Problem: {
            /**
             * Format: uri-reference
             * @default about:blank
             */
            type: string;
            title: string;
            status: number;
            detail?: string;
            /** Format: uri-reference */
            instance?: string;
            /** @description Stable machine-readable error code, additional to `type`. */
            code?: string;
        } & {
            [key: string]: unknown;
        };
        /** @enum {string} */
        ItemType: "movie" | "series" | "season" | "episode" | "artist" | "album" | "track";
        /**
         * @description Coarse restricted-content gate on libraries, inherited by items.
         * @enum {string}
         */
        ContentClass: "general" | "restricted";
        /** @enum {string} */
        MediaKind: "movie" | "tv" | "music";
        /**
         * @description Entity types a managed image can belong to. `person` images are guarded by the SAME leak rule listPeople/getPersonById use (content_class isolation AND credited-on->=1-visible-item), so a person invisible to the caller has no reachable images either. This value plus the server-side mapping fix close that gap so a Person page portrait (GET /images/person/{id}/thumb) can be served.
         * @enum {string}
         */
        ImageEntityType: "movie" | "series" | "season" | "episode" | "artist" | "album" | "track" | "person";
        /** @enum {string} */
        ImageKind: "poster" | "backdrop" | "logo" | "disc" | "thumb";
        /** @enum {string} */
        ImageFormat: "webp" | "avif" | "jpeg";
        /** @enum {string} */
        ProgressState: "unplayed" | "in-progress" | "played";
        /** @enum {string} */
        ItemTagKind: "genre" | "tag";
        /** @description One pre-scaled managed image variant. Never computed on request (Tier-0 rule) — width/height/blurhash/dominantColor mirror the `images` table row an ingest-time worker_thread wrote. */
        ImageDescriptor: {
            kind: components["schemas"]["ImageKind"];
            width: number | null;
            height: number | null;
            blurhash: string | null;
            /** @description Hex '#rrggbb' dominant colour extracted worker-side at ingest. Null when not yet computed/unavailable. */
            dominantColor?: string | null;
        };
        LoginRequest: {
            /** Format: email */
            email?: string;
            username?: string;
            /** Format: password */
            password: string;
            deviceName: string;
            deviceProfile: components["schemas"]["DeviceProfile"];
            /**
             * Format: uuid
             * @description Reuse an existing device row owned by the authenticating user: its refresh-token chain is rotated and profile/last-seen refreshed instead of a new row being created. Omitted, unknown, or owned by a different user -> a new device is registered; device existence is never leaked either way.
             */
            deviceId?: string;
        };
        RefreshRequest: {
            refreshToken: string;
            /** Format: uuid */
            deviceId: string;
        };
        LogoutRequest: {
            /** Format: uuid */
            deviceId?: string;
        };
        TokenPair: {
            accessToken: string;
            refreshToken: string;
            /**
             * Format: int64
             * @description Epoch milliseconds; access tokens are 15-minute lived.
             */
            accessTokenExpiresAtMs: number;
            /** Format: uuid */
            deviceId: string;
        };
        /** @description Client-declared at login, server-validated against this schema. Never "best-guessed" when invalid — a malformed profile is rejected with 422, not patched inside plan(). */
        DeviceProfile: {
            /** @description e.g. 'web-chrome', 'web-safari' */
            profileId: string;
            directPlayContainers: components["schemas"]["Container"][];
            hls: {
                /** @enum {string} */
                container: "fmp4" | "ts";
                supportsFmp4: boolean;
                lowLatency: boolean;
            };
            video: {
                codec: components["schemas"]["VideoCodec"];
                maxProfile: string | null;
                maxLevel: number | null;
                /** @enum {integer} */
                maxBitDepth: 8 | 10;
                maxWidth: number;
                maxHeight: number;
                maxFrameRate: number;
                maxBitrateBps: number | null;
            }[];
            hdr: {
                hdr10: boolean;
                hlg: boolean;
                dolbyVision: boolean;
            };
            audio: {
                codec: components["schemas"]["AudioCodec"];
                maxChannels: number;
                /** @description Bitstream passthrough support (TrueHD/DTS-HD). */
                passthrough: boolean;
            }[];
            subtitles: {
                renderText: components["schemas"]["SubtitleCodec"][];
                hlsVtt: boolean;
                renderImage: boolean;
            };
            /** @description Device hard cap (e.g. TV SoC limits). */
            maxStreamBitrateBps: number | null;
        };
        Device: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            userId: string;
            name: string;
            profileId: string;
            capabilityProfile: components["schemas"]["DeviceProfile"] | null;
            /** Format: int64 */
            lastSeenAtMs: number;
            /** Format: int64 */
            createdAtMs: number;
        };
        DevicePage: {
            items: components["schemas"]["Device"][];
            nextCursor: string | null;
        };
        /** @enum {string} */
        CapabilityFlag: "music" | "restricted-content" | "hls-ll" | "hw-transcode" | "remote-access" | "data-export" | "data-import";
        CapabilityDetail: {
            enabled: boolean;
            description?: string | null;
        };
        Capabilities: {
            flags: components["schemas"]["CapabilityFlag"][];
            /** @description Map of every known CapabilityFlag to its detail object. */
            details: {
                [key: string]: components["schemas"]["CapabilityDetail"];
            };
        };
        SystemInfo: {
            version: string;
            /** @enum {string} */
            os: "linux" | "macos" | "windows";
            /** @enum {integer} */
            tier: 0 | 1 | 2;
            nodeVersion?: string | null;
            /** Format: int64 */
            uptimeMs?: number | null;
            storagePool?: components["schemas"]["StoragePoolStats"] | null;
        };
        StoragePoolStats: {
            /** Format: int64 */
            usedBytes: number;
            /** Format: int64 */
            totalBytes: number;
        };
        /**
         * @description `verified`: the fetched manifest's minisign signature checked out against the pinned public key and `latestVersion`/ `notesUrl` reflect it. `signature-invalid`: a manifest was fetched but its signature did not verify (tampered, wrong key, or an unsupported prehashed-'ED' minisig — @loombre/release-manifest's closed failure-reason set collapses to this one contract value). `unreachable`: the manifest mirror could not be reached, returned a non-2xx status, or returned a response that wasn't a well-formed manifest for this server's channel. `disabled`: LOOMBRE_UPDATE_CHECK=off — no network request was made.
         * @enum {string}
         */
        SystemUpdateVerification: "verified" | "signature-invalid" | "unreachable" | "disabled";
        SystemUpdateInfo: {
            /** @description This server build's own version (matches SystemInfo.version). */
            currentVersion: string;
            /** @description Release channel this server tracks (single member today: "stable"). */
            channel: string;
            /** @description Null unless verification is "verified" and the manifest lists at least one release. */
            latestVersion: string | null;
            updateAvailable: boolean;
            /** @description The latest release's notes URL; null under the same conditions as latestVersion. */
            notesUrl: string | null;
            /**
             * Format: int64
             * @description When this result was produced; null only when verification is "disabled" (no check ever ran).
             */
            checkedAtMs: number | null;
            verification: components["schemas"]["SystemUpdateVerification"];
        };
        SetupState: {
            /** @description True iff the users table is empty (first boot / restored-empty instance). */
            needsSetup: boolean;
        };
        FirstAdminRequest: {
            username: string;
            /** Format: email */
            email: string;
            /** Format: password */
            password: string;
            displayName?: string | null;
        };
        FirstAdminResponse: {
            user: components["schemas"]["User"];
            tokens: components["schemas"]["TokenPair"];
        };
        CapabilityBackend: {
            /** @description Backend identifier as probed (videotoolbox, nvenc, qsv, vaapi, d3d11va, software — closed set enforced by the DB CHECK, mirrored not re-enumerated here so a new backend is additive). */
            name: string;
            /** @description Probe order (docs/PLAYBACK.md §8.2 — array order is load-bearing for the plan engine). */
            position: number;
            decode: string[];
            encode: string[];
            toneMap: string[];
        };
        CapabilityReport: {
            /** @enum {string} */
            platform: "linux" | "macos" | "windows";
            /** @description sha256 of the resolved ffmpeg's -version output (the capability report's invalidation key). */
            ffmpegBuildHash: string;
            /** @description Best-effort GPU identity hash; null when the per-platform probe command failed. */
            gpuFingerprint: string | null;
            /** Format: int64 */
            verifiedAtMs: number;
            backends: components["schemas"]["CapabilityBackend"][];
        };
        CapabilityReportEnvelope: {
            /** @description Null before the first hwprobe job completes. */
            report: components["schemas"]["CapabilityReport"] | null;
        };
        CrashFile: {
            /** @description Basename only — pass verbatim to getCrashFile; never a path. */
            name: string;
            /** Format: int64 */
            sizeBytes: number;
            /** Format: int64 */
            mtimeMs: number;
        };
        DirectoryEntry: {
            /** @description The directory's own name (its last path segment). */
            name: string;
            /** @description Absolute path, ready to pass straight back as this endpoint's `path` parameter or to use as a library path. Built by the server so the client never has to join path segments itself and get the separator wrong on the other platform. */
            path: string;
        };
        DirectoryListing: {
            /** @description The directory that was listed, or null for the roots listing (no `path` parameter was supplied). */
            path: string | null;
            /** @description Absolute path one level up, or null when already at a root. Supplied by the server because "the parent of this path" is a platform-specific question the client should not answer. */
            parent: string | null;
            /** @description Immediate subdirectories, name-sorted. Entries the server cannot read are OMITTED rather than failing the whole listing — one unreadable system directory must not make a browsable parent un-browsable. */
            entries: components["schemas"]["DirectoryEntry"][];
        };
        CrashFileList: {
            /** @description Newest first; bounded by the crash writer's retention cap. */
            items: components["schemas"]["CrashFile"][];
        };
        LogTail: {
            /** @description Basename of the tailed file; null when LOOMBRE_LOG_FILE is unconfigured (lines is then empty). */
            source: string | null;
            lines: string[];
        };
        User: {
            /** Format: uuid */
            id: string;
            username: string;
            /** Format: email */
            email: string;
            displayName?: string | null;
            isAdmin: boolean;
            /**
             * Format: date
             * @description Basis for age-rating limits (docs/PLAN.md §6.3); null = not set.
             */
            birthDate: string | null;
            /** @description Admin-set ceiling on servable content rating (e.g. a kid profile capped at PG). */
            maxContentRating: string | null;
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
        };
        UserPage: {
            items: components["schemas"]["User"][];
            nextCursor: string | null;
        };
        CreateUserRequest: {
            username: string;
            /** Format: email */
            email: string;
            /** Format: password */
            password: string;
            displayName?: string | null;
            /** @default false */
            isAdmin: boolean;
            maxContentRating?: string | null;
        };
        /** @description Admin update of another user. Partial; only present fields change. */
        UpdateUserRequest: {
            /** Format: email */
            email?: string;
            displayName?: string | null;
            isAdmin?: boolean;
            maxContentRating?: string | null;
        };
        /** @description Self-service profile update; cannot change isAdmin or maxContentRating. */
        UpdateMeRequest: {
            displayName?: string | null;
            /** Format: email */
            email?: string;
            /** Format: date */
            birthDate?: string | null;
            /** Format: password */
            password?: string;
        };
        UserSettings: {
            /** @description Read-only mirror here; changed only via PUT /users/me/restricted. */
            readonly restrictedOptIn: boolean;
            locale: string;
            /** @enum {string} */
            theme: "light" | "dark" | "system";
            /** @description ISO 639-2 (lowercase 3-letter code, e.g. "eng"), or null for no preference. Server-side membership in the known-language list is validated beyond this shape (the shape alone cannot express "a real language code"). */
            subtitlePreferredLanguage: string | null;
            /** @description ISO 639-2 (lowercase 3-letter code, e.g. "eng"), or null for no preference. Same known-language-list validation as subtitlePreferredLanguage above. */
            audioPreferredLanguage: string | null;
            autoplayNextEpisode: boolean;
            /** Format: int64 */
            updatedAtMs: number;
        };
        RestrictedSettingsUpdate: {
            optIn: boolean;
            /** @description New PIN to set (required when enabling opt-in or changing PIN). Exactly 4 digits: the unlock prompt is a fixed 4-digit buffer, so a PIN of any other length could never be entered again and would lock the user out of restricted content permanently. */
            pin?: string;
            /** @description Required to change an existing PIN or to opt out. Proves an ALREADY-STORED PIN and is therefore DELIBERATELY not length- or pattern-constrained: an install predating the 4-digit rule above may hold a PIN of some other length, and this field is that user's only recovery path (prove the old PIN, set a conforming new one, or opt out). It is only ever compared against a stored hash, never stored, so the looser shape widens nothing. */
            currentPin?: string;
        };
        RestrictedSettings: {
            optIn: boolean;
            hasPin: boolean;
            /** Format: int64 */
            unlockedUntilMs: number | null;
        };
        Library: {
            /** Format: uuid */
            id: string;
            name: string;
            mediaKind: components["schemas"]["MediaKind"];
            paths: string[];
            contentClass: components["schemas"]["ContentClass"];
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
            /** Format: int64 */
            itemCount?: number;
        };
        LibraryPage: {
            items: components["schemas"]["Library"][];
            nextCursor: string | null;
        };
        CreateLibraryRequest: {
            name: string;
            mediaKind: components["schemas"]["MediaKind"];
            paths: string[];
            contentClass?: components["schemas"]["ContentClass"];
        };
        UpdateLibraryRequest: {
            name?: string;
            paths?: string[];
        };
        ScanLibraryRequest: {
            /**
             * @description Full rescan vs. incremental (default).
             * @default false
             */
            full: boolean;
        };
        LibraryPermission: {
            /** Format: uuid */
            userId: string;
            granted: boolean;
        };
        LibraryPermissionSet: {
            /** Format: uuid */
            libraryId: string;
            permissions: components["schemas"]["LibraryPermission"][];
        };
        CatalogItemBase: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            libraryId: string;
            itemType: components["schemas"]["ItemType"];
            title: string;
            sortTitle: string;
            year: number | null;
            communityRating: number | null;
            contentClass: components["schemas"]["ContentClass"];
            /** Format: int64 */
            addedAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
        };
        /** @enum {string} */
        PersonRole: "actor" | "director" | "writer" | "artist" | "album_artist" | "performer" | "guest";
        /** @description Mirrors item_people/people (packages/db/migrations/0001_init.sql): `id` is the credited PERSON's id (not the item_people join-row id), so a client can link straight to GET /people/{id}. Restricted-class people are never credited on a visible general item's response — the same content_class join-guard search.ts/catalog-detail.ts already use for tags applies here. */
        PersonCredit: {
            /** Format: uuid */
            id: string;
            name: string;
            role: components["schemas"]["PersonRole"];
            /** @description e.g. character name ("as Batman"). */
            credit?: string | null;
            order: number;
        };
        /** @description One probed audio stream on a MediaFileSummary (what the movie-detail METADATA "Audio" row displays). */
        MediaFileAudioTrack: {
            codec: components["schemas"]["AudioCodec"];
            channels: number | null;
            /** @description ISO 639-2 */
            language: string | null;
            isDefault: boolean;
        };
        /** @description One media_streams subtitle row on a MediaFileSummary (movie-detail METADATA "Subtitles" row — packages/db's MediaFileSubtitleTrackSummary). */
        MediaFileSubtitleTrack: {
            language: string | null;
            isForced: boolean;
        };
        /** @description One media_files row (packages/db/migrations/0001_init.sql), for the version/edition picker (multi-version/multi-part items, §8.1) and diagnosability. `width`/`height` come from that file's primary video stream (media_streams) and are null for audio-only files or files not yet probed. `path`/`isDefault`/`videoCodec`/`bitDepth`/`hdr`/ `audioTracks`/`subtitleTracks` (the movie-detail VERSIONS + METADATA cards) are the same additive, already-probed columns — real columns already written by the scanner, newly exposed, nothing derived or invented. Deliberately NOT in `required`, unlike the original seven fields: this schema doubles as POST /import's ExportArchive request body (data-freedom.controller.ts), and an archive written by an older Loombre version won't carry them — making them required would be a breaking contract change for that import path (oasdiff-caught). GET /movies|episodes|tracks/{id} always populates every one of them; only a foreign/older import payload may omit them. */
        MediaFileSummary: {
            /** Format: uuid */
            id: string;
            versionLabel: string | null;
            /**
             * @description Null until the file has been probed.
             * @enum {string|null}
             */
            container: "mp4" | "mkv" | "webm" | "avi" | "ts" | "mov" | "flac" | "mp3" | "ogg" | "m4a" | "wav" | "asf" | "mpeg" | "flv" | "aac" | "aiff" | null;
            width: number | null;
            height: number | null;
            /** Format: int64 */
            sizeBytes: number | null;
            /** Format: int64 */
            durationMs: number | null;
            /** @description Full on-disk path (media_files.path). Read-only diagnosability (docs/PLAN.md §8.4's MediaInfo precedent), same visibility level as the rest of this object — never a write target. */
            path?: string;
            /** @description True for the item's primary/default file — the unlabelled row if one exists, else the earliest-ingested (lowest id) among the item's files. Derived per request, not a stored column (no multi-version item exists that would make it ambiguous today). */
            isDefault?: boolean;
            /** @description Null for audio-only files or files not yet probed. */
            videoCodec?: components["schemas"]["VideoCodec"] | null;
            /** @enum {integer|null} */
            bitDepth?: 8 | 10 | 12 | null;
            /** @description Null alongside videoCodec/bitDepth for the same files. */
            hdr?: components["schemas"]["HdrType"] | null;
            audioTracks?: components["schemas"]["MediaFileAudioTrack"][];
            subtitleTracks?: components["schemas"]["MediaFileSubtitleTrack"][];
        };
        Movie: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "movie";
            contentRating: string | null;
            /** Format: int64 */
            runtimeMs: number | null;
            overview: string | null;
            tagline?: string | null;
            genres: string[];
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
            /** @description Only populated by GET /movies/{id}; absent on list responses. */
            people?: components["schemas"]["PersonCredit"][];
            /** @description Only populated by GET /movies/{id}; absent on list responses. */
            mediaFiles?: components["schemas"]["MediaFileSummary"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "movie";
        };
        MoviePage: {
            items: components["schemas"]["Movie"][];
            nextCursor: string | null;
        };
        Series: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "series";
            contentRating: string | null;
            overview: string | null;
            /** @enum {string|null} */
            status: "continuing" | "ended" | "cancelled" | null;
            genres: string[];
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
            /** @description Only populated by GET /series/{id}; absent on list responses. */
            people?: components["schemas"]["PersonCredit"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "series";
        };
        SeriesPage: {
            items: components["schemas"]["Series"][];
            nextCursor: string | null;
        };
        Season: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "season";
            /** Format: uuid */
            seriesId: string;
            seasonNumber: number;
            episodeCount?: number | null;
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
        };
        SeasonPage: {
            items: components["schemas"]["Season"][];
            nextCursor: string | null;
        };
        Episode: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "episode";
            /** Format: uuid */
            seasonId: string;
            /** Format: uuid */
            seriesId: string;
            episodeNumber: number;
            /** Format: int64 */
            runtimeMs: number | null;
            overview: string | null;
            /** Format: int64 */
            airDateMs?: number | null;
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
            /** @description Only populated by GET /episodes/{id}; absent on list responses. */
            people?: components["schemas"]["PersonCredit"][];
            /** @description Only populated by GET /episodes/{id}; absent on list responses. */
            mediaFiles?: components["schemas"]["MediaFileSummary"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "episode";
        };
        EpisodePage: {
            items: components["schemas"]["Episode"][];
            nextCursor: string | null;
        };
        Artist: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "artist";
            overview: string | null;
            genres: string[];
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
            /** @description Only populated by GET /artists/{id}; absent on list responses. */
            people?: components["schemas"]["PersonCredit"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "artist";
        };
        ArtistPage: {
            items: components["schemas"]["Artist"][];
            nextCursor: string | null;
        };
        Album: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "album";
            /** Format: uuid */
            artistId: string;
            trackCount?: number | null;
            genres: string[];
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "album";
        };
        AlbumPage: {
            items: components["schemas"]["Album"][];
            nextCursor: string | null;
        };
        Track: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "track";
            /** Format: uuid */
            albumId: string;
            /** Format: uuid */
            artistId: string;
            trackNumber: number | null;
            discNumber?: number | null;
            /** Format: int64 */
            durationMs: number | null;
            /** @description Always present; empty array when no images have been ingested yet (Tier-0 rule — never computed on request). Not request-required (additive-only: POST /import's ExportArchive reuses these same entity schemas as a request body). */
            images?: components["schemas"]["ImageDescriptor"][];
            /** @description Only populated by GET /tracks/{id}; absent on list responses. */
            mediaFiles?: components["schemas"]["MediaFileSummary"][];
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            itemType: "track";
        };
        TrackPage: {
            items: components["schemas"]["Track"][];
            nextCursor: string | null;
        };
        /** @description Fields mirror packages/db's guarded PersonRow exactly (id, name, contentClass, creditCount) — see packages/db/src/query/people.ts. creditCount is DISTINCT items visible to the caller this person is credited on, never a raw credit-row count. */
        Person: {
            /** Format: uuid */
            id: string;
            name: string;
            contentClass: components["schemas"]["ContentClass"];
            creditCount: number;
        };
        PersonPage: {
            items: components["schemas"]["Person"][];
            nextCursor: string | null;
        };
        PersonItemEntry: {
            itemType: components["schemas"]["ItemType"];
            item: components["schemas"]["Movie"] | components["schemas"]["Series"] | components["schemas"]["Episode"] | components["schemas"]["Artist"];
        };
        PersonItemPage: {
            items: components["schemas"]["PersonItemEntry"][];
            nextCursor: string | null;
        };
        /** @description Fields mirror packages/db's guarded TagRow exactly (id, name, contentClass, itemCount) — see packages/db/src/query/tags.ts. A tag row carries no single `kind` of its own (kind lives on the item_tags edge); itemCount is scoped to the `kind` query param when supplied, otherwise counts DISTINCT visible items across both kinds. */
        Tag: {
            /** Format: uuid */
            id: string;
            name: string;
            contentClass: components["schemas"]["ContentClass"];
            itemCount: number;
        };
        TagPage: {
            items: components["schemas"]["Tag"][];
            nextCursor: string | null;
        };
        SearchResult: {
            itemType: components["schemas"]["ItemType"];
            /** @description One of the catalog entity schemas, discriminated by itemType. */
            item: components["schemas"]["Movie"] | components["schemas"]["Series"] | components["schemas"]["Artist"] | components["schemas"]["Album"] | components["schemas"]["Track"];
        };
        SearchResultPage: {
            items: components["schemas"]["SearchResult"][];
            nextCursor: string | null;
        };
        ContinueWatchingEntry: {
            itemType: components["schemas"]["ItemType"];
            item: components["schemas"]["Movie"] | components["schemas"]["Episode"] | components["schemas"]["Track"];
            progress: components["schemas"]["Progress"];
        };
        ContinueWatchingPage: {
            items: components["schemas"]["ContinueWatchingEntry"][];
            nextCursor: string | null;
        };
        RecentlyAddedEntry: {
            itemType: components["schemas"]["ItemType"];
            item: components["schemas"]["Movie"] | components["schemas"]["Series"] | components["schemas"]["Album"];
        };
        RecentlyAddedPage: {
            items: components["schemas"]["RecentlyAddedEntry"][];
            nextCursor: string | null;
        };
        WatchlistEntry: {
            itemType: components["schemas"]["ItemType"];
            item: components["schemas"]["Movie"] | components["schemas"]["Series"] | components["schemas"]["Album"];
            /** Format: int64 */
            addedAtMs: number;
        };
        WatchlistPage: {
            items: components["schemas"]["WatchlistEntry"][];
            nextCursor: string | null;
        };
        Progress: {
            /** Format: uuid */
            itemId: string;
            /** Format: int64 */
            positionMs: number;
            /** Format: int64 */
            durationMs?: number | null;
            state: components["schemas"]["ProgressState"];
            playCount: number;
            /** Format: int64 */
            updatedAtMs: number;
        };
        ProgressUpdate: {
            /** Format: int64 */
            positionMs: number;
            /** Format: int64 */
            durationMs?: number | null;
            state: components["schemas"]["ProgressState"];
            /**
             * Format: uuid
             * @description Optional playback session id. When present, this write also heartbeats that session (docs/PLAYBACK.md §9): "the client progress PUT doubles as heartbeat".
             */
            sessionId?: string;
        };
        ProgressPage: {
            items: components["schemas"]["Progress"][];
            nextCursor: string | null;
        };
        /**
         * @description Source container (docs/PLAYBACK.md §2.1). Since v1.1, asf/mpeg/flv/aac/aiff admit legacy-format ingestion (wmv/wma->asf, mpg/mpeg/vob->mpeg) — never direct-playable.
         * @enum {string}
         */
        Container: "mp4" | "mkv" | "webm" | "avi" | "ts" | "mov" | "flac" | "mp3" | "ogg" | "m4a" | "wav" | "asf" | "mpeg" | "flv" | "aac" | "aiff";
        /** @enum {string} */
        VideoCodec: "h264" | "hevc" | "av1" | "vp9" | "mpeg2" | "vc1" | "mpeg4" | "unknown";
        /** @enum {string} */
        AudioCodec: "aac" | "ac3" | "eac3" | "truehd" | "dts" | "dtshd" | "flac" | "opus" | "mp3" | "vorbis" | "pcm" | "unknown";
        /** @enum {string} */
        SubtitleCodec: "subrip" | "ass" | "webvtt" | "mov_text" | "pgs" | "vobsub" | "dvbsub" | "unknown";
        /** @enum {string} */
        HdrType: "none" | "hdr10" | "hlg" | "dv";
        VideoStream: {
            index: number;
            codec: components["schemas"]["VideoCodec"];
            profile: string | null;
            level: number | null;
            width: number;
            height: number;
            /** @enum {integer} */
            bitDepth: 8 | 10 | 12;
            frameRate: number;
            bitrateBps: number | null;
            hdr: components["schemas"]["HdrType"];
            /** @enum {integer|null} */
            dvProfile: 5 | 7 | 8 | null;
            dvBlCompatId: number | null;
            interlaced: boolean;
        };
        AudioStream: {
            index: number;
            codec: components["schemas"]["AudioCodec"];
            channels: number;
            sampleRate: number;
            bitrateBps: number | null;
            /** @description ISO 639-2 */
            language: string | null;
            isDefault: boolean;
            /** @description TrueHD/EAC3 JOC side data. */
            hasAtmos: boolean;
        };
        SubtitleStream: {
            index: number;
            codec: components["schemas"]["SubtitleCodec"];
            language: string | null;
            isForced: boolean;
            isDefault: boolean;
            isExternal: boolean;
            externalPath: string | null;
        };
        /** @description Probed media file description (docs/PLAYBACK.md §2.1), derived server-side from `media_files`/`media_streams` rows. Not client input; exposed read-only for diagnosability (product principle #1 — a plan's "why" must be inspectable), e.g. on PlaybackSession. */
        MediaInfo: {
            /** Format: uuid */
            fileId: string;
            container: components["schemas"]["Container"];
            /** Format: int64 */
            durationMs: number;
            /** Format: int64 */
            sizeBytes: number;
            overallBitrateBps: number;
            video: components["schemas"]["VideoStream"][];
            audio: components["schemas"]["AudioStream"][];
            subtitle: components["schemas"]["SubtitleStream"][];
        };
        NetworkConditions: {
            /**
             * Format: int64
             * @description min(user setting, measured estimate, device cap).
             */
            maxBitrateBps: number;
            /** @description RFC1918/loopback source; relaxes the bitrate rung cap only. */
            isLocal: boolean;
        };
        /** @description Resolved by the session service before plan() is invoked (docs/PLAYBACK.md §2.6). Emits no reasons; pure input. */
        TrackSelection: {
            videoStreamIndex?: number | null;
            audioStreamIndex?: number | null;
            subtitleStreamIndex?: number | null;
        };
        PlanRequest: {
            /** Format: uuid */
            itemId: string;
            /**
             * Format: uuid
             * @description Defaults to the item's primary media_files row when omitted.
             */
            mediaFileId?: string | null;
            device: components["schemas"]["DeviceProfile"];
            network: components["schemas"]["NetworkConditions"];
            /** @enum {string} */
            mode: "stream" | "download";
            selection?: components["schemas"]["TrackSelection"];
        };
        /** @description Closed enum plus two pattern-typed families (docs/PLAYBACK.md §4). Additions to the fixed list are contract PRs. */
        PlanReasonCode: ("container-not-direct-playable" | "video-codec-unsupported" | "video-profile-unsupported" | "video-level-exceeds-device" | "video-bitdepth-unsupported" | "video-resolution-exceeds-device" | "video-framerate-exceeds-device" | "video-interlaced" | "hdr-tone-map-required" | "dv-profile5-requires-tonemap" | "tone-map-refused-by-policy" | "audio-codec-unsupported" | "audio-channels-exceed-device" | "audio-passthrough-unsupported" | "subtitle-format-requires-burn-in" | "subtitle-burn-in-for-styling" | "video-transcode-for-subtitle-burn-in" | "bitrate-exceeds-network" | "subtitle-codec-unknown" | "transcode-disabled-by-policy" | "dv-stripped-to-hdr10" | "subtitle-styling-lost" | "audio-atmos-lost" | "gapless-degraded") | string;
        PlanReason: {
            code: components["schemas"]["PlanReasonCode"];
            streamIndex?: number | null;
            detail?: string | null;
        };
        /**
         * @description Method used for HDR->SDR tone mapping (docs/PLAYBACK.md §5/§8.3) — MUST match @loombre/playback-engine's ToneMapMethod exactly. `toneMap` is OPTIONAL (absent means "no tone-map"), never present with a literal `'none'` value.
         * @enum {string}
         */
        ToneMapMethod: "opencl" | "vulkan" | "videotoolbox" | "cuda" | "cpu-zscale";
        /** @enum {string} */
        PlanContainer: "source" | "fmp4-hls" | "ts-hls" | "mp4";
        VideoAction: {
            /** @enum {string} */
            action: "copy" | "transcode" | "none";
            targetCodec?: components["schemas"]["VideoCodec"];
            /** @description Selected hardware backend or 'software' (docs/PLAYBACK.md §8.3). */
            encoder?: string;
            toneMap?: components["schemas"]["ToneMapMethod"];
        };
        AudioAction: {
            /** @enum {string} */
            action: "copy" | "transcode" | "none";
            targetCodec?: components["schemas"]["AudioCodec"];
            targetChannels?: number;
            targetBitrateBps?: number;
        };
        SubtitleAction: {
            /** @enum {string} */
            strategy: "none" | "embed" | "hls-vtt" | "burn-in";
            streamIndex?: number;
        };
        /** @enum {string} */
        LadderCodec: "h264" | "hevc";
        LadderRung: {
            heightPx: number;
            videoBitrateBps: number;
            audioBitrateBps: number;
            codec: components["schemas"]["LadderCodec"];
        };
        /** @description MUST match docs/PLAYBACK.md §5 exactly. Deterministic given identical inputs (stable key ordering, docs/PLAYBACK.md §0 law 1). */
        PlaybackPlan: {
            /** @enum {string} */
            decision: "direct-play" | "direct-stream" | "remux" | "transcode";
            /** @description REQUIRED; may be empty only when decision === direct-play. */
            reasons: components["schemas"]["PlanReason"][];
            container: components["schemas"]["PlanContainer"];
            video: components["schemas"]["VideoAction"];
            audio: components["schemas"]["AudioAction"];
            subtitle: components["schemas"]["SubtitleAction"];
            ladder: components["schemas"]["LadderRung"][];
            /** @description Ordered deterministic tokens (docs/PLAYBACK.md §6); empty for direct-play. */
            ffmpegArgs: string[];
            /** @description Semver of the decision ruleset, for audit rows. */
            engineVersion: string;
        };
        /** @enum {string} */
        PlaybackSessionStatus: "created" | "starting" | "active" | "suspended" | "seeking" | "ended" | "failed";
        PlaybackSession: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            itemId: string;
            /** Format: uuid */
            userId: string;
            /** Format: uuid */
            deviceId: string;
            plan: components["schemas"]["PlaybackPlan"];
            media?: components["schemas"]["MediaInfo"];
            status: components["schemas"]["PlaybackSessionStatus"];
            errorCode: string | null;
            /** @description Relative URL to GET .../hls/media.m3u8; null for direct-play sessions (docs/PLAYBACK.md §9 — direct-play bypasses HLS packaging entirely). */
            manifestUrl?: string | null;
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
        };
        UnlockRequest: {
            /** @description Exactly 4 digits, the same shape RestrictedSettingsUpdate.pin accepts. A value of any other length is a 422 (request shape), NOT the 401 a well-formed but incorrect PIN gets. */
            pin: string;
        };
        UnlockResponse: {
            /** Format: int64 */
            unlockedUntilMs: number;
        };
        RestrictedCount: {
            /**
             * Format: int64
             * @description Aggregate item count of the restricted zone — count only, never titles/artwork (design/phosphor README "Restricted content").
             */
            count: number;
        };
        /** @description Per-item 4K/HDR signal for the zone's own filter chips — not part of Movie/Series (list responses there carry no mediaFiles/streams data, Tier-0), so this is scoped to the zone's own dedicated read. */
        RestrictedZoneItemQuality: {
            /** @description Primary video stream >= 3840x2160 on any non-missing media file. */
            is4k: boolean;
            hdr: components["schemas"]["HdrType"];
        };
        RestrictedZoneItem: components["schemas"]["CatalogItemBase"] & {
            itemType: components["schemas"]["ItemType"];
            genres: string[];
            images: components["schemas"]["ImageDescriptor"][];
            quality: components["schemas"]["RestrictedZoneItemQuality"];
        };
        RestrictedZoneItemPage: {
            items: components["schemas"]["RestrictedZoneItem"][];
            nextCursor: string | null;
        };
        /** @description A user record sans secrets (no password hash, no PIN hash, no tokens). */
        ExportUser: {
            /** Format: uuid */
            id: string;
            username: string;
            /** Format: email */
            email: string;
            isAdmin: boolean;
            /** Format: int64 */
            createdAtMs: number;
        };
        ExportPlaylist: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            userId: string;
            name: string;
            itemIds: string[];
            /** Format: int64 */
            createdAtMs: number;
        };
        /** @description Open JSON archive per docs/PLAN.md §8.4 (P12) — data freedom without API compatibility. Import accepts the same shape. */
        ExportArchive: {
            /** Format: int64 */
            exportedAtMs: number;
            users: components["schemas"]["ExportUser"][];
            libraries: components["schemas"]["Library"][];
            /** @description Catalog items across all types with their provider ids; kept as a loose envelope here (concrete per-type shapes are Movie/Series/ Season/Episode/Artist/Album/Track). */
            items: (components["schemas"]["Movie"] | components["schemas"]["Series"] | components["schemas"]["Season"] | components["schemas"]["Episode"] | components["schemas"]["Artist"] | components["schemas"]["Album"] | components["schemas"]["Track"])[];
            progress: components["schemas"]["Progress"][];
            playlists: components["schemas"]["ExportPlaylist"][];
        };
        JobRef: {
            /** Format: uuid */
            jobId: string;
        };
        /** @enum {string} */
        JobStatus: "queued" | "active" | "completed" | "failed" | "cancelled";
        /** @description Job ledger row, typed fields matching the server's `jobs` table exactly (pg-boss driver + ledger mirror). */
        Job: {
            /** Format: uuid */
            id: string;
            /** @description Closed job-type registry key (@loombre/jobs), e.g. 'scan', 'probe', 'image', 'metadata', 'import'. */
            type: string;
            status: components["schemas"]["JobStatus"];
            priority: number;
            attempts: number;
            lastError: string | null;
            /** Format: uuid */
            subjectItemId: string | null;
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
            /** Format: int64 */
            startedAtMs: number | null;
            /** Format: int64 */
            finishedAtMs: number | null;
        };
        JobPage: {
            items: components["schemas"]["Job"][];
            nextCursor: string | null;
        };
        /** @description GET /admin/sessions row. Item display fields are gated through the requesting admin's OWN ViewerContext (see the operation description); a session whose item this admin cannot currently see keeps itemTitle null and contentHidden true rather than being omitted from the page. */
        AdminSession: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            userId: string;
            username: string;
            /** Format: uuid */
            deviceId: string | null;
            deviceName: string | null;
            /** Format: uuid */
            itemId: string | null;
            /** @description Null when contentHidden is true, or when there is no recoverable item at all. */
            itemTitle: string | null;
            /** @description True iff this session's item exists but is not visible to the requesting admin's own ViewerContext (plan §6.4 — admins are not exempt). */
            contentHidden: boolean;
            status: components["schemas"]["PlaybackSessionStatus"];
            /** Format: int64 */
            startedAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
            /** Format: int64 */
            lastHeartbeatMs: number | null;
            /** @description The session's STORED plan (the §6.3-whitelisted serialized-plan JSONB: the docs/PLAYBACK.md §5 shape as produced by the engineVersion below, possibly carrying the selection sidecar the worker's seek-restart path requires) — the admin "why is this transcoding" panel's data. Deliberately a free-form object, NOT a $ref to PlaybackPlan: stored plans are engine-versioned historical artifacts and must remain readable across engine upgrades. REDACTED like itemTitle: null when contentHidden is true (codec/resolution/bitrate choices can indirectly describe a restricted item), null only if the row predates plan storage. Additive field. */
            plan?: {
                [key: string]: unknown;
            } | null;
            /** @description ENGINE_VERSION that produced the stored plan; redacted with it. Additive field. */
            engineVersion?: string | null;
        };
        AdminSessionPage: {
            items: components["schemas"]["AdminSession"][];
            nextCursor: string | null;
        };
        /** @description GET /admin/libraries/{id}/unmatched row. Derived, never stored (U9): an enrichable-type catalog item (movie/series/artist/album) with zero provider_ids rows for it. Standard guarded-read posture (docs/PLAN.md §6.4, packages/db/src/query/guard.ts's applyGuard) — admins are NOT exempt from restricted-content gating or from needing their own library_permissions grant; an item this admin's own ViewerContext does not currently clear is simply absent from the page, the same as every other viewer-scoped catalog list in this API (unlike GET /admin/sessions' redact-in-place posture, which exists specifically to prove a restricted PLAYBACK SESSION is happening at all — there is no equivalent "something is happening" fact to preserve here). */
        UnmatchedLibraryItem: {
            /** Format: uuid */
            itemId: string;
            itemType: components["schemas"]["ItemType"];
            title: string;
            /** @description Null when the item genuinely has no known year. */
            year: number | null;
            /** @description A representative on-disk path for this item (the movie's own file, or one file discovered beneath a series/artist/album's hierarchy). Null when this item type has no resolvable file yet — never fabricated (U9). */
            filePath: string | null;
        };
        UnmatchedLibraryItemPage: {
            items: components["schemas"]["UnmatchedLibraryItem"][];
            nextCursor: string | null;
        };
        ApplyMatchRequest: {
            /** @description A metadata-provider name from the item's resolved provider chain (a built-in name, or the stable `lpp:<pluginId>` LPP adapter id — apps/worker/src/metadata/chain-resolution.ts). */
            provider: string;
            /** @description That provider's own id for the chosen candidate (ProviderRef.externalId, apps/worker/src/metadata/provider.ts). */
            externalId: string;
        };
        /**
         * @description Which input actually determined a setting's current effective value (A8 precedence order).
         * @enum {string}
         */
        SettingsValueSource: "environment" | "database" | "default";
        /**
         * @description 'ui' entries are admin-editable (PUT /admin/settings/{key}, subject to an env pin winning if present); 'env-only' entries are the bootstrap/lockout boundary (docs/PLAN.md) — always env-or-default, read-only through this API.
         * @enum {string}
         */
        SettingsScope: "ui" | "env-only";
        /** @enum {string} */
        SettingsCategory: "transcode" | "scanner" | "images" | "restricted" | "sessions" | "updateCheck" | "security" | "rateLimit" | "database" | "network" | "tls" | "paths" | "ffmpeg";
        /**
         * @description Closed set of metadata providers with an admin-manageable API key (A9).
         * @enum {string}
         */
        ProviderName: "tmdb" | "tvdb";
        /** @description One GET /admin/settings entry — the per-key EFFECTIVE value, independent of scope. */
        AdminSettingValue: {
            key: string;
            value: unknown;
            source: components["schemas"]["SettingsValueSource"];
            /** @description Whether a change to this key only takes effect at next server boot. */
            requiresRestart: boolean;
            /** @description True iff an env pin is active RIGHT NOW (A8) — `value` above is always the env value in that case, and any stored database value is preserved but inert. */
            locked: boolean;
            /** @description The environment variable currently pinning this key. Present only when `locked` is true. */
            lockedBy?: string;
        };
        AdminSettingsResponse: {
            settings: components["schemas"]["AdminSettingValue"][];
            /** @description requiresRestart:true keys whose current effective value differs from what it was at this server instance's boot (A5). Non-empty means a restart is needed for those changes to fully apply. */
            restartPendingKeys: string[];
            providerKeys: components["schemas"]["ProviderKeyStatus"][];
        };
        /** @description One GET /admin/settings/schema entry — the pure registry projection (no live value): what the admin UI's dynamic widget renderer and the generated operator/admin docs both build from. */
        AdminSettingSchemaEntry: {
            key: string;
            category: components["schemas"]["SettingsCategory"];
            description: string;
            /** @description Operator-facing caution for a setting whose misconfiguration degrades behavior but never locks the instance out. */
            caution?: string;
            scope: components["schemas"]["SettingsScope"];
            requiresRestart: boolean;
            /** @description The real environment variable this entry is pinnable by (scope 'ui') or exclusively sourced from (scope 'env-only'). */
            envVar?: string;
            default: unknown;
            /** @description The JSON Schema describing this key's value shape. The UI widget renderer's sole input for choosing a control: boolean -> toggle, number (with minimum/maximum) -> numeric input, enum -> segmented/select, string -> text input, array/object -> a structured editor. */
            valueSchema: Record<string, never>;
            /** @description Mirrors AdminSettingValue.locked for the SAME key (A8), without a second round trip to GET /admin/settings. */
            locked: boolean;
            lockedBy?: string;
        };
        AdminSettingsSchemaResponse: {
            entries: components["schemas"]["AdminSettingSchemaEntry"][];
        };
        UpdateSettingRequest: {
            value: unknown;
        };
        UpdateSettingResponse: {
            key: string;
            value: unknown;
            source: components["schemas"]["SettingsValueSource"];
            requiresRestart: boolean;
            /** @description Whether THIS key now appears in restartPendingKeys after this write — lets the UI show "restart required" inline without a second GET. */
            restartPending: boolean;
        };
        /** @description A9: the ENTIRE shape any provider-key read ever returns — never the key value itself, by construction. */
        ProviderKeyStatus: {
            provider: components["schemas"]["ProviderName"];
            set: boolean;
            /**
             * @description Null when `set` is false.
             * @enum {string|null}
             */
            source: "env" | "keyring" | null;
            /**
             * Format: int64
             * @description Present only when source is 'keyring' — an env-sourced key has no "when was it set" concept this server can observe.
             */
            lastSetMs?: number;
        };
        SetProviderKeyRequest: {
            /** @description The raw provider API key. Write-only — never returned by any endpoint. */
            key: string;
        };
        /**
         * @description One aggregate health value per plugin (LD7) — envelope reachability plus every GRANTED capability's static check.
         * @enum {string}
         */
        PluginHealthState: "unknown" | "healthy" | "unhealthy";
        /**
         * @description Why an enabled:false plugin is disabled. 'admin' — an admin turned it off. 'breaker' — 5 consecutive failed calls auto-disabled it (LD8). 'scope-change' — a manifest re-fetch found the plugin now asks for more than was approved; only reapproveAdminPlugin re-enables this one.
         * @enum {string}
         */
        PluginDisabledReason: "admin" | "breaker" | "scope-change";
        /** @description A metadata-provider capability entry, as declared by a plugin's manifest. Scope in plain language: this plugin can see the title, year, and other identifying details of items in any library it is attached to, and returns matched metadata/artwork for them — nothing else about your library or its viewers. */
        PluginMetadataProviderCapability: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "metadata-provider";
            mediaKinds: components["schemas"]["MediaKind"][];
            contentClass: components["schemas"]["ContentClass"];
        };
        /** @description An event-subscriber capability entry, as declared by a plugin's manifest. Scope in plain language: this plugin receives the activity feed events an admin selects (see eventTypeGrants) — never more than it asks for here, and never anything an admin hasn't granted. */
        PluginEventSubscriberCapability: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "event-subscriber";
            /** @description The event types this capability REQUESTS. An admin grants a possibly smaller subset — see eventTypeGrants on RegisterPluginRequest / UpdatePluginEventGrantsRequest. */
            eventTypes: string[];
            contentClass: components["schemas"]["ContentClass"];
        };
        /** @description One manifest-declared capability, discriminated by `type`. Additive (C8) — a future LPP capability type is a new union member here, never a shape change to the existing ones. */
        PluginCapability: components["schemas"]["PluginMetadataProviderCapability"] | components["schemas"]["PluginEventSubscriberCapability"];
        /** @description previewAdminPlugin's result — a validated read of the plugin's manifest for the C4 confirmation screen. Nothing is persisted by that call. */
        PluginManifestPreview: {
            name: string;
            /** @description The plugin's own version string — distinct from protocolVersion. */
            version: string;
            protocolVersion: number;
            publisher: string;
            description: string;
            capabilities: components["schemas"]["PluginCapability"][];
            /** @description The plugin's manifest configSchema verbatim (LPP §3's JSON-Schema subset) — the admin config form's sole input, auto-rendered by the same schema-driven widget renderer admin settings uses. A string field with `secret: true` is entered write-only and stored in the keyring, never echoed back. */
            configSchema: unknown;
            /** @description Union of every event-subscriber capability's requested eventTypes (empty if the manifest declares none). */
            requestedEventTypes: string[];
            /** @description C-2 fix wave (adversarial-review): a sha256 hex digest of the EXACT manifest content this preview validated. The client MUST round-trip this value back as `manifestDigest` on registerAdminPlugin / reapproveAdminPlugin — the server re-fetches the manifest at that point (as it always did) and 409s if the fresh fetch's digest no longer matches, closing the TOCTOU where a plugin could serve a broader/differently-scoped manifest to the registration call than the one this preview actually showed the admin. */
            manifestDigest: string;
        };
        PreviewPluginRequest: {
            /**
             * Format: uri
             * @description The plugin's base HTTP(S) origin — GET <url>/lpp/manifest is fetched.
             */
            url: string;
            /** @description Explicit LAN hostnames/IPs to permit for this preview fetch even if they land in a private/loopback address range (LD5). */
            lanAllowlist?: string[];
        };
        PluginEventGrant: {
            eventType: string;
            /** Format: int64 */
            grantedAtMs: number;
        };
        /** @description A registered LPP plugin's admin-facing state (migrations/0014_plugins.sql). Never carries the HMAC secret or any config secret value (LD1/LD9) — those exist only in the keyring and are returned exactly once, by registerAdminPlugin / rotateAdminPluginHmac. */
        AdminPlugin: {
            /** Format: uuid */
            id: string;
            name: string;
            baseUrl: string;
            version: string;
            protocolVersion: number;
            enabled: boolean;
            contentClass: components["schemas"]["ContentClass"];
            /** @description Subset of the manifest's declared capability `type` values this plugin is approved to use (LD6 "capability set <= declared"). */
            grantedCapabilityTypes: string[];
            healthState: components["schemas"]["PluginHealthState"];
            consecutiveFailures: number;
            /** Format: int64 */
            lastHealthCheckMs: number | null;
            /** Format: int64 */
            lastOkMs: number | null;
            disabledReason: components["schemas"]["PluginDisabledReason"] | null;
            /** @description Explicit hostnames/IPs this plugin may target even in a private/loopback address range (LD5) — an admin opts a plugin into a specific address, never a subnet. */
            lanAllowlist: string[];
            /** @description Verbatim last-fetched manifest snapshot (opaque) — the admin UI derives its capability/config display from this. */
            manifest: unknown;
            /** @description Non-secret configSchema field values only — secret fields are never included here (LD1); manifest.configSchema's `secret:true` flags tell the UI which field names are keyring-only. */
            config: unknown;
            eventGrants: components["schemas"]["PluginEventGrant"][];
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            updatedAtMs: number;
            /** Format: int64 */
            approvedAtMs: number;
            /** @description plugins.pseudonymize_actor_ids (migrations/0016_plugin_delivery_cursors.sql) — default true. updateAdminPluginPseudonymization is the only way to change it; every other AdminPlugin-returning route reports its current stored value unchanged. */
            pseudonymizeActorIds?: boolean;
            /** @description Outbox delivery-loop stats for this plugin's event-subscriber capability (migrations/0016_plugin_delivery_cursors.sql via packages/db's getDeliveryCursor) — null when this plugin has never been through the delivery loop (no event-subscriber grant, or granted but zero delivery attempts yet). */
            deliveryStatus?: components["schemas"]["PluginDeliveryStatus"] | null;
        };
        /** @description One plugin_delivery_cursors row, admin-facing. `lastAttemptMs`/ `lastSuccessMs` are separate fields (migration column comment) so a plugin that is failing every attempt is distinguishable from one with nothing new to deliver: `now - lastSuccessMs` grows while `lastAttemptMs` keeps advancing. */
        PluginDeliveryStatus: {
            /**
             * Format: int64
             * @description Epoch ms of the most recent delivery attempt, success or failure. Null if never attempted.
             */
            lastAttemptMs: number | null;
            /**
             * Format: int64
             * @description Epoch ms of the most recent 2xx-acknowledged batch. Does NOT advance on failure.
             */
            lastSuccessMs: number | null;
            /** @description Non-2xx delivery outcomes since the last success, reset to 0 on every success. Drives the delivery loop's backoff pacing — DELIBERATELY SEPARATE from AdminPlugin.consecutiveFailures (the durable cross-capability breaker-trip counter). */
            consecutiveFailures: number;
            /**
             * Format: int64
             * @description Lifetime count of 2xx-acknowledged batches. Monotonic, never reset.
             */
            deliveredBatches: number;
            /**
             * Format: int64
             * @description Lifetime count of individual events acknowledged (sum of every acknowledged batch's event count). Monotonic, never reset. Always >= deliveredBatches.
             */
            deliveredEvents: number;
            /**
             * Format: int64
             * @description High-water mark through which a retention-window gap has already been reported to this plugin. Null if no gap has ever been reported.
             */
            gapReportedThroughMs: number | null;
        };
        UpdatePluginPseudonymizationRequest: {
            /** @description The new plugins.pseudonymize_actor_ids posture — true (default) sends per-(plugin,user) anonymous ids, false sends real account ids. */
            enabled: boolean;
        };
        /** @description listAdminPlugins' result. Deliberately NOT cursor-paginated — see that operation's description. */
        AdminPluginList: {
            items: components["schemas"]["AdminPlugin"][];
        };
        RegisterPluginRequest: {
            /** Format: uri */
            url: string;
            /** @description Subset of the manifest's declared capability `type` values to enable (LD6 "capability set <= declared"). */
            grantedCapabilityTypes: string[];
            /** @description Subset of the union of every event-subscriber capability's requested eventTypes to grant (LD6 "event grants <= requested"). */
            eventTypeGrants: string[];
            /** @description Raw submitted values keyed by configSchema property name — both secret and non-secret fields together (split server-side; secret values are never echoed back). */
            config: unknown;
            /** @description Explicit LAN hostnames/IPs to permit for this plugin (LD5). Defaults to none. */
            lanAllowlist?: string[];
            /** @description C-2 fix wave: the `manifestDigest` a prior previewAdminPlugin call returned for this exact plugin. Schema-optional (kept additive), but ENFORCED as required server-side — omitting it is a 422 ("preview this plugin first"), and a value that no longer matches a fresh re-fetch is a 409 (the manifest changed since it was previewed). */
            manifestDigest?: string;
        };
        /** @description hmacSecret is returned EXACTLY ONCE — it is never retrievable again through any endpoint (LD1). The admin UI must surface it immediately with a copy affordance and a "this will not be shown again" notice. */
        RegisterPluginResponse: {
            plugin: components["schemas"]["AdminPlugin"];
            hmacSecret: string;
        };
        UpdatePluginConfigRequest: {
            /** @description Full replacement set of raw submitted configSchema values (secret + non-secret together, split server-side). */
            config: unknown;
        };
        UpdatePluginEventGrantsRequest: {
            /** @description Full replacement grant set — every value must be a member of the currently-stored manifest's requested eventTypes for the granted event-subscriber capability. */
            eventTypeGrants: string[];
        };
        ReapprovePluginRequest: {
            /** @description Subset of the freshly re-fetched manifest's declared capability `type` values to enable, exactly like registration. */
            grantedCapabilityTypes: string[];
            eventTypeGrants: string[];
            /** @description C-2 fix wave — see RegisterPluginRequest.manifestDigest's description; the identical pin/409 rule applies to the re-approval flow's own preview. */
            manifestDigest?: string;
        };
        RefreshPluginResponse: {
            plugin: components["schemas"]["AdminPlugin"];
            /** @description True iff the re-fetched manifest expanded scope beyond what was previously approved — the plugin was just auto-disabled (disabledReason 'scope-change') and needs reapproveAdminPlugin. */
            expanded: boolean;
            /** @description Human-readable reasons for the expansion (empty iff !expanded). */
            reasons: string[];
        };
        /** @description The new HMAC is returned EXACTLY ONCE, exactly like registerAdminPlugin's hmacSecret — never retrievable again afterward. */
        RotatePluginHmacResponse: {
            hmacSecret: string;
        };
        /**
         * @description migrations/0015_library_provider_chains.sql's library_provider_kind enum.
         * @enum {string}
         */
        LibraryProviderKind: "builtin" | "plugin";
        /** @description One chain slot on putAdminLibraryProviderChain — XOR-shaped exactly like packages/db's LibraryProviderChainEntryInput: `builtinName` required and ONLY legal when providerKind='builtin'; `pluginId` required and ONLY legal when providerKind='plugin'. `position` is NOT supplied — the array index at request time. */
        LibraryProviderChainEntryInput: {
            providerKind: components["schemas"]["LibraryProviderKind"];
            builtinName?: string;
            /** Format: uuid */
            pluginId?: string;
        };
        /** @description Resolved display data for a plugin referenced by a chain entry or offered as an eligible choice. */
        AdminLibraryProviderChainPluginRef: {
            /** Format: uuid */
            id: string;
            name: string;
            enabled: boolean;
            healthState: components["schemas"]["PluginHealthState"];
            contentClass: components["schemas"]["ContentClass"];
        };
        /** @description One resolved slot, read time — a library_provider_entries row (or, when isDefault, a synthesized legacy-default slot) plus resolved plugin display data. */
        AdminLibraryProviderChainEntry: {
            position: number;
            providerKind: components["schemas"]["LibraryProviderKind"];
            builtinName: string | null;
            /** Format: uuid */
            pluginId: string | null;
            /** @description Resolved display data for a providerKind='plugin' entry — always null for a providerKind='builtin' entry. */
            plugin: components["schemas"]["AdminLibraryProviderChainPluginRef"] | null;
        };
        /** @description getAdminLibraryProviderChain / putAdminLibraryProviderChain's shared response shape — see either operation's description for isDefault/eligiblePlugins semantics. */
        AdminLibraryProviderChain: {
            /** Format: uuid */
            libraryId: string;
            /** @description True iff this library has zero library_provider_entries rows — `entries` then shows the legacy default chain, read-only. */
            isDefault: boolean;
            entries: components["schemas"]["AdminLibraryProviderChainEntry"][];
            /** @description Every registered plugin whose contentClass strictly equals this library's contentClass (LPP C5 STRICT) — the add-entry picker's plugin choices. */
            eligiblePlugins: components["schemas"]["AdminLibraryProviderChainPluginRef"][];
            /** @description Known built-in provider names (apps/worker/src/metadata/registry.ts) — always eligible for any library regardless of contentClass. */
            builtinProviderNames: string[];
        };
        PutAdminLibraryProviderChainRequest: {
            entries: components["schemas"]["LibraryProviderChainEntryInput"][];
        };
    };
    responses: {
        /** @description Unexpected error */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Missing or invalid access token */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Authenticated but not permitted */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Resource not found (or not visible under the caller's ViewerContext) */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Request failed schema/business-rule validation */
        UnprocessableEntity: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
        Cursor: string;
        Limit: number;
        IdPathParam: string;
        LibraryIdFilter: string;
        /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
        Sort: "title" | "added" | "rating" | "year";
        Order: "asc" | "desc";
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getSetupState: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Setup state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupState"];
                };
            };
            /** @description Rate limited (unauthenticated surface) */
            429: {
                headers: {
                    /** @description Seconds until the next attempt is allowed. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["Problem"];
        };
    };
    createFirstAdmin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FirstAdminRequest"];
            };
        };
        responses: {
            /** @description First admin created; wizard continues authenticated */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FirstAdminResponse"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    authLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Authenticated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenPair"];
                };
            };
            401: components["responses"]["Unauthorized"];
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-IP login attempts) */
            429: {
                headers: {
                    /** @description Seconds until the next attempt is allowed. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    authRefresh: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefreshRequest"];
            };
        };
        responses: {
            /** @description Rotated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenPair"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description Rate limited (per-IP refresh attempts) */
            429: {
                headers: {
                    /** @description Seconds until the next attempt is allowed. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    authLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["LogoutRequest"];
            };
        };
        responses: {
            /** @description Logged out */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    listDevices: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of devices */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DevicePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Device */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Device"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    revokeDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getSystemCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Capabilities this server build supports */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Capabilities"];
                };
            };
            /** @description Rate limited */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getSystemInfo: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description System info */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemInfo"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getSystemUpdate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Update check result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemUpdateInfo"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    listUsers: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of users */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    createUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUserRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description User */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    deleteUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    updateUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateUserRequest"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    updateMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMeRequest"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getMySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserSettings"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    putMySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserSettings"];
            };
        };
        responses: {
            /** @description Replaced */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserSettings"];
                };
            };
            401: components["responses"]["Unauthorized"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    putMyRestrictedSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RestrictedSettingsUpdate"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedSettings"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listLibraries: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of libraries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    createLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateLibraryRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Library"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Library */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Library"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    deleteLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    updateLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateLibraryRequest"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Library"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    scanLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ScanLibraryRequest"];
            };
        };
        responses: {
            /** @description Scan job enqueued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobRef"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getLibraryPermissions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Permission set */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryPermissionSet"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    putLibraryPermissions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryPermissionSet"];
            };
        };
        responses: {
            /** @description Replaced */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryPermissionSet"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listMovies: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                libraryId?: components["parameters"]["LibraryIdFilter"];
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
                sort?: components["parameters"]["Sort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of movies */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MoviePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getMovie: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Movie */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Movie"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listSeries: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                libraryId?: components["parameters"]["LibraryIdFilter"];
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
                sort?: components["parameters"]["Sort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of series */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeriesPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getSeries: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Series */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Series"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listSeriesSeasons: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of seasons */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeasonPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listSeasonEpisodes: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of episodes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EpisodePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getEpisode: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Episode */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Episode"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listArtists: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                libraryId?: components["parameters"]["LibraryIdFilter"];
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
                sort?: components["parameters"]["Sort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of artists */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArtistPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getArtist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Artist */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Artist"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listArtistAlbums: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
                sort?: components["parameters"]["Sort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of albums */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AlbumPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getAlbum: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Album */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Album"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listAlbumTracks: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/rating/year: desc) unless `order` is explicitly supplied. A cursor from a previous page is only valid for the SAME sort+order pair it was issued under. */
                sort?: components["parameters"]["Sort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of tracks */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TrackPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getTrack: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Track */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Track"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listPeople: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description Case-insensitive substring match on name. */
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of people */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PersonPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getPerson: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Person */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Person"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listPersonItems: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of this person's visible credits */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PersonItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listTags: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                kind?: components["schemas"]["ItemTagKind"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of tags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    search: {
        parameters: {
            query: {
                q: string;
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of search results */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchResultPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getContinueWatching: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of continue-watching entries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContinueWatchingPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getRecentlyAdded: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of recently-added entries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecentlyAddedPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getImage: {
        parameters: {
            query?: {
                /** @description Nearest pre-scaled variant is served; ingest-time only, never computed on request (Tier-0 rule). */
                width?: number;
                format?: components["schemas"]["ImageFormat"];
            };
            header?: never;
            path: {
                entityType: components["schemas"]["ImageEntityType"];
                id: components["parameters"]["IdPathParam"];
                kind: components["schemas"]["ImageKind"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Image bytes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                    "image/avif": string;
                    "image/jpeg": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    computePlaybackPlan: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanRequest"];
            };
        };
        responses: {
            /** @description The full PlaybackPlan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaybackPlan"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    createPlaybackSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanRequest"];
            };
        };
        responses: {
            /** @description Session created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaybackSession"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description The computed PlaybackPlan is genuinely unplayable — `decision === 'transcode'` but `ffmpegArgs` is empty (tone-map refused by policy, or an empty/degenerate ladder). The problem body's `reasons` extension member carries the plan's own (real, not hypothetical) `PlanReason[]`. A session for playable-via-transcode media succeeds (201) — this response is reserved for media no strategy can play. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            /** @description Transcode slots exhausted (`maxSimultaneousTranscodes` semaphore) — the global count of active-ish transcode sessions (any non-direct-play decision, any non-terminal status) already meets or exceeds the resolved policy's cap. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackHlsManifest: {
        parameters: {
            query?: {
                /** @description Access JWT fallback for media elements that cannot send Authorization headers. */
                token?: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description HLS media playlist (Cache-Control private, no-store) */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/vnd.apple.mpegurl": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description Initial segment not yet produced within the 8s poll window; client should retry (Retry-After header set) */
            503: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackHlsFile: {
        parameters: {
            query?: {
                /** @description Access JWT fallback for media elements that cannot send Authorization headers. */
                token?: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
                /** @description `runN/sNNNNNN.m4s`, `runN/sNNNNNN.ts`, or `runN/init.mp4` (fmp4 init segment) — the transcoder's per-run layout. Strictly pattern-validated; anything else is rejected (traversal-safe by construction — a client-supplied path is never trusted). */
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Segment or init-segment bytes (Cache-Control private, immutable) */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    "Content-Type"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description The requested segment is outside the produced window; a seek restart has been requested. Client should retry (Retry-After header set). */
            503: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackSubtitleManifest: {
        parameters: {
            query?: {
                /** @description Access JWT fallback for media elements that cannot send Authorization headers. */
                token?: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description HLS subtitle media playlist (Cache-Control private, no-store) */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/vnd.apple.mpegurl": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description Not yet extracted; client should retry (Retry-After header set). */
            503: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackSubtitleFile: {
        parameters: {
            query?: {
                /** @description Access JWT fallback for media elements that cannot send Authorization headers. */
                token?: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
                /** @description Always `sub0.vtt` (single-segment side-track) — strictly pattern-validated. */
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description WebVTT bytes (Cache-Control private, immutable) */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    "Content-Type"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/vtt": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaybackSession"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    endPlaybackSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ended */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getPlaybackSessionFile: {
        parameters: {
            query?: {
                /** @description Access JWT fallback for media elements that cannot send Authorization headers. */
                token?: string;
            };
            header?: {
                /** @description Single-range only, e.g. `bytes=0-1023` or `bytes=1024-`. */
                Range?: string;
                "If-Range"?: string;
            };
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Full file (no/ignored Range) */
            200: {
                headers: {
                    "Accept-Ranges"?: string;
                    "Content-Type"?: string;
                    "Content-Length"?: number;
                    ETag?: string;
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Single-range partial content */
            206: {
                headers: {
                    "Content-Range"?: string;
                    "Content-Length"?: number;
                    ETag?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description Malformed or unsatisfiable Range */
            416: {
                headers: {
                    "Content-Range"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getProgress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current user's progress for this item */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Progress"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    putProgress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProgressUpdate"];
            };
        };
        responses: {
            /** @description Upserted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Progress"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listProgress: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of progress records */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProgressPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    listWatchlist: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of the caller's watchlist */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchlistPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    addToWatchlist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Added (or already present) */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    removeFromWatchlist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed (or was already absent) */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    unlockRestricted: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UnlockRequest"];
            };
        };
        responses: {
            /** @description Unlocked */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UnlockResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-user PIN attempts) */
            429: {
                headers: {
                    /** @description Seconds until the next attempt is allowed. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    lockRestricted: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Locked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    getRestrictedCount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Zone aggregate count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedCount"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listRestrictedZoneItems: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of restricted zone items */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedZoneItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    exportData: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Streamed JSON archive */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportArchive"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Problem"];
        };
    };
    importData: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExportArchive"];
            };
        };
        responses: {
            /** @description Import job enqueued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobRef"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listJobs: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of jobs */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Job"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listAdminSessions: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of active admin session rows */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSessionPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current verified capabilities (or null before first probe) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CapabilityReportEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    listCrashFiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Crash file metadata, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CrashFileList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getCrashFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Crash file basename exactly as returned by listCrashFiles. The strict pattern (no separators, no leading dot) makes path traversal structurally impossible — same posture as the HLS file-serving routes. */
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redacted crash file content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminLogsTail: {
        parameters: {
            query?: {
                lines?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Log tail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LogTail"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    browseDirectories: {
        parameters: {
            query?: {
                /** @description Absolute path whose immediate subdirectories to list. Must be absolute — a relative path is rejected rather than resolved against the server's working directory, which would be an unpredictable base an operator cannot see. */
                path?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The directory's immediate subdirectories */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DirectoryListing"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Effective settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSettingsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminSettingsSchema: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Registry projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSettingsSchemaResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    updateAdminSetting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description A scope:'ui' registry key exactly as listed by GET /admin/settings/schema (e.g. "transcode.maxSimultaneousTranscodes"). Dotted category.entryName form, matching every entry in packages/shared/src/settings-registry.ts. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateSettingRequest"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateSettingResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description The key is currently pinned by its environment variable (A8) — env always wins; the submitted value cannot take effect while the pin is active, regardless of whether it would otherwise be valid on its own. The DB value underneath, if any, is preserved but left inert. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    setAdminProviderKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: components["schemas"]["ProviderName"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetProviderKeyRequest"];
            };
        };
        responses: {
            /** @description Key stored */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    clearAdminProviderKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: components["schemas"]["ProviderName"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Key cleared */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    previewAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreviewPluginRequest"];
            };
        };
        responses: {
            /** @description Validated manifest summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PluginManifestPreview"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listAdminPlugins: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Registered plugins */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPluginList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    registerAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterPluginRequest"];
            };
        };
        responses: {
            /** @description Plugin registered */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisterPluginResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description A plugin is already registered at this baseUrl */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    removeAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Plugin removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    updateAdminPluginConfig: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePluginConfigRequest"];
            };
        };
        responses: {
            /** @description Updated plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    updateAdminPluginEventGrants: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePluginEventGrantsRequest"];
            };
        };
        responses: {
            /** @description Updated plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description This plugin's event-subscriber capability is not currently granted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    updateAdminPluginPseudonymization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePluginPseudonymizationRequest"];
            };
        };
        responses: {
            /** @description Updated plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description This plugin's event-subscriber capability is not currently granted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    enableAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Updated plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description This plugin is disabled for a scope change and requires reapproveAdminPlugin */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    disableAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Updated plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    refreshAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refresh result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshPluginResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    reapproveAdminPlugin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReapprovePluginRequest"];
            };
        };
        responses: {
            /** @description Re-approved plugin */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminPlugin"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description This plugin is not currently awaiting scope-change re-approval */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    rotateAdminPluginHmac: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The new HMAC secret */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RotatePluginHmacResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminLibraryProviderChain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The library's provider chain */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminLibraryProviderChain"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    putAdminLibraryProviderChain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutAdminLibraryProviderChainRequest"];
            };
        };
        responses: {
            /** @description The library's replaced provider chain */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminLibraryProviderChain"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listUnmatchedLibraryItems: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of unmatched items */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UnmatchedLibraryItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    searchItemMatchCandidates: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Candidate-search job enqueued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobRef"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    applyItemMatch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApplyMatchRequest"];
            };
        };
        responses: {
            /** @description Apply-match job enqueued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobRef"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
}
