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
    "/invites/claim/{token}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The raw one-time invite token (never the hash). */
                token: string;
            };
            cookie?: never;
        };
        /**
         * Resolve an invite token's presets, without claiming it
         * @description Public (M12). Invalid, expired, already-claimed, or revoked tokens all resolve to a 404 BYTE-IDENTICAL to an unknown route's 404 (the same "invisible == nonexistent" posture as POST /setup/first-admin once configured) — the four cases are deliberately indistinguishable from the outside.
         */
        get: operations["getClaimState"];
        put?: never;
        /**
         * Claim an invite, creating an account and signing in
         * @description Public (M12). Same byte-identical-404 posture as getClaimState for an invalid/expired/claimed/revoked token — a username collision against an OTHERWISE valid token is a distinct 422 (the token itself was fine). Auto-logs in on success (M13): the response is a real TokenPair, same composition as POST /setup/first-admin's own token minting, additively carrying `emailApplied` (LD-13c — see TokenPair's own property description).
         */
        post: operations["claimInvite"];
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
    "/auth/forgot-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a self-service password-reset email (E3b)
         * @description PUBLIC, unauthenticated, and deliberately unenumerable: the response is the SAME 202 with the SAME body whether or not `identifier` resolves to a real account, whether or not that account has an email on file, and whether or not mail is configured on this instance — a caller can never distinguish any of those cases from the response alone. When `identifier` does resolve to a real account with an email on file, a single-use, 30-minute reset token is minted (invalidating that account's previously-issued unused tokens) and a `password-reset` mail is dispatched through the mail seam (`MailDispatchService.trySend`, non-fatal — a dead/unconfigured mail system never changes this response). Rate-limited per `rateLimit.passwordReset` (shared with `authResetPassword`).
         */
        post: operations["authForgotPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete a self-service password reset with a mailed token (E3b)
         * @description PUBLIC, unauthenticated. Atomically consumes `token` (single-use; a concurrent second consume of the same token loses the race) and, on success, sets `password`, revokes every refresh token the account holds, and clears `mustChangePassword` if it was set — one transaction. An invalid, expired, already-used, or well-formed-but- unknown token all produce the IDENTICAL 404 this operation shares with an unknown route (bare, no `detail`/`instance` — M12/E8: none of those cases may be distinguishable from one another or from a malformed request to a nonexistent path). Rate-limited per `rateLimit.passwordReset` (shared with `authForgotPassword`).
         */
        post: operations["authResetPassword"];
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
    "/system/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin-only graceful server restart
         * @description Gracefully restarts the server process. The 202 is flushed to the socket BEFORE teardown begins (same ordering contract as the controller-IPC stop), then the server runs its normal graceful shutdown (HTTP close, embedded-PostgreSQL stop) and exits with the documented restart exit code so the platform supervisor (launchd / systemd / Windows SCM recovery / Docker restart policy) starts it again — typically within 5–15 seconds. Settings marked `requiresRestart` take effect on the restarted process. Only the server process restarts; the worker and web services are untouched. In an unsupervised context (bare `node`, dev harness) the process simply exits and nothing restarts it — deployment docs state this.
         */
        post: operations["restartServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/shutdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin-only graceful server shutdown
         * @description Gracefully stops the server process — the same in-band self-stop the desktop controllers' "Stop server" performs. The 202 is flushed before teardown begins; the process then exits cleanly (exit 0), which every shipped service supervisor except Docker treats as "stay stopped" (launchd `SuccessfulExit=false`, systemd `Restart=on-failure`, the Windows service host's clean-child-exit stop). The server stays down until started out-of-band (menubar/tray controller, launchctl/systemctl/SCM, or reboot — the services are boot-started). Only the server stops; worker and web services keep running. Under a container supervisor whose restart policy ignores exit codes (the shipped Docker compose file's `unless-stopped`), an in-process exit CANNOT keep the container down, so the request is refused with 409 instead of pretending.
         */
        post: operations["shutdownServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/notices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List notice history, newest first (admin)
         * @description Every notice ever published, cursor-paginated newest-first — including cancelled and naturally-expired ones (an audit history, not just the currently-active notice; use GET /notices/active for that). Each row's `status` is derived at read time, never stored.
         */
        get: operations["listSystemNotices"];
        put?: never;
        /**
         * Publish a system notice, replacing any currently-active one (admin)
         * @description Publishing supersedes any active notice — v1 holds exactly ONE active notice at a time (a notice channel that stacks becomes noise), so this call cancels whichever notice is currently active and inserts the new one in the same transaction. The request carries RELATIVE durations (`effectiveInMs`/`expiresInMs`); the server anchors both to its own clock and returns absolute `effectiveAtMs`/`expiresAtMs`, eliminating compose-time clock skew by construction. Severity governs expiry defaults: `info` defaults to a 1-hour expiry when `expiresInMs` is omitted; `warning` REQUIRES `expiresInMs` (422 when absent — a maintenance banner must not linger forever by accident); `critical` may omit `expiresInMs` entirely, meaning "until cancelled". Delivered live over the events socket (`notice.published`, all-user broadcast) and via GET /notices/active for anyone who connects after publication.
         */
        post: operations["publishSystemNotice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/system/notices/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a notice (admin) */
        post: operations["cancelSystemNotice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notices/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The currently-active notice, if any (any authenticated user)
         * @description NOT admin-only — every authenticated user calls this, on auth boot and on every websocket reconnect (the catch-up read for anyone who was not connected at publish time; live delivery alone only reaches sockets connected at that moment). `serverNowMs` is the clock anchor a client renders any countdown against (`effectiveAtMs - (Date.now() + (serverNowMs - Date.now()))`), never the client's own wall clock alone.
         */
        get: operations["getActiveSystemNotice"];
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
    "/users/{id}/reset-password": {
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
         * Admin/CLI password recovery, tier (a) (E3a/M14)
         * @description Generates a random temporary password, argon2id-hashes and stores it, sets `mustChangePassword` on the target user, and revokes EVERY refresh token they hold (every existing session ends). The temporary password is returned ONCE in this response and is never retrievable again — the server keeps only its hash. Self-reset (an admin resetting their own account) is permitted — they know the consequence — but requires `currentPassword` (R-F3, opus adversarial review fix wave: a bearer token alone must never mint a permanent account takeover, same F1 reasoning as `PATCH /users/me`/`PUT /users/me/restricted`). Resetting ANOTHER user's password needs no `currentPassword` — that path is already live-admin-verified and audited. When the mail tier is active and the target user has an email on file, a non-fatal `security-notice` mail is also dispatched. The CLI twin of this action, `loombre admin reset-password <username>`, performs the identical semantics with `actor: "cli"` instead of `actor: "admin"` on the resulting `user.password-reset` event.
         */
        post: operations["adminResetUserPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
        /**
         * Update the current user's own profile
         * @description G3 (STATE.md "Current-password re-auth on self-changes"): a body containing `password` and/or `email` (any value, `null` included) requires `currentPassword` — see UpdateMeRequest's own `dependentRequired`. A missing/wrong currentPassword when required 403s/422s; a bodyless or displayName/birthDate-only body needs no re-auth.
         */
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
    "/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List invites (admin) */
        get: operations["listInvites"];
        put?: never;
        /**
         * Create a one-time, expiring invite link (admin)
         * @description Rejects 422 on any restricted-class or unknown library id (M4) — invites can never grant restricted-library access or admin role (no such field exists on this request at all). The raw claim token is returned exactly once, in this response only.
         */
        post: operations["createInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invites/{id}": {
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
        post?: never;
        /**
         * Revoke a pending invite (admin)
         * @description 404 when the invite is unknown, already revoked, or already claimed — nothing left to revoke.
         */
        delete: operations["revokeInvite"];
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
    "/items/{id}/chapters": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Chapter markers for an item's timeline
         * @description Generic and content-agnostic (`chapter_markers`, migrations/0019 — item_type 'movie' rows today, i.e. Stash scene markers, S7/K9; the schema does not restrict this to any one item type). Visibility rides the owning item: byte-identical 401/404 to what a direct GET on the item itself would return for the same viewer, including for a restricted item to an uncleared viewer (house pattern — see GET /movies/{id}). An item with zero chapter markers returns 200 with an empty `items` array, never a 404 — "no chapters" and "item not visible" are deliberately distinguishable states. Ordered by `startMs` ascending. GET /restricted/scenes/{id} embeds the SAME rows inline as `chapters` for the zone's own scene-detail page; this operation is the generic twin the player itself consumes (works for any item id, not only zone scenes).
         */
        get: operations["getItemChapters"];
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
         * DEPRECATED — superseded by GET /restricted/browse (STATE.md Stash run, K4). Kept per the additive-only evolution policy (removed operations are deprecated for two minor releases minimum, never hard-deleted mid-major).
         * @deprecated
         * @description Same 404-for-not-entitled / empty-while-locked posture as GET /restricted/browse, which this now thinly delegates to (unsorted- filter, `added`-sorted, server-side) — kept working, not stubbed, for the deprecation window. New clients should call GET /restricted/browse directly; this operation carries a `Sunset` response header and will be removed after that window closes.
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
    "/restricted/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Restricted zone home rails (continue watching, recently added, studios, performers)
         * @description 404 for a viewer with NO restricted-library entitlement at all — same posture as every other zone read (GET /restricted/count). For an entitled-but-LOCKED viewer (gate 5 not currently passed) ALL FOUR rails come back empty — continueWatchingInZone, recentlyAddedInZone, studios and performers alike — guard-consistent with GET /restricted/browse. The zone's U10 aggregate disclosure (that a zone exists, and how many items are in it) is made by GET /restricted/count and by that endpoint ALONE; a locked viewer never learns a studio or performer NAME from this endpoint, because a studio/performer roster is zone content, not an aggregate. (R1 review lane: this paragraph previously said studios/performers "still resolve" while locked — the implementation has always returned them empty, and empty is the correct, safer reading of docs/PLAN.md §6.4. Corrected here so nobody "conforms" the code to the description and opens the leak. Pinned by packages/db/test/leak.spec.ts 12f/12h and the HTTP twin in apps/server/test/libraries.e2e.spec.ts.)
         */
        get: operations["getRestrictedHome"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/browse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Keyset browse of the restricted zone with combinable filters
         * @description SUPERSEDES the old full-fetch GET /restricted/items design (STATE.md K4): real guarded server-side keyset pagination, proven at 33k-scene scale (S10) rather than the client fetching the whole zone and filtering locally. 404 for a viewer with NO restricted-library entitlement at all; an entitled-but-locked viewer gets 200 with an EMPTY page (gate 5 — same posture the old endpoint documented). A malformed performerIds/studioTagIds/tagIds uuid entry answers with an EMPTY page, never a dropped filter (house rule — packages/db/src/ query/catalog-detail.ts's own convention for list filters).
         */
        get: operations["listRestrictedBrowse"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/scenes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Restricted-zone scene detail
         * @description Byte-identical 404 to an uncleared viewer, a nonexistent id, and a general-catalog id (house pattern — see GET /movies/{id}). Markers are embedded here (chapter_markers rows for this item) — GET /items/{id}/chapters (Lane E) is the generic, content-agnostic twin the player itself consumes.
         */
        get: operations["getRestrictedScene"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/performers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List performers (role=performer people) visible within the zone
         * @description 404 for a viewer with NO restricted-library entitlement at all. An entitled-but-locked viewer gets 200 with an EMPTY page (same gate-5 posture as GET /restricted/browse).
         */
        get: operations["listRestrictedPerformers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/performers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Restricted-zone performer detail
         * @description Byte-identical 404 to an uncleared viewer, a nonexistent id, and a performer with zero scenes currently visible within the zone.
         */
        get: operations["getRestrictedPerformer"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/performers/{id}/scenes": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** A performer's filmography within the restricted zone */
        get: operations["listRestrictedPerformerScenes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/studios": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List studios (kind=studio tags) visible within the zone
         * @description 404 for a viewer with NO restricted-library entitlement at all. An entitled-but-locked viewer gets 200 with an EMPTY page (same gate-5 posture as GET /restricted/browse).
         */
        get: operations["listRestrictedStudios"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/studios/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Restricted-zone studio detail
         * @description Byte-identical 404 to an uncleared viewer, a nonexistent id, and a studio with zero scenes currently visible within the zone. Catalog (a studio's scenes) is reached via GET /restricted/browse's `studioTagIds` filter, not a dedicated sub-route.
         */
        get: operations["getRestrictedStudio"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/restricted/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Restricted-zone-scoped search (title, performer, studio, tag)
         * @description A SEPARATE guarded index from GET /search — zone titles must never surface through the general search surface, not even as a count/ timing side-channel, and vice versa (design/phosphor README "Restricted content"). Entitlement is checked BEFORE `q` — a viewer with NO restricted-library entitlement at all gets 404 regardless of whether `q` was supplied; an entitled viewer missing `q` then gets 422, matching GET /search's own validation. An entitled-but-locked viewer gets 200 with an EMPTY page.
         */
        get: operations["restrictedSearch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/stash-connection": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Read a library's Stash SQLite connection config (admin)
         * @description `configured: false` (sqlitePath null, status never_connected) when no connection has ever been saved for this library — GET never 404s for an otherwise-valid library id just because Stash hasn't been configured yet (mirrors GET /admin/libraries/{id}/provider-chain's `isDefault` precedent).
         */
        get: operations["getAdminLibraryStashConnection"];
        /**
         * Configure (or reconfigure) a library's Stash SQLite connection (admin)
         * @description Writes sqlitePath/enabled, plus genreTagNames (K15 — see PutAdminStashConnectionRequest.genreTagNames for its omit/null/ array tri-state). Enqueues a `stash-inventory` job on every successful save so the path-mapping preview has fresh data without a separate button. 404 if the library itself does not exist (checked before body validation).
         */
        put: operations["putAdminLibraryStashConnection"];
        post?: never;
        /**
         * Forget a library's Stash SQLite connection entirely (admin)
         * @description Stash OPEN ledger item 6 ("forget this connection entirely" — the prior surface was disable-only via PUT enabled:false). Deletes the library_stash_connections row (sqlite_path, enabled, status, and every other connection-config/outcome column) — there is no keyring-held secret to clear alongside it (S1: Stash is a first-party read-only SQLite-file provider, never an HTTP API with a credential). NEVER destructive to catalog content: previously synced metadata, matched catalog items, and stash_scene_links rows are untouched (S8's staleness law — synced facts are KEPT, never deleted, even when their source connection itself is forgotten), as are this library's stash-path-mappings (a future re-attach does not require re-entering them). A pending/scheduled sync is not separately cancelled: the periodic schedule loop and any in-flight `stash-sync` job both re-resolve the connection row fresh and treat its absence as an ordinary "unreachable" outcome (ends the job with a failed report; the schedule loop simply stops picking this library as due) — no zombie schedule, no code needed to reach into the job queue. 404s both when the library itself does not exist and when the library exists but has no Stash connection configured (nothing to forget). Emits `stash.provider.disconnected` (admin-only) in the same transaction as the delete.
         */
        delete: operations["deleteAdminLibraryStashConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/stash-path-mappings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /** Read a library's Stash path-mapping table (admin) */
        get: operations["getAdminLibraryStashPathMappings"];
        /**
         * Replace a library's Stash path-mapping table wholesale (admin)
         * @description `mappings` is the FULL replacement list — `position` is the array index, not supplied explicitly. An empty array clears every mapping (S4's oshash tier becomes the only match path). 404 if the library itself does not exist (checked before body validation).
         */
        put: operations["putAdminLibraryStashPathMappings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/stash-path-mappings/preview": {
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
         * Preview match counts for a CANDIDATE (unsaved) mapping set (admin)
         * @description Pure SQL over the last inventory/sync snapshot's stored Stash paths (K10) — never opens the Stash SQLite file itself, so this works as soon as one `stash-inventory` job has run. Reflects `mappings` AS SUBMITTED, not what is currently saved, so an admin can try a mapping before committing it via PUT. 404 if the library itself does not exist (checked before body validation).
         */
        post: operations["previewAdminLibraryStashPathMappings"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/libraries/{id}/stash-sync": {
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
         * Enqueue a full or incremental Stash sync for a library (admin)
         * @description Enqueues a `stash-sync` job (S8) and returns its id honestly — this endpoint does not wait for the sync to complete. 404 if the library itself does not exist (checked before body validation).
         */
        post: operations["postAdminLibraryStashSync"];
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
        /** Import a previously exported archive (admin). Long-running; runs through the job queue (long-running work is never performed inline on a request thread). */
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
         *
         *     A permission-denied listing fails 403 with `code: "filesystem-permission-denied"` and a `detail` sentence tailored to the service account the server is actually running as (the macOS/Linux installers run a dedicated least-privilege account that cannot read personal home folders) — clients should surface that `detail` verbatim, it says what to do about the situation. On a platform with a scripted grant recipe (macOS service-account installs today), that same 403 body additionally carries a `remediation` extension member shaped like `FilesystemPermissionRemediation` — a short summary, the exact ACL grant command(s) pre-filled with the real requested path, and a verify command — which clients should render as an actionable grant flow instead of the bare `detail` paragraph. `remediation` is additive and absent on platforms without a scripted recipe (Linux/dev/container installs today); clients MUST fall back to rendering `detail` when it is absent.
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
    "/admin/mail/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set (or replace) the SMTP username/password (admin, write-only)
         * @description Write-only, same posture as setAdminProviderKey: the submitted credentials are never echoed back, logged, or otherwise readable again through this API — status reads (GET /admin/settings's `mailCredentials`) report configured/setAtMs/source only, never the values. Stored as one keyring entry (packages/secrets), never in server_settings. Credentials are OPTIONAL overall — unauthenticated SMTP (a private-network relay) is a legal configuration; this endpoint exists for the common case of a real mail provider that requires them. A10 live-admin re-verify gates this exactly like setAdminProviderKey.
         */
        put: operations["setAdminMailCredentials"];
        post?: never;
        /**
         * Clear the stored SMTP username/password (admin)
         * @description Removes the stored keyring entry. A real LOOMBRE_SMTP_USERNAME/ LOOMBRE_SMTP_PASSWORD pair, if both set, still wins on the next status read regardless (env precedence) — this only clears the keyring-stored fallback. Idempotent: clearing when nothing is stored still returns 204.
         */
        delete: operations["clearAdminMailCredentials"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/mail/test-send": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a real test email through the configured transport (admin)
         * @description Enqueues a real `mail-send` job (template "test", no retries) — never sends inline on this request thread. The admin observes the outcome (delivered, or the real SMTP conversation error) via the existing admin-only job-update live feed and the job ledger's error detail for the returned `jobId`, the same surface every other queued job already reports through.
         */
        post: operations["testSendMail"];
        delete?: never;
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
    "/admin/libraries/{id}/stash-sync-report": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * The latest Stash metadata-sync report for a library (admin)
         * @description STATE.md S8/K14 (Stash SQLite metadata sync, Lane C sync engine). `report` is the most recently STARTED `stash-sync` job's counts (matched/updated/unmatched/stale/skipped) and status — null when no sync has ever run for this library yet, same honest-empty-shape precedent as GET /admin/capabilities's `{report: null}` before the first hwprobe. `unmatchedScenes`/`staleScenes` are NOT a frozen snapshot from the report row — both are LIVE, keyset-paginated queries over the current stash_scene_links table (K10/S4/S8), so they reflect fixes (a corrected path mapping, a scene reappearing in Stash) immediately, without waiting for the next sync run. `unmatchedLoombreFiles` (FX3 fix wave) is the Loombre-side twin — S4/S8 document BOTH unmatched sides as the report's job; this is also a live query, over media_files/catalog_items, never a report snapshot.
         */
        get: operations["getAdminStashSyncReport"];
        put?: never;
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
         * @description Nothing spawns provider I/O inline in a request path: enqueues a 'metadata-search' job. The worker resolves the item's provider chain, searches every enabled provider, scores each result (apps/worker/src/metadata/match.ts's title/year scoring), and delivers the ranked candidate list as an admin-only `metadata.match-candidates` event over the existing events socket (GET /admin/jobs/{id} also reflects the job's own lifecycle).
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
    "/admin/remote/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wizard re-entry read — derived active path + per-path status (admin)
         * @description `activePath` is DERIVED, never stored (RG15/RG5 refinement — there is no `remote.activePath` setting): computed from the three subsystems' own enabled state, at most one of which can be enabled at a time (the staged enable flows below 409 rather than allowing two paths live together). Lets the wizard re-enter mid-flow or land on the posture handoff without the client tracking step state itself (RG10 — the server persists only outcomes).
         */
        get: operations["getRemoteState"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/wireguard/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable Loombre Remote — embedded userspace WireGuard (admin)
         * @description R1: generates the server WG keypair (private key in the KEYRING, never server_settings) and opens the in-process userspace listener (wireguard-go + netstack, RG1/RG2) — no kernel module, no root, no routing-table changes, LAN never exposed. Staged validate→stage→ commit (RG10, plugin-registration shape); 409 when a DIFFERENT path is already active (at most one active path, RG5/RG15).
         */
        post: operations["enableRemoteWireguard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/wireguard/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable Loombre Remote — verified teardown (admin)
         * @description R8: revokes every enrolled peer and drops the listener, verified — not merely a flag flip. Idempotent: disabling an already-disabled listener still returns 200 with the (already-disabled) status.
         */
        post: operations["disableRemoteWireguard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/wireguard/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Listener state, port, subnet, endpoint host, peer count (admin) */
        get: operations["getRemoteWireguardStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/wireguard/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List enrolled Remote (WireGuard) devices (admin)
         * @description R2: these ARE rows in the existing devices list (kind: remote) — this is the WireGuard-scoped view of that same population (tunnel IP, enrollment/handshake timestamps) rather than a separate entity.
         */
        get: operations["listRemoteWireguardDevices"];
        put?: never;
        /**
         * Enroll a device — one-time provisioning payload (admin)
         * @description R2/R3: generates a fresh peer keypair server-side, allocates the next free tunnel IP (RG9, subnet default 10.82.146.0/24, server =.1, devices from .2), and returns the FULL wg-quick config text ONCE — the private key is not retained after this response (same posture as invite links). The config is split-tunnel ONLY (AllowedIPs scoped to the Loombre tunnel address, R3) and APP-AGNOSTIC standard WireGuard semantics (packages/shared/src/ remote/provisioning.ts — today's official WireGuard app and tomorrow's native Loombre clients enroll through this identical shape). 409 when Wireguard is not enabled.
         */
        post: operations["enrollRemoteWireguardDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/wireguard/devices/{id}": {
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
        post?: never;
        /**
         * Revoke an enrolled Remote device — removes the peer live (admin)
         * @description R2/RG3: removes the live WG peer (handshake fails immediately after) AND revokes the underlying device row's refresh tokens (RG3's pre-existing-gap closure — WG2 wires this; this Wave-0 shell only reserves the operation's shape). Distinct from the self-service DELETE /devices/{id}: this is an ADMIN-scoped revoke of ANY user's enrolled device, not only the caller's own.
         */
        delete: operations["revokeRemoteWireguardDevice"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/tunnel/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set the BYO Cloudflare API token — write-only (admin)
         * @description R4/R9: write-only, same posture as setAdminProviderKey/ setAdminMailCredentials — the submitted token is never echoed back, logged, or otherwise readable again through this API; stored in the platform KEYRING (packages/secrets), never server_settings. Returns a VALIDATION RESULT (a real, bounded Cloudflare API call proving the token's scope is usable), not the token itself.
         */
        post: operations["setRemoteTunnelToken"];
        /**
         * Clear the stored Cloudflare API token (admin)
         * @description Removes the keyring entry. Idempotent — clearing when nothing is stored still returns 204.
         */
        delete: operations["clearRemoteTunnelToken"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/tunnel/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable the Tunnel path — creates the tunnel + DNS route, starts the connector (admin)
         * @description R4: creates a Cloudflare tunnel + DNS route via the stored token, then runs cloudflared as a managed, supervised child process (RG7 — EmbeddedPostgres supervisor / spawnFfmpegRun shape: SIGTERM→timeout→ SIGKILL, stderr ring buffer, full-jitter backoff). Staged validate→stage→commit (RG10); 409 when a different path is already active, or when no valid token is stored.
         */
        post: operations["enableRemoteTunnel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/tunnel/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable the Tunnel path — verified connector teardown (admin)
         * @description R8 — tears down the tunnel + DNS route and stops the connector process, verified. Idempotent.
         */
        post: operations["disableRemoteTunnel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/tunnel/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Connector health, backoff, last error (admin) */
        get: operations["getRemoteTunnelStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/tunnel/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Bounded tail of the connector's stderr ring buffer (admin)
         * @description RG7 — the supervised cloudflared child's in-memory stderr ring buffer, not a file (no LOOMBRE_LOG_FILE dependency).
         */
        get: operations["getRemoteTunnelLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/direct/acme-test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Staged test certificate issuance before committing Direct/ACME (admin)
         * @description RG12: runs a real STAGED test issuance through the existing issue-certificate.ts module BEFORE tls.mode is ever flipped (lockout-risk mitigation) — proves issuance is feasible for the given domain without touching live TLS config.
         */
        post: operations["testRemoteDirectAcme"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/direct/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable the Direct path — ACME issuance or reverse-proxy mode (admin)
         * @description R5: `mode: acme` commits tls.mode via the existing restart machinery (server-power UI) after a passing acme-test; `mode: reverse-proxy` records the trust-proxy configuration instead — the wizard never touches the router itself (HARD LINE: detect, instruct, verify, never auto-configure the network — no UPnP, ever). Staged validate→stage→commit (RG10); 409 when a different path is already active.
         */
        post: operations["enableRemoteDirect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/direct/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable the Direct path (admin)
         * @description R8 — verified disable. Idempotent.
         */
        post: operations["disableRemoteDirect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/diagnosis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Classify a failed reachability proof (admin)
         * @description R5/R6/RG11 — pure WAN-classification decision function (packages/shared/src/remote/diagnosis.ts): RFC 6598 (100.64/10) WAN -> definite CGNAT; RFC1918 WAN -> double-NAT; WAN matches the DNS-resolved public endpoint but the probe never arrived -> a port/firewall block; WAN differs from the resolved endpoint -> CGNAT/dynamic-IP mismatch, routes the wizard to Tunnel. No third-party echo service and no router APIs — `wanAddress` is admin-supplied via a guided router-status-page instruction card.
         */
        post: operations["diagnoseRemote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/probes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mint a one-time reachability-proof probe token (admin)
         * @description R6: hashed at rest (SHA-256, house pattern M3/RG6 — constant-time by construction, argon2id deliberately NOT used on this unauth-reached token), 15-minute expiry, single-use, bound to `expectedEndpoint`. The raw token appears ONLY in THIS response, embedded in `probeUrl` (https://&lt;endpoint&gt;/probe/&lt;token&gt;) and `qrPayload` — never retrievable again. Scan `qrPayload` with a phone ON CELLULAR (the phone IS the external vantage; no third-party check service).
         */
        post: operations["createRemoteProbe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/probes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["IdPathParam"];
            };
            cookie?: never;
        };
        /**
         * Poll a probe's arrival state (admin)
         * @description The wizard watches this to light the reachability proof green end-to-end. `diagnosis` is populated once the probe has definitively failed to arrive (RG11's decision function) — never speculative while still `pending`.
         */
        get: operations["getRemoteProbe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/remote/posture": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Exposure-aware security posture card (admin)
         * @description R7: evaluates every posture check applicable to the currently active remote-access path (packages/shared/src/remote/ posture-model.ts's frozen POSTURE_CHECK_KEYS/applicableChecks — `checks` is empty when no path is enabled, since every active path always yields at least one check). Grades link to fix actions. Regressions/recoveries are separately reported via the admin-only outbox (`posture.regressed`/`posture.recovered`, RG4) by a background sweep — this endpoint itself is a stateless "evaluate now" read with no side effects.
         */
        get: operations["getRemotePosture"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/probe/{token}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The raw one-time probe token (never the hash). */
                token: string;
            };
            cookie?: never;
        };
        /**
         * Reachability-proof arrival page — PUBLIC by necessity (R6/R9)
         * @description R6/R9: one of only THREE new unauthenticated surfaces this subsystem introduces (alongside the WireGuard UDP listener itself and the tunnel connector's own inbound edge) — necessarily public because the whole point is an external phone-on-cellular request with no prior credentials. Rate-limited (`rateLimit.probe`, per-IP), token-gated, constant-time lookup (RG6's SHA-256 hash equality — same posture as invite-claim), and returns a STATIC success page with ZERO server info (no version, no instance name, nothing an unauthenticated prober could use for reconnaissance). Invalid, expired, already-consumed, or well-formed-but-unknown tokens ALL resolve to the SAME byte-identical 404 this operation shares with an unknown route (bare, no `detail`/`instance` — the same "invisible == nonexistent" posture as POST /setup/first-admin once configured and GET/POST /invites/claim/{token}) — the four cases are deliberately indistinguishable from the outside (enumeration-resistant). Wave 0: this shell IS the final behavior for every case except a genuinely-arrived probe (no probe tokens exist yet, so every request legitimately 404s); a later lane adds the real single-use lookup + arrival-marking without changing this response shape.
         */
        get: operations["getProbePage"];
        put?: never;
        post?: never;
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
         * @description Entity types a managed image can belong to. `person` images are guarded by the SAME leak rule listPeople/getPersonById use (content_class isolation AND credited-on->=1-visible-item), so a person invisible to the caller has no reachable images either. This value plus the server-side mapping fix close that gap so a Person page portrait (GET /images/person/{id}/thumb) can be served. `tag` (S9 — studio logos: studios are kind=studio tags, S6) is guarded the same way, via applyGuardToTags + applied-to->=1-visible-item.
         * @enum {string}
         */
        ImageEntityType: "movie" | "series" | "season" | "episode" | "artist" | "album" | "track" | "person" | "tag";
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
            /** @description E3a/M14 — true iff an admin/CLI temporary-password reset is still pending a real password change. Additive; always sent by authLogin and authRefresh (never omitted, even when false) so older clients that ignore it are unaffected. While true, the server restricts this account to auth login/refresh/logout, GET /users/me, and PATCH /users/me (403 on everything else) — enforced server-side, not merely advisory. */
            mustChangePassword?: boolean;
            /** @description LD-13c (STATE.md "Mail posture trio"): additive; sent ONLY by claimInvite (never authLogin/authRefresh/first-admin — a fresh claim is the only TokenPair-returning op where an email can silently fail to apply). `false` iff the claim's intended email (submitted or preset-inherited) collided with another account's and was therefore silently dropped (F3/G6's existing E8-safe silent-no-op — this field is the honest signal that behavior already existed without). `true` whenever the email ended up applied as intended, INCLUDING when no email was ever submitted/preset (nothing to drop) and when the claimant explicitly opted out via ClaimInviteRequest's `email: null` (LD-13b — intent achieved, not a drop). Deliberately POST-AUTH ONLY (never surfaced pre-account-creation, e.g. GET /invites/claim/{token} or any pre-creation error path): a caller can only read this field by completing a real, rate- limited account creation, not by a free repeatable probe — see docs/PLAN.md/STATE.md for the enumeration-safety reasoning. */
            emailApplied?: boolean;
        };
        ForgotPasswordRequest: {
            /** @description Username or email — resolved the same way authLogin resolves either. */
            identifier: string;
        };
        /** @description Deliberately empty — the fixed, content-free 202 body every call returns regardless of outcome (E3b/E8 anti-enumeration). */
        ForgotPasswordResponse: Record<string, never>;
        ResetPasswordRequest: {
            token: string;
            /** Format: password */
            password: string;
        };
        /** @description R-F3 (opus adversarial review, fix wave): `currentPassword` is required ONLY when the path `id` equals the caller's own userId — a condition the schema itself cannot express (there is no same-as-caller relational operator in JSON Schema), so it is an optional property here and enforced server-side by the same requireCurrentPassword helper UpdateMeRequest/ RestrictedSettingsUpdate use (target-agnostic 422/403, the shared per-user rate limiter). Ignored entirely when resetting ANOTHER user's password. */
        AdminResetPasswordRequest: {
            /**
             * Format: password
             * @description Current-password re-authentication for a SELF-reset. Deliberately UNCONSTRAINED, same reasoning as UpdateMeRequest.currentPassword: it proves an already-stored secret and is only ever compared against a stored hash, never itself stored.
             */
            currentPassword?: string;
        };
        AdminResetPasswordResponse: {
            /** @description Shown exactly once; the server retains only its hash. */
            temporaryPassword: string;
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
        /**
         * @description STATE.md "Loombre Remote", lane WG2, R2/RG3: 'app' (default — every login-created device) or 'remote' (admin-initiated WireGuard enrollment ONLY, POST /admin/remote/wireguard/devices — never the login path). ADDITIVE field on the devices-list Device schema (R2's "enrolled devices appear in the existing devices list (kind: remote)").
         * @enum {string}
         */
        DeviceKind: "app" | "remote";
        Device: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            userId: string;
            name: string;
            kind: components["schemas"]["DeviceKind"];
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
            /** @description M8 — true iff self-service "forgot password" (authForgotPassword/ authResetPassword) is usable on this instance: mail is configured (a generic SMTP transport with host/from-address/ public-URL all set — credentials optional). Additive; always sent (never omitted). The login screen shows a "forgot password" affordance only when this is true. */
            passwordResetAvailable?: boolean;
        };
        ServerPowerActionResponse: {
            /** @enum {boolean} */
            accepted: true;
            /** @enum {string} */
            action: "restart" | "shutdown";
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
            /** @description Backend identifier as probed (videotoolbox, nvenc, qsv, vaapi, amf, d3d11va, software — closed set enforced by the DB CHECK, mirrored not re-enumerated here so a new backend is additive). */
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
            /** @description Null until a self-test snapshot exists — probe.status distinguishes never-ran / pending / failed. A non-null report whose backends verified zero capabilities is a VALID software-everything state (software decode/encode/tone-mapping), not an error. */
            report: components["schemas"]["CapabilityReport"] | null;
            probe: components["schemas"]["CapabilityProbeStatus"];
        };
        CapabilityProbeStatus: {
            /**
             * @description Lifecycle of the worker's hardware-capability self-test. completed = the report reflects the latest self-test — including the valid zero-accelerated-backends outcome (software everything). pending = a self-test job is queued or running; a previous report may still be present alongside it (re-probe after an ffmpeg/GPU change). failed = the most recent self-test job failed (lastError carries the job error); any report shown is from an earlier successful run. never-ran = no snapshot and no self-test job on record.
             * @enum {string}
             */
            status: "never-ran" | "pending" | "failed" | "completed";
            /** @description The failed self-test job's error message; null unless status is 'failed'. */
            lastError: string | null;
            /**
             * Format: int64
             * @description When the underlying signal last changed (self-test job ledger row, or the snapshot's verifiedAtMs once completed); null when status is 'never-ran'.
             */
            updatedAtMs: number | null;
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
            /** @description Whether the server itself can descend into this directory. False means a follow-up listing of `path` will fail with 403 — the service account lacks read permission (the normal state of personal home folders under the macOS/Linux installers, whose services run as a dedicated least-privilege account). Clients should render such entries dimmed/marked rather than hiding them, so an operator can see the folder exists and either fix its permissions or choose another location. */
            readable: boolean;
        };
        DirectoryListing: {
            /** @description The directory that was listed, or null for the roots listing (no `path` parameter was supplied). */
            path: string | null;
            /** @description Absolute path one level up, or null when already at a root. Supplied by the server because "the parent of this path" is a platform-specific question the client should not answer. */
            parent: string | null;
            /** @description Immediate subdirectories, name-sorted. Entries that cannot even be identified as directories (broken symlinks, un-statable link targets) are omitted; directories the server can see but not open are included with `readable: false` — one unreadable system directory must not make a browsable parent un-browsable, and hiding it would misrepresent the filesystem. */
            entries: components["schemas"]["DirectoryEntry"][];
        };
        /** @description Optional `remediation` extension member on the Problem body returned by GET /admin/filesystem/directories when `code: "filesystem-permission-denied"` AND the server has a scripted grant recipe for the platform it's actually running on (macOS service-account installs today; Linux/dev/container installs have none yet — chown-based advice is too destructive to script blindly). When present, clients should render this instead of the bare `detail` paragraph: `summary` as a one-line message, `commands` as a copyable, ordered command block pre-filled with the real path, and `verify` as the command that proves the grant worked. Clients MUST fall back to rendering `detail` verbatim when `remediation` is absent — this member is an additive RFC 9457 extension (`Problem` already declares `additionalProperties: true`), never a replacement for `detail`. */
        FilesystemPermissionRemediation: {
            /** @description One short sentence naming the blocked service account (e.g. "Loombre's service account (_loombre) can't read this folder."). */
            summary: string;
            /** @description Shell commands to run, in order, pre-filled with the real requested path — paste-ready, nothing left for the operator to fill in. */
            commands: string[];
            /** @description A single command that proves the grant worked (re-lists the same path as the service account). */
            verify: string;
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
            /**
             * Format: email
             * @description M1: optional login identifier — an additive LOOSENING (the column was CITEXT NOT NULL UNIQUE before; still CITEXT UNIQUE, just nullable now). Null = no email on file; the user authenticates by username only.
             */
            email: string | null;
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
            /** @description E3a/M14, admin visibility — true iff an admin/CLI temporary- password reset is pending a real password change. Additive; always sent (never omitted). */
            mustChangePassword?: boolean;
        };
        UserPage: {
            items: components["schemas"]["User"][];
            nextCursor: string | null;
        };
        CreateUserRequest: {
            username: string;
            /**
             * Format: email
             * @description M1: optional (was required) — an admin may create an email-less user.
             */
            email?: string | null;
            /** Format: password */
            password: string;
            displayName?: string | null;
            /** @default false */
            isAdmin: boolean;
            maxContentRating?: string | null;
        };
        /** @description Admin update of another user. Partial; only present fields change. */
        UpdateUserRequest: {
            /**
             * Format: email
             * @description M1: null clears the email, matching displayName's own null-to-clear shape below.
             */
            email?: string | null;
            displayName?: string | null;
            isAdmin?: boolean;
            maxContentRating?: string | null;
        };
        /** @description Self-service profile update; cannot change isAdmin or maxContentRating. */
        UpdateMeRequest: {
            displayName?: string | null;
            /**
             * Format: email
             * @description M1: null-to-clear (birthDate precedent below).
             */
            email?: string | null;
            /** Format: date */
            birthDate?: string | null;
            /** Format: password */
            password?: string;
            /**
             * Format: password
             * @description Current-password re-authentication (G2/G3, STATE.md "Current-password re-auth on self-changes"). Required (`dependentRequired` below) whenever this request's body contains `password` and/or `email` — ANY value, including an explicit `null` to clear email — since both are account- critical self-service changes; a bare displayName/birthDate- only profile save needs no re-auth. Deliberately UNCONSTRAINED, same reasoning as RestrictedSettingsUpdate.currentPin below: it proves an ALREADY-STORED secret and is only ever compared against a stored hash, never itself stored, so a shape constraint would add nothing. A wrong value 403s with the same fixed detail regardless of which field (password or email) was being changed (F2: never confirms which target value was the problem).
             */
            currentPassword?: string;
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
        /**
         * @description Derived at read time from claimedAtMs/revokedAtMs/expiresAtMs — never stored.
         * @enum {string}
         */
        InviteStatus: "pending" | "claimed" | "revoked" | "expired";
        /** @description Admin-facing invite record. NEVER carries token material. */
        Invite: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            createdByUserId: string;
            /** Format: int64 */
            createdAtMs: number;
            /** Format: int64 */
            expiresAtMs: number;
            usernamePreset: string | null;
            displayNamePreset: string | null;
            /** Format: email */
            email: string | null;
            libraryIds: string[];
            status: components["schemas"]["InviteStatus"];
            /** Format: uuid */
            claimedByUserId: string | null;
            /** Format: int64 */
            claimedAtMs: number | null;
            /** Format: int64 */
            revokedAtMs: number | null;
        };
        InvitePage: {
            items: components["schemas"]["Invite"][];
            nextCursor: string | null;
        };
        CreateInviteRequest: {
            /** @description Username preset — authoritative at claim time (preset wins). */
            username?: string;
            displayName?: string | null;
            /**
             * Format: email
             * @description Send-to address AND claim-time email default. If mail is configured, the invite email is sent here.
             */
            email?: string;
            /**
             * Format: int64
             * @description Bounds 1h-30d; default 72h.
             * @default 259200000
             */
            expiresInMs: number;
            /** @description General-class libraries only (M4) — a restricted-class or unknown library id 422s the whole request; may be empty. */
            libraryIds: string[];
        };
        /** @description claimToken is returned EXACTLY ONCE — never retrievable again, never logged, never in any event payload (M3). */
        CreateInviteResponse: {
            invite: components["schemas"]["Invite"];
            claimToken: string;
            /** @description publicUrl-derived claim link, or null when the public URL setting is unset (M9) — the web composes a browser-origin fallback in that case. */
            claimUrl: string | null;
        };
        ClaimState: {
            usernamePreset: string | null;
            displayNamePreset: string | null;
            emailPreset: string | null;
        };
        ClaimInviteRequest: {
            /** @description Required iff the invite has no usernamePreset; the preset wins if both are present. */
            username?: string;
            /** Format: password */
            password: string;
            /**
             * Format: email
             * @description Defaults to the invite's own emailPreset when this member is ABSENT. LD-13b (STATE.md "Mail posture trio"): an explicit `null` opts OUT of the preset outright — the new account gets no email at all, even when the invite carries a preset — distinct from omitting the member. A submitted string is used verbatim (trimmed, then format-validated).
             */
            email?: string | null;
            /** @description Defaults to the invite's own displayNamePreset when omitted. */
            displayName?: string;
            deviceName?: string;
            deviceProfile?: components["schemas"]["DeviceProfile"];
        };
        RestrictedSettingsUpdate: {
            optIn: boolean;
            /** @description New PIN to set (required when enabling opt-in or changing PIN). Exactly 4 digits: the unlock prompt is a fixed 4-digit buffer, so a PIN of any other length could never be entered again and would lock the user out of restricted content permanently. */
            pin?: string;
            /** @description Required to change an existing PIN or to opt out. Proves an ALREADY-STORED PIN and is therefore DELIBERATELY not length- or pattern-constrained: an install predating the 4-digit rule above may hold a PIN of some other length, and this field is that user's only recovery path (prove the old PIN, set a conforming new one, or opt out). It is only ever compared against a stored hash, never stored, so the looser shape widens nothing. */
            currentPin?: string;
            /**
             * Format: password
             * @description Current-password re-authentication (G2/G3, STATE.md "Current-password re-auth on self-changes"). ALWAYS required — every call to this endpoint is account-critical (PIN set/change AND opt-in/out are one operation, F1). Deliberately UNCONSTRAINED, same reasoning as currentPin above: it proves an already-stored secret and is only ever compared against a stored hash, never itself stored. Distinct from currentPin — proving the account password does not replace proving the PIN where the PIN itself is also required (F4: "currentPassword is additional, not a PIN replacement").
             */
            currentPassword: string;
        };
        RestrictedSettings: {
            optIn: boolean;
            hasPin: boolean;
            /** Format: int64 */
            unlockedUntilMs: number | null;
        };
        /**
         * @description info -> auto-dismiss toast; warning -> persistent, per-session- dismissible banner; critical -> persistent, NOT dismissible banner. Governs the expiry defaults on POST /system/notices (see that operation's own description).
         * @enum {string}
         */
        NoticeSeverity: "info" | "warning" | "critical";
        /** @description The all-user broadcast shape — delivered as notice.published's payload AND as GET /notices/active's `notice` field. Deliberately excludes createdBy/any admin-identity field (plain-content posture: every user sees this, never who published it). */
        SystemNotice: {
            /** Format: uuid */
            id: string;
            message: string;
            severity: components["schemas"]["NoticeSeverity"];
            /**
             * Format: int64
             * @description The countdown target ("restarting at this time"), absolute ms. Null when this notice carries no scheduled moment.
             */
            effectiveAtMs: number | null;
            /**
             * Format: int64
             * @description Absolute ms this notice stops being active. Null means "until cancelled" (legal only for severity=critical).
             */
            expiresAtMs: number | null;
            /** Format: int64 */
            createdAtMs: number;
        };
        /** @description The all-user SystemNotice shape plus admin-only history fields. */
        SystemNoticeAdmin: {
            /** Format: uuid */
            id: string;
            message: string;
            severity: components["schemas"]["NoticeSeverity"];
            /** Format: int64 */
            effectiveAtMs: number | null;
            /** Format: int64 */
            expiresAtMs: number | null;
            /** Format: int64 */
            createdAtMs: number;
            /** Format: uuid */
            createdBy: string | null;
            /** Format: int64 */
            cancelledAtMs: number | null;
            /**
             * @description Derived at read time from cancelledAtMs/expiresAtMs — never stored.
             * @enum {string}
             */
            status: "active" | "cancelled" | "expired";
        };
        SystemNoticePage: {
            items: components["schemas"]["SystemNoticeAdmin"][];
            nextCursor: string | null;
        };
        PublishSystemNoticeRequest: {
            message: string;
            severity: components["schemas"]["NoticeSeverity"];
            /**
             * Format: int64
             * @description RELATIVE ms from now (NOT an absolute timestamp) — the server anchors it to its own clock. Omit for a notice with no scheduled countdown moment. Capped at 365 days (31536000000 ms) — a notice scheduled further out than that is a mistake, not a plan.
             */
            effectiveInMs?: number;
            /**
             * Format: int64
             * @description RELATIVE ms from now. Required for severity=warning (422 when absent). Optional for severity=info (defaults to 1 hour). Optional for severity=critical (omitted = until cancelled). Capped at 365 days (31536000000 ms).
             */
            expiresInMs?: number;
        };
        ActiveSystemNoticeResponse: {
            notice: components["schemas"]["SystemNotice"] | null;
            /**
             * Format: int64
             * @description The server's clock at response time (NG3's anchor) — clients compute `offset = serverNowMs - Date.now()` at receipt and render any countdown against `effectiveAtMs - (Date.now() + offset)`, never their own wall clock alone.
             */
            serverNowMs: number;
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
        /** @description One chapter_markers row (migrations/0019, S7/K9) — GET /items/{id}/chapters and RestrictedSceneDetail.chapters both use this exact shape. */
        ChapterMarker: {
            title: string;
            /** Format: int64 */
            startMs: number;
            /**
             * @description The producer that wrote this marker (chapter_markers.source).
             * @enum {string}
             */
            source: "stash";
        };
        /** @description GET /items/{id}/chapters — a small, complete, already-ordered list (never large enough to need cursor pagination, unlike this contract's other list endpoints). */
        ItemChapters: {
            /** @description Ordered by startMs ascending. */
            items: components["schemas"]["ChapterMarker"][];
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
            /** @description docs/PLAYBACK.md §2.1 (added 2026-08-10). REQUIRED, never optional — a DB NULL collapses to false at extraction boundaries (the conservative default). */
            openGop: boolean;
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
        PlanReasonCode: ("container-not-direct-playable" | "video-codec-unsupported" | "video-profile-unsupported" | "video-level-exceeds-device" | "video-bitdepth-unsupported" | "video-resolution-exceeds-device" | "video-framerate-exceeds-device" | "video-interlaced" | "hdr-tone-map-required" | "dv-profile5-requires-tonemap" | "tone-map-refused-by-policy" | "audio-codec-unsupported" | "audio-channels-exceed-device" | "audio-passthrough-unsupported" | "subtitle-format-requires-burn-in" | "subtitle-burn-in-for-styling" | "video-transcode-for-subtitle-burn-in" | "bitrate-exceeds-network" | "subtitle-codec-unknown" | "transcode-disabled-by-policy" | "dv-stripped-to-hdr10" | "subtitle-styling-lost" | "audio-atmos-lost" | "gapless-degraded" | "open-gop-leading-pictures-stripped" | "av1-rung-demoted") | string;
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
            targetCodec?: components["schemas"]["LadderCodec"];
            /** @description Selected hardware backend or 'software' (docs/PLAYBACK.md §8.3). */
            encoder?: string;
            toneMap?: components["schemas"]["ToneMapMethod"];
            /** @description Set (true) only when a video COPY into a repackaged HLS container strips open-GOP HEVC leading pictures on a seek-restart (docs/PLAYBACK.md §5/§6); omitted when not applicable. Never emitted false. */
            openGop?: boolean;
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
        /**
         * @description The closed set of codecs a ladder rung may ENCODE to (docs/PLAYBACK.md §7/§7.1) — deliberately narrower than VideoCodec, which is the SOURCE-fact union. av1 landed with LD-7 (Wave C1).
         * @enum {string}
         */
        LadderCodec: "h264" | "hevc" | "av1";
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
        /** @description Per-item 4K/HDR/resolution-band signal for the zone's own filter chips — not part of Movie/Series (list responses there carry no mediaFiles/streams data, Tier-0), so this is scoped to the zone's own dedicated reads (RestrictedBrowseItem/RestrictedScene). */
        RestrictedZoneItemQuality: {
            /** @description Primary video stream >= 3840x2160 on any non-missing media file. */
            is4k: boolean;
            hdr: components["schemas"]["HdrType"];
            /** @description Derived from the primary probed video stream's height (S5's technical authority) — null when no video stream has been probed yet. */
            resolution: components["schemas"]["RestrictedResolutionBand"] | null;
        };
        /**
         * @description SD < 720p <= HD < 1080p <= FHD < 2160p <= UHD, by primary video stream height (S9/S10).
         * @enum {string}
         */
        RestrictedResolutionBand: "SD" | "HD" | "FHD" | "UHD";
        /**
         * @description `added` (catalog_items.added_at_ms), `date` (movie_details. premiere_at_ms, falling back to catalog_items.year — K1), `title`, `rating` (community_rating), `duration` (probed media_files. duration_ms).
         * @enum {string}
         */
        RestrictedBrowseSort: "added" | "date" | "title" | "rating" | "duration";
        RestrictedStudioRef: {
            /** Format: uuid */
            id: string;
            name: string;
        };
        RestrictedPerformerRef: {
            /** Format: uuid */
            id: string;
            name: string;
        };
        RestrictedTagChip: {
            /** Format: uuid */
            id: string;
            name: string;
        };
        /** @description One restricted-zone scene row (GET /restricted/browse, GET /restricted/search, GET /restricted/performers/{id}/scenes) — itemType is always `movie` (K1: scenes are item_type='movie' rows in restricted libraries). */
        RestrictedBrowseItem: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "movie";
            /**
             * Format: int64
             * @description K1 editorial premiere date; null falls back to `year`.
             */
            premiereAtMs: number | null;
            /**
             * Format: int64
             * @description Probed primary-file duration; null until the file is probed.
             */
            durationMs: number | null;
            genres: string[];
            images: components["schemas"]["ImageDescriptor"][];
            quality: components["schemas"]["RestrictedZoneItemQuality"];
            studio: components["schemas"]["RestrictedStudioRef"] | null;
        };
        RestrictedBrowseItemPage: {
            items: components["schemas"]["RestrictedBrowseItem"][];
            nextCursor: string | null;
        };
        /** @description One chapter_markers row (migrations/0019, K9/S7) for this scene. */
        RestrictedSceneMarker: {
            /** Format: uuid */
            id: string;
            title: string;
            /** Format: int64 */
            startMs: number;
        };
        /** @description The caller's OWN progress on this scene — a lighter twin of Progress without `itemId` (redundant: this object only ever appears nested inside the scene it belongs to). */
        RestrictedSceneProgress: {
            /** Format: int64 */
            positionMs: number;
            /** Format: int64 */
            durationMs: number | null;
            state: components["schemas"]["ProgressState"];
            playCount: number;
            /** Format: int64 */
            updatedAtMs: number;
        };
        /** @description GET /restricted/scenes/{id} — full scene detail. */
        RestrictedScene: components["schemas"]["CatalogItemBase"] & {
            /** @constant */
            itemType: "movie";
            /**
             * Format: int64
             * @description K1 editorial premiere date (movie_details.premiere_at_ms); null falls back to `year`.
             */
            premiereAtMs: number | null;
            contentRating: string | null;
            /**
             * Format: int64
             * @description Editorial runtime (movie_details.runtime_ms) — provider/ admin-set, not necessarily populated for Stash-sourced scenes (S5: Stash supplies editorial facts, never technical ones). Prefer `durationMs` (the PROBED primary-file duration) for display; this is kept for parity with Movie/Episode/Track's own `runtimeMs` field.
             */
            runtimeMs: number | null;
            /**
             * Format: int64
             * @description Probed primary-file duration (S5 "Loombre ffprobe authoritative for technical facts") — the same field RestrictedBrowseItem carries; null until the file is probed.
             */
            durationMs: number | null;
            overview: string | null;
            tagline?: string | null;
            /** @description Genre AND general item_tags (kind IN (genre,tag)) together as one id/name chip list — the design's "tag chips", not split from a separate genre list the way browse cards' `genres` are (scene detail has no card-level genre badge to keep separate). */
            tags: components["schemas"]["RestrictedTagChip"][];
            studio: components["schemas"]["RestrictedStudioRef"] | null;
            performers: components["schemas"]["RestrictedPerformerRef"][];
            images: components["schemas"]["ImageDescriptor"][];
            /** @description Ordered by startMs ascending. */
            markers: components["schemas"]["RestrictedSceneMarker"][];
            /** @description Null if the caller has never played this scene. */
            progress: components["schemas"]["RestrictedSceneProgress"] | null;
            quality: components["schemas"]["RestrictedZoneItemQuality"];
        };
        /** @description GET /restricted/performers row/detail — role=performer people credited on >=1 scene visible within the zone. Mirrors Person's shape (packages/db/src/query/people.ts's guard model) with a zone-scoped `sceneCount` in place of Person's general `creditCount`. FX2 fix wave: `images` mirrors RestrictedStudio's own field exactly (same shape, same guard posture) — B ingests performer portraits (images entity_type='person', kind='thumb') but this field was missing here until now. */
        RestrictedPerformer: {
            /** Format: uuid */
            id: string;
            name: string;
            contentClass: components["schemas"]["ContentClass"];
            sceneCount: number;
            /** @description The performer's portrait, ingested from Stash (entity_type=person, kind=thumb). */
            images: components["schemas"]["ImageDescriptor"][];
        };
        RestrictedPerformerPage: {
            items: components["schemas"]["RestrictedPerformer"][];
            nextCursor: string | null;
        };
        /** @description GET /restricted/studios row/detail — kind=studio tags (S6: studios are first-class VIA tags, no dedicated entity table). */
        RestrictedStudio: {
            /** Format: uuid */
            id: string;
            name: string;
            contentClass: components["schemas"]["ContentClass"];
            sceneCount: number;
            /** @description The studio's logo, ingested from Stash (entity_type=tag). */
            images: components["schemas"]["ImageDescriptor"][];
        };
        RestrictedStudioPage: {
            items: components["schemas"]["RestrictedStudio"][];
            nextCursor: string | null;
        };
        RestrictedHomeContinueWatchingEntry: {
            item: components["schemas"]["RestrictedBrowseItem"];
            progress: components["schemas"]["Progress"];
        };
        /** @description GET /restricted/home — zone home rails (S9). Rail UI itself is Lane E's scope; this endpoint + shape land here (K4/S9). */
        RestrictedHome: {
            continueWatchingInZone: components["schemas"]["RestrictedHomeContinueWatchingEntry"][];
            recentlyAddedInZone: components["schemas"]["RestrictedBrowseItem"][];
            /** @description Top-N studios by scene count. */
            studios: components["schemas"]["RestrictedStudio"][];
            /** @description Top-N performers by scene count. */
            performers: components["schemas"]["RestrictedPerformer"][];
        };
        /** @enum {string} */
        AdminStashConnectionStatus: "never_connected" | "ok" | "unsupported_schema" | "unreachable";
        /** @description GET/PUT /admin/libraries/{id}/stash-connection — packages/db's library_stash_connections row (migrations/0018 + 0019's additive genre_tag_names), config fields admin-written, status fields worker-written at connect time (S2/S3). */
        AdminStashConnection: {
            /** Format: uuid */
            libraryId: string;
            /** @description False when no connection has ever been saved for this library. */
            configured: boolean;
            sqlitePath: string | null;
            enabled: boolean;
            /** @description S6/K15: which Stash tag names map to Loombre genre rather than general tags. `null` (the default, including before any connection has ever been saved) means the mapper's documented heuristic applies — a Stash tag with NO parent tag maps to genre, a child tag maps to a plain tag; explicit tag names here override that heuristic wholesale, case-insensitively. */
            genreTagNames: string[] | null;
            /** @description Filesystem path to Stash's on-disk blob store, when Stash uses Filesystem (not Database) blob storage. `null` (the default) means art is read only from database-stored blobs — a Filesystem-mode Stash then syncs no covers. A path opts into reading cover/portrait/logo bytes from Stash's sharded on-disk store. Worker-side path; the server never opens it. */
            blobsPath: string | null;
            status: components["schemas"]["AdminStashConnectionStatus"];
            /** @description The exact S3 admin notice when status=unsupported_schema; null otherwise. */
            statusDetail: string | null;
            lastSeenSchemaVersion: number | null;
            /** Format: int64 */
            lastConnectedAtMs: number | null;
            /** Format: int64 */
            lastCheckedAtMs: number | null;
        };
        PutAdminStashConnectionRequest: {
            sqlitePath: string;
            /** @description Defaults to true when omitted on first configure. */
            enabled?: boolean;
            /** @description Omit this field to leave the saved genreTagNames untouched. Send `null` to explicitly clear it back to the default heuristic (see AdminStashConnection.genreTagNames). Send a (possibly empty) array to replace it wholesale. */
            genreTagNames?: string[] | null;
            /** @description Omit to leave the saved blobsPath untouched. Send `null` to clear it (back to DB-only art). Send a path to read covers from Stash's filesystem blob store (see AdminStashConnection.blobsPath). */
            blobsPath?: string | null;
        };
        AdminStashPathMapping: {
            stashPrefix: string;
            loombrePrefix: string;
        };
        AdminStashPathMappings: {
            /** @description Admin display order (position ASC) — matching is longest-prefix-wins, independent of this order. */
            mappings: components["schemas"]["AdminStashPathMapping"][];
        };
        PutAdminStashPathMappingsRequest: {
            mappings: components["schemas"]["AdminStashPathMapping"][];
        };
        PreviewAdminStashPathMappingsRequest: {
            mappings: components["schemas"]["AdminStashPathMapping"][];
        };
        AdminStashPathMappingPreviewUnmatchedScene: {
            stashSceneId: string;
            stashPath: string;
            /** @description Null when no candidate mapping's prefix matches this scene's raw Stash path at all. */
            rewrittenPath: string | null;
        };
        AdminStashPathMappingPreview: {
            totalStashScenes: number;
            candidateMatchCount: number;
            unmatchedCount: number;
            /** @description Capped list for admin display — unmatchedCount above is always the true total. */
            unmatchedScenes: components["schemas"]["AdminStashPathMappingPreviewUnmatchedScene"][];
        };
        PostAdminStashSyncRequest: {
            /** @enum {string} */
            mode: "full" | "incremental";
        };
        /** @description A user record sans secrets (no password hash, no PIN hash, no tokens). This schema is reused BOTH as GET /export's response shape AND (nested under Archive) as POST /import's request shape — `displayName` is deliberately NOT in `required` despite always being present on export, so an archive written before M2 (which never had this key at all) still validates as an import request; the import path treats a missing key exactly like an explicit null (apps/worker/src/import/validate.ts). */
        ExportUser: {
            /** Format: uuid */
            id: string;
            username: string;
            /**
             * Format: email
             * @description M1: nullable, an email-less user exports/imports as null.
             */
            email: string | null;
            /** @description M2 (E4 archive check). Optional key: absent on a pre-M2 archive. */
            displayName?: string | null;
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
        SettingsCategory: "transcode" | "scanner" | "images" | "restricted" | "sessions" | "updateCheck" | "security" | "rateLimit" | "database" | "network" | "tls" | "paths" | "ffmpeg" | "stash" | "mail" | "remote";
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
            /** @description Optional mail transport run (E5/M10) — ADDITIVE field: the SMTP username/password keyring entry's status (never the values themselves; see MailCredentialsStatus). Absent on an older client's cached shape is never load-bearing — mail credentials are optional overall (unauthenticated SMTP relays are legal). */
            mailCredentials?: components["schemas"]["MailCredentialsStatus"];
        };
        /** @description One GET /admin/settings/schema entry — the pure registry projection (no live value): what the admin UI's dynamic widget renderer and the generated operator/admin docs both build from. */
        AdminSettingSchemaEntry: {
            key: string;
            category: components["schemas"]["SettingsCategory"];
            description: string;
            /** @description Operator-facing caution for a setting whose misconfiguration degrades behavior but never locks the instance out. */
            caution?: string;
            /** @description ADDITIVE field (W13b, decision D-7's second copy layer): precise technical detail (protocol notes, format specifics, behavioral caveats) `description` deliberately leaves out of its plain-language register. Rendered by the admin settings screen in an on-demand info tooltip beside the key name, alongside that entry's own env-pin name when it has one. Absent on an older cached client shape is never load-bearing — every field this entry needs to render or validate a setting is elsewhere. */
            technicalDetails?: string;
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
        /** @description GET /admin/settings' additive `mailCredentials` field — the ENTIRE shape a mail-credentials status read ever returns, same discipline as ProviderKeyStatus: never the username/password themselves. */
        MailCredentialsStatus: {
            configured: boolean;
            /**
             * Format: int64
             * @description Null when not configured, or when sourced from the environment (which has no "when was it set" concept this server can observe).
             */
            setAtMs: number | null;
            /**
             * @description Null when `configured` is false.
             * @enum {string|null}
             */
            source: "keyring" | "env" | null;
        };
        SetMailCredentialsRequest: {
            /** @description Write-only — never returned by any endpoint. */
            username: string;
            /** @description Write-only — never returned by any endpoint. */
            password: string;
        };
        TestSendMailRequest: {
            /**
             * Format: email
             * @description The address to send the test message to.
             */
            to: string;
        };
        TestSendMailResponse: {
            /**
             * Format: uuid
             * @description The enqueued `mail-send` job's id — poll GET /admin/jobs/{id} or watch the admin-only job.updated live feed for the outcome.
             */
            jobId: string;
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
        /** @description One migrations/0020_stash_sync_reports.sql row — the most recently STARTED stash-sync run for a library. Counts are a point-in-time snapshot recorded when the run finished (or failed), never a live query. */
        StashSyncReport: {
            /** Format: uuid */
            jobId: string;
            /** @enum {string} */
            mode: "full" | "incremental";
            /**
             * @description 'running' means the job is still in flight (or crashed before its terminal-failure hook ran) — finishedAtMs is null in that case.
             * @enum {string}
             */
            status: "running" | "succeeded" | "failed" | "partial";
            matchedCount: number;
            updatedCount: number;
            unmatchedCount: number;
            staleCount: number;
            skippedCount: number;
            /** Format: int64 */
            startedAtMs: number;
            /**
             * Format: int64
             * @description Null while status='running'.
             */
            finishedAtMs: number | null;
            /** @description FX4 fix wave (S2): whether this run's Stash connection had to fall back to a snapshot copy (apps/worker/src/stash/adapter.ts's readingFrom === 'snapshot' — the WAL-locked-past-retry-budget path) rather than reading the source database file directly. Null when unknown — a run finalized by the terminal-failure hook never learns the answer (no access to the failed attempt's connection), and rows written before this field existed are also null, never a false claim of 'read from source'. */
            usedSnapshotFallback: boolean | null;
        };
        /** @description One stash_scene_links row, live-read (never a report snapshot) — see getAdminStashSyncReport's own description. */
        StashSyncSceneRef: {
            /** @description Stash's own scene identifier, as a string (never assumed numeric). */
            stashSceneId: string;
            /** @description The Stash-reported file path for this scene, UNMAPPED (raw, before any library path-mapping rewrite). */
            stashPath: string;
            /**
             * Format: int64
             * @description Stash's own updated_at for this scene, converted to epoch ms; null when Stash never recorded one for it.
             */
            stashUpdatedAtMs: number | null;
        };
        StashSyncSceneRefPage: {
            items: components["schemas"]["StashSyncSceneRef"][];
            nextCursor: string | null;
        };
        /** @description FX3 fix wave (S4/S8 "both unmatched sides" law): one media_files row in the connected library with NO stash_scene_links row pointing at its item — the Loombre-side half of S4's matching set-difference (apps/worker/src/stash/matching.ts documents this as the caller's responsibility; nothing computed it until now). Live-read, same posture as StashSyncSceneRef (never a report snapshot). */
        StashSyncLoombreFileRef: {
            /** Format: uuid */
            mediaFileId: string;
            /** Format: uuid */
            itemId: string;
            /** @description The catalog item's title — what an admin needs to recognize the file. */
            itemTitle: string;
            /** @description The Loombre-side media_files.path. */
            path: string;
            /** Format: int64 */
            sizeBytes: number | null;
        };
        StashSyncLoombreFileRefPage: {
            items: components["schemas"]["StashSyncLoombreFileRef"][];
            nextCursor: string | null;
        };
        StashSyncReportEnvelope: {
            /** @description Null when no stash-sync job has ever run for this library. */
            report: components["schemas"]["StashSyncReport"] | null;
            unmatchedScenes: components["schemas"]["StashSyncSceneRefPage"];
            staleScenes: components["schemas"]["StashSyncSceneRefPage"];
            unmatchedLoombreFiles: components["schemas"]["StashSyncLoombreFileRefPage"];
        };
        /**
         * @description DERIVED, never a stored setting (RG15 — RG5's activePath wording refined at Wave-0 freeze): `none` when no path is enabled; at most one of `remote`/`tunnel`/`direct` can be enabled at a time, enforced by each path's staged enable flow returning 409 against another active path.
         * @enum {string}
         */
        RemotePathId: "none" | "remote" | "tunnel" | "direct";
        RemoteState: {
            activePath: components["schemas"]["RemotePathId"];
            wireguard: components["schemas"]["RemoteWireguardStatus"];
            tunnel: components["schemas"]["RemoteTunnelStatus"];
            direct: components["schemas"]["RemoteDirectStatus"];
        };
        RemoteWireguardStatus: {
            /** @description Configured on (a server keypair exists and enrollment is possible). */
            enabled: boolean;
            /** @description The in-process userspace UDP listener is actually live right now (RG1/RG2). */
            listening: boolean;
            /** @description remote.wireguardPort effective value. */
            listenPort: number;
            /** @description remote.subnet effective value, CIDR (RG9). */
            subnet: string;
            /** @description remote.wireguardEndpointHost effective value; null when unset. */
            endpointHost: string | null;
            peerCount: number;
        };
        RemoteWireguardDevice: {
            /**
             * Format: uuid
             * @description Same id as the underlying devices row (kind='remote', R2) — this IS that row, not a separate entity.
             */
            id: string;
            /** Format: uuid */
            userId: string;
            name: string;
            /** @description Stable address from the tunnel subnet (RG9), e.g. 10.82.146.2. */
            tunnelIp: string;
            /** Format: int64 */
            createdAtMs: number;
            /**
             * Format: int64
             * @description Null until the peer has ever completed a WireGuard handshake.
             */
            lastHandshakeAtMs: number | null;
        };
        RemoteWireguardDevicePage: {
            items: components["schemas"]["RemoteWireguardDevice"][];
            nextCursor: string | null;
        };
        EnrollRemoteWireguardDeviceRequest: {
            /** Format: uuid */
            userId: string;
            /** @description Device label, e.g. "Alex's iPhone". */
            name: string;
        };
        /** @description The one-time provisioning payload (R2/R3) — configText is shown exactly once and never retrievable again through this API (same posture as invite links); the server does not retain the private key after this response. */
        RemoteWireguardEnrollment: {
            device: components["schemas"]["RemoteWireguardDevice"];
            /** @description Standard wg-quick config text (packages/shared/src/remote/ provisioning.ts, PROVISIONING_FORMAT_VERSION), split-tunnel only (AllowedIPs = the server tunnel IP/32, R3). Render this as a QR for mobile import or offer it as a downloadable .conf for desktop WireGuard clients. */
            configText: string;
        };
        SetRemoteTunnelTokenRequest: {
            /** @description The scoped Cloudflare API token. Write-only — never returned by any endpoint. */
            token: string;
        };
        RemoteTunnelTokenValidation: {
            valid: boolean;
            /** @description Human-readable validation detail (e.g. why an invalid token failed). Never echoes the token itself. */
            detail: string | null;
        };
        EnableRemoteTunnelRequest: {
            /** @description The public hostname to route through the tunnel (a DNS route is created for it, R4). */
            hostname: string;
        };
        RemoteTunnelStatus: {
            enabled: boolean;
            /**
             * @description The supervised cloudflared child process's current lifecycle state (RG7).
             * @enum {string}
             */
            connectorState: "stopped" | "starting" | "running" | "degraded" | "error";
            hostname: string | null;
            /**
             * Format: int64
             * @description Current restart backoff (full jitter, RG7); null when not backing off.
             */
            backoffMs: number | null;
            lastErrorMessage: string | null;
            /** @description Whether a Cloudflare API token is currently stored in the keyring (write-only, R4/R9 — this field NEVER carries the token itself, by construction). ADDITIVE T1 extension to the Wave-0 frozen shape: the 6-op Tunnel surface has no other place a standing "is a token configured" read can live (setRemoteTunnelToken's 200 is an ephemeral validation-at-write-time response, not an ongoing status). */
            tokenConfigured: boolean;
            /**
             * Format: int64
             * @description When the currently-stored token was set; null when none is configured.
             */
            tokenSetAtMs: number | null;
            /** @description Whether the stored token's Cloudflare permissions were sufficient the last time they were actually checked (at set time, or at the most recent enable attempt) — null when no token is configured. NOT re-validated live on every status read (Tier-0 rule: status reads do no live network work); a token whose Cloudflare- side scopes are revoked after being stored keeps reporting true here until re-set or until a real provisioning call surfaces the truth. */
            tokenScopesOk: boolean | null;
        };
        RemoteTunnelLogs: {
            lines: string[];
        };
        TestRemoteDirectAcmeRequest: {
            domain: string;
        };
        RemoteDirectAcmeTestResult: {
            success: boolean;
            detail: string | null;
        };
        EnableRemoteDirectRequest: {
            /** @enum {string} */
            mode: "acme" | "reverse-proxy";
            /** @description Required in effect for mode=acme (422 when absent); ignored for mode=reverse-proxy. */
            domain?: string | null;
        };
        RemoteDirectStatus: {
            enabled: boolean;
            /** @enum {string|null} */
            mode: "acme" | "reverse-proxy" | null;
            domain: string | null;
            /** @description Null when mode is not acme, or no issuance has completed yet. */
            certValid: boolean | null;
            /** Format: int64 */
            certExpiresAtMs: number | null;
        };
        /**
         * @description packages/shared/src/remote/diagnosis.ts's closed classification union (R5/R6/RG11).
         * @enum {string}
         */
        DiagnosisCode: "portBlocked" | "cgnat" | "doubleNat" | "dnsMismatch" | "tunnelDown" | "connectorUnhealthy" | "unknown";
        /** @description P1 ADJUDICATION (flagged, no R/RG number covers it exactly — logged at integration): `path` was added to this Wave-0-frozen schema (additive, D23-class precedent: F2's currentPassword/R-F3's maximum bound both landed the same way) because the Tunnel-path connector-health short-circuit (the freeze's own diagnosis note) and the per-path guidance mapping (packages/shared/src/remote/ diagnosis-guidance.ts) both need to know which path is being diagnosed, and nothing server-side can safely infer it — RemotePathId's activePath is cross-lane DERIVED state this lane's isolated worktree cannot read. The wizard already knows its own current flow, so it supplies it explicitly. */
        DiagnoseRemoteRequest: {
            /** @description The public endpoint the reachability proof was bound to. */
            expectedEndpoint: string;
            /** @description Admin-supplied WAN address from a guided router-status-page instruction card (RG11 — no third-party echo service, no router APIs). */
            wanAddress?: string | null;
            /** @description Which path is being diagnosed (P1 adjudication, see this schema's own description). Must be remote/tunnel/direct — 'none' is rejected with 422 (there is nothing to diagnose when no path is even being set up). */
            path: components["schemas"]["RemotePathId"];
        };
        RemoteDiagnosisResult: {
            code: components["schemas"]["DiagnosisCode"];
            detail: string;
        };
        /** @description P1 ADJUDICATION (flagged — same reasoning as DiagnoseRemoteRequest's own description): `path` was added to this Wave-0-frozen schema so `probe_tokens.path` (migrations/0031_probe_tokens.sql — "which remote path is being proven") has somewhere to come from; a probe is always minted for one specific path's setup flow. */
        CreateRemoteProbeRequest: {
            expectedEndpoint: string;
            /** @description Which path this probe proves. Must be remote/tunnel/direct — 'none' is rejected with 422. */
            path: components["schemas"]["RemotePathId"];
        };
        /** @description The raw token appears ONLY here (R6) — embedded in probeUrl/qrPayload, never retrievable again. */
        RemoteProbeToken: {
            /** Format: uuid */
            id: string;
            /** @description https://<endpoint>/probe/<token> — the exact URL GET /probe/{token} serves. */
            probeUrl: string;
            /** @description The payload to render as a QR code (probeUrl, R6/RG8). */
            qrPayload: string;
            /**
             * Format: int64
             * @description 15-minute expiry from mint time (R6).
             */
            expiresAtMs: number;
        };
        RemoteProbeStatus: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: "pending" | "arrived" | "expired";
            /** Format: int64 */
            arrivedAtMs: number | null;
            /** @description Populated once the probe has definitively failed to arrive; null while still pending or once arrived. */
            diagnosis: components["schemas"]["RemoteDiagnosisResult"] | null;
        };
        /**
         * @description packages/shared/src/remote/posture-model.ts's frozen POSTURE_CHECK_KEYS (R7).
         * @enum {string}
         */
        RemotePostureCheckKey: "tlsValidity" | "rateLimitersActive" | "staleAccounts" | "inviteLinksReachable" | "wgPortSilence" | "connectorHealth" | "publicUrlCoherence";
        /**
         * @description packages/shared/src/remote/posture-model.ts's frozen PostureGrade. `info` is a genuine, honest grade some checks can NEVER rise above (e.g. wgPortSilence — a server can never confirm its own external silence; see apps/server/src/remote/posture/checks/ wg-port-silence.ts) — never a "pass, softened for display."
         * @enum {string}
         */
        RemotePostureGrade: "pass" | "warn" | "fail" | "info";
        RemotePostureFixAction: {
            label: string;
            /** @description An apps/web router path the admin UI can route to directly (posture-model.ts's frozen POSTURE_CHECK_FIX_ACTIONS). */
            href: string;
        };
        RemotePostureCheck: {
            key: components["schemas"]["RemotePostureCheckKey"];
            grade: components["schemas"]["RemotePostureGrade"];
            /** @description Human-readable sentence explaining this check's current grade. */
            detail: string;
            fixAction: components["schemas"]["RemotePostureFixAction"];
        };
        RemotePostureCard: {
            /** @description Empty when no remote-access path is enabled (posture-model.ts's deriveCardState: the card itself is inactive) — every active path always yields at least one applicable check, so an empty array is unambiguous and no separate "active" flag is exposed. */
            checks: components["schemas"]["RemotePostureCheck"][];
            overallGrade: components["schemas"]["RemotePostureGrade"];
            /**
             * Format: int64
             * @description When this evaluation ran — a stateless "evaluate now" read, not a cached value.
             */
            evaluatedAtMs: number;
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
    getClaimState: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The raw one-time invite token (never the hash). */
                token: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Live invite presets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimState"];
                };
            };
            404: components["responses"]["NotFound"];
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
    claimInvite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The raw one-time invite token (never the hash). */
                token: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClaimInviteRequest"];
            };
        };
        responses: {
            /** @description Claimed; account created and signed in */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenPair"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
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
    authForgotPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ForgotPasswordRequest"];
            };
        };
        responses: {
            /** @description Always this exact body, regardless of whether the account/email exists or mail is configured (anti-enumeration, E3b/E8). */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ForgotPasswordResponse"];
                };
            };
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-IP, shared with authResetPassword) */
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
    authResetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /** @description Password reset; the token is now consumed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-IP, shared with authForgotPassword) */
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
    restartServer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Restart accepted; teardown begins after this response. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerPowerActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    shutdownServer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Shutdown accepted; teardown begins after this response. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerPowerActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description This deployment's supervisor would immediately restart an exited server (container `restart: unless-stopped` — the server advertises this via its supervision environment), so an in-process shutdown cannot deliver "stays stopped." Stop the container from outside instead (`docker compose stop`). The problem `code` is `shutdown-unsupported-under-container-supervision`. */
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
    listSystemNotices: {
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
            /** @description Page of notices */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemNoticePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    publishSystemNotice: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublishSystemNoticeRequest"];
            };
        };
        responses: {
            /** @description Notice published */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemNotice"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    cancelSystemNotice: {
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
            /** @description Notice cancelled */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Unknown notice id, OR the notice is already inactive (already cancelled, or its own expiresAtMs has already passed) — "nothing left to cancel" (invites revokeInvite precedent). */
            404: {
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
    getActiveSystemNotice: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Active notice, or null when none is active */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActiveSystemNoticeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
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
    adminResetUserPassword: {
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
                "application/json": components["schemas"]["AdminResetPasswordRequest"];
            };
        };
        responses: {
            /** @description Temporary password generated; shown once */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminResetPasswordResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-user current-password attempts, self-reset only) */
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
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            /** @description Rate limited (per-user current-password attempts) */
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
            /** @description Rate limited (per-user current-password attempts) */
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
    listInvites: {
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
            /** @description Page of invites */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    createInvite: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateInviteRequest"];
            };
        };
        responses: {
            /** @description Invite created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateInviteResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    revokeInvite: {
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
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
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
    getItemChapters: {
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
            /** @description Ordered chapter markers for this item (possibly empty) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemChapters"];
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
            /** @description Page of restricted zone items (deprecated shape — superset-compatible with RestrictedBrowseItem) */
            200: {
                headers: {
                    /** @description RFC 8594 Sunset date/time — informational, no enforced removal date set yet. */
                    Sunset?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedBrowseItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getRestrictedHome: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Zone home rails */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedHome"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listRestrictedBrowse: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor from a previous page's `nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description Comma-separated performer (people.id) uuids — ANY match. */
                performerIds?: string;
                /** @description Comma-separated studio (tags.id, kind=studio) uuids — ANY match. */
                studioTagIds?: string;
                /** @description Comma-separated genre/tag (tags.id) uuids — ANY match. */
                tagIds?: string;
                ratingMin?: number;
                ratingMax?: number;
                durationMinMs?: number;
                durationMaxMs?: number;
                /** @description Comma-separated RestrictedResolutionBand values — ANY match (e.g. "FHD,UHD"). Derived per-item from the primary probed video stream's height (S5's technical authority); an item with no probed video stream never matches a non-empty filter. */
                resolution?: string;
                yearMin?: number;
                yearMax?: number;
                /** @description Defaults to `added`. `order`'s default depends on which sort is active (title: asc; added/date/rating/duration: desc). */
                sort?: components["schemas"]["RestrictedBrowseSort"];
                order?: components["parameters"]["Order"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page of restricted-zone scenes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedBrowseItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getRestrictedScene: {
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
            /** @description Scene detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedScene"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listRestrictedPerformers: {
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
            /** @description Page of zone performers */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedPerformerPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getRestrictedPerformer: {
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
            /** @description Performer detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedPerformer"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    listRestrictedPerformerScenes: {
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
            /** @description Page of the performer's zone scenes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedBrowseItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    listRestrictedStudios: {
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
            /** @description Page of zone studios */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedStudioPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getRestrictedStudio: {
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
            /** @description Studio detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedStudio"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    restrictedSearch: {
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
            /** @description Page of matching zone scenes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestrictedBrowseItemPage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getAdminLibraryStashConnection: {
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
            /** @description The library's Stash connection config + last observed status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminStashConnection"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    putAdminLibraryStashConnection: {
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
                "application/json": components["schemas"]["PutAdminStashConnectionRequest"];
            };
        };
        responses: {
            /** @description The saved connection config */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminStashConnection"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    deleteAdminLibraryStashConnection: {
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
            /** @description Connection forgotten */
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
    getAdminLibraryStashPathMappings: {
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
            /** @description The library's path mappings, in admin display order */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminStashPathMappings"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    putAdminLibraryStashPathMappings: {
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
                "application/json": components["schemas"]["PutAdminStashPathMappingsRequest"];
            };
        };
        responses: {
            /** @description The replaced path-mapping table */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminStashPathMappings"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    previewAdminLibraryStashPathMappings: {
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
                "application/json": components["schemas"]["PreviewAdminStashPathMappingsRequest"];
            };
        };
        responses: {
            /** @description Match preview against the candidate mapping set */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminStashPathMappingPreview"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    postAdminLibraryStashSync: {
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
                "application/json": components["schemas"]["PostAdminStashSyncRequest"];
            };
        };
        responses: {
            /** @description Sync job enqueued */
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
            /** @description Authenticated but not permitted. On the filesystem-permission- denied case (`code: "filesystem-permission-denied"`), the body may additionally carry a `remediation` member (FilesystemPermissionRemediation) — a scripted grant recipe for platforms with one (macOS + `_loombre` service-account installs today). `remediation` is absent on platforms without a scripted recipe (Linux/dev/container installs), where clients fall back to rendering `detail`. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"] & {
                        remediation?: components["schemas"]["FilesystemPermissionRemediation"];
                    };
                };
            };
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
    setAdminMailCredentials: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetMailCredentialsRequest"];
            };
        };
        responses: {
            /** @description Credentials stored */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description LOOMBRE_SMTP_USERNAME/LOOMBRE_SMTP_PASSWORD are both set in the environment — env wins unconditionally (same precedence as every other env-pinned value in this contract); the submitted credentials cannot take effect while the pin is active. */
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
    clearAdminMailCredentials: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Credentials cleared */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    testSendMail: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestSendMailRequest"];
            };
        };
        responses: {
            /** @description Test send enqueued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TestSendMailResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Mail is not configured yet (`mail.smtpHost`, `mail.fromAddress`, and `network.publicUrl` must all be set) — nothing was enqueued. */
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
    getAdminStashSyncReport: {
        parameters: {
            query?: {
                /** @description Opaque pagination cursor for `unmatchedScenes`, from a previous response's `unmatchedScenes.nextCursor`. */
                unmatchedCursor?: string;
                /** @description Opaque pagination cursor for `staleScenes`, from a previous response's `staleScenes.nextCursor`. */
                staleCursor?: string;
                /** @description Opaque pagination cursor for `unmatchedLoombreFiles`, from a previous response's `unmatchedLoombreFiles.nextCursor`. */
                unmatchedLoombreFilesCursor?: string;
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
            /** @description The library's latest Stash sync report, plus live unmatched/stale/unmatched-Loombre-file lists */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StashSyncReportEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
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
    getRemoteState: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Derived remote-access state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    enableRemoteWireguard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Wireguard enabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWireguardStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description A different remote-access path is already active. */
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
    disableRemoteWireguard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Wireguard disabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWireguardStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getRemoteWireguardStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Wireguard status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWireguardStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    listRemoteWireguardDevices: {
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
            /** @description Page of enrolled devices */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWireguardDevicePage"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    enrollRemoteWireguardDevice: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrollRemoteWireguardDeviceRequest"];
            };
        };
        responses: {
            /** @description Enrolled — the one-time provisioning payload */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWireguardEnrollment"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Unknown userId. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Wireguard is not enabled. */
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
    revokeRemoteWireguardDevice: {
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
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    setRemoteTunnelToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetRemoteTunnelTokenRequest"];
            };
        };
        responses: {
            /** @description Validation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteTunnelTokenValidation"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    clearRemoteTunnelToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Token cleared */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    enableRemoteTunnel: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnableRemoteTunnelRequest"];
            };
        };
        responses: {
            /** @description Tunnel enabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteTunnelStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description A different remote-access path is already active, or no valid tunnel token is stored. */
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
    disableRemoteTunnel: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tunnel disabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteTunnelStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getRemoteTunnelStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tunnel status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteTunnelStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getRemoteTunnelLogs: {
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
            /** @description Connector log tail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteTunnelLogs"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    testRemoteDirectAcme: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestRemoteDirectAcmeRequest"];
            };
        };
        responses: {
            /** @description Test issuance result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteDirectAcmeTestResult"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    enableRemoteDirect: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnableRemoteDirectRequest"];
            };
        };
        responses: {
            /** @description Direct path enabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteDirectStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description A different remote-access path is already active. */
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
    disableRemoteDirect: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Direct path disabled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteDirectStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    diagnoseRemote: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DiagnoseRemoteRequest"];
            };
        };
        responses: {
            /** @description Diagnosis */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteDiagnosisResult"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    createRemoteProbe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateRemoteProbeRequest"];
            };
        };
        responses: {
            /** @description Probe minted — the one-time token, embedded in probeUrl/qrPayload */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteProbeToken"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["UnprocessableEntity"];
            default: components["responses"]["Problem"];
        };
    };
    getRemoteProbe: {
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
            /** @description Probe status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteProbeStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Problem"];
        };
    };
    getRemotePosture: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current posture card */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemotePostureCard"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Problem"];
        };
    };
    getProbePage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The raw one-time probe token (never the hash). */
                token: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Static success page — no server info, nothing an unauthenticated caller can use for reconnaissance. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/html": string;
                };
            };
            404: components["responses"]["NotFound"];
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
}
