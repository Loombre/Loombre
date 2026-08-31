# Plugins

<!-- Sourcing: apps/web/src/components/admin/plugins/RegisterPluginWizard.tsx
     (registration wizard: address entry, confirmation screen, config step,
     event-grant step, health-check result, HMAC-shown-once, "cancel"
     removes the just-registered plugin, "enable anyway" leaves it as
     registered), CapabilityCard.tsx + lib/plugin-manifest.ts
     (describeMetadataProviderScope/describeEventSubscriberScope — the
     exact per-capability privacy copy quoted below verbatim,
     describePluginStatus — the status-pill wording), PluginConfigForm.tsx
     (auto-rendered config form, write-only secret fields), EventGrantsEditor.tsx
     (event-grant editor: requested vs. granted), apps/web/src/app/settings/
     plugins/[id]/PluginDetailScreen.tsx (detail page: enable/disable,
     "Check for updates" -> re-approval, HMAC rotation, delivery-status
     panel, pseudonymization toggle, remove; the old /admin/plugins route
     is a redirect to /settings/plugins), apps/web/src/lib/plugin-delivery-status.ts
     (delivery-status copy, gap-notice wording), apps/web/src/components/
     admin/libraries/ProviderChainEditor.tsx + lib/library-provider-chain.ts
     (per-library provider-chain editor: default/customize, reorder,
     add/remove, content-class-filtered plugin choices).
     Server behavior/constants: apps/server/src/plugins/plugin-health.service.ts
     (health-check model: manifest re-fetch, benign canary search, delivery-
     endpoint reachability check only), packages/plugin-host/src/breaker.ts +
     timeouts.ts (circuit breaker: 5 consecutive failures auto-disables,
     60-second reset before one trial call is let through),
     packages/plugin-host/src/ssrf.ts (LAN allowlist: exact hostname/IP
     match, no wildcards; disallowed-range list), apps/server/src/plugins/
     plugin-registration.service.ts (registration/refresh/re-approval state
     machine — any scope expansion auto-disables pending re-approval),
     plugin-lifecycle.service.ts (enable/disable/rotate-hmac/remove;
     removal clears every keyring secret), plugin-keyring.ts (secret
     values are write-only, never re-shown after the moment they're
     minted/rotated), scope.ts (content-class scoping: a plugin's scope
     must equal a library's exactly), apps/worker/src/plugin-delivery/
     constants.ts (7-day delivery backlog window, 100-event batch cap).
     packages/plugin-protocol/spec/lpp-v1.md §0 (process-model posture: no
     code loading, no telemetry). -->

A **plugin** is a separate program — running on the same computer, somewhere
else on your home network, or out on the internet — that Loombre talks to
over the web, the same way your browser talks to a website. Loombre never
downloads, installs, or runs a plugin's code itself: it only ever sends the
plugin a request and reads back its answer. If a plugin's program
disappears entirely, nothing about Loombre itself breaks — the things that
plugin was doing (looking up show details, say) simply stop happening.

Loombre calls each specific thing a plugin can do a **capability** — for
example, looking up information about your movies and shows is one
capability; sending a feed of what's happening on your server somewhere
else is another. A single plugin can offer more than one capability, and
you choose which of them to actually turn on when you register it.

Two kinds of capability exist today:

- **Metadata provider** — looks up titles, descriptions, and artwork for
  your media, alongside (or instead of) Loombre's built-in sources.
- **Activity feed subscriber** — receives a feed of things happening on
  your server (a show being added, someone starting to watch something),
  so it can forward that somewhere else — a chat notification, a
  scrobbling service, and so on.

## Registering a plugin

From the Plugins screen, choose **Register a plugin** and enter its web
address. Nothing is saved yet — Loombre first reads what the plugin
declares about itself and shows you a confirmation screen before anything
is registered.

[SCREENSHOT: Register plugin wizard, address entry step]

If the plugin runs somewhere on your own home network rather than the open
internet, there's an optional field for that too: list its exact address
(for example `192.168.1.50` or `plugin-box.local`). Loombre refuses to
reach private network addresses on a plugin's behalf unless you allow them
here, by their exact name — there's no partial matching, so a typo simply
means the address isn't allowed.

### The confirmation screen

Next, Loombre shows every capability this plugin has declared, with a
plain-language line explaining what it means for your library and your
privacy (see [What each capability can see](#what-each-capability-can-see)
below) — turn off anything you don't want to allow before continuing. If
the plugin asks to receive an activity feed, the next step lets you choose
exactly which kinds of activity it actually gets (see
[Choosing what a plugin can see](#choosing-what-a-plugin-can-see)).

[SCREENSHOT: Registration confirmation screen, capability cards with privacy lines and grant toggles]

If the plugin needs any configuration — an address to send notifications
to, a service key, and so on — you'll fill that in next (see
[Configuration and secrets](#configuration-and-secrets)).

### The signing secret

Once you register, Loombre shows a one-time secret value — used so an
activity feed subscriber can verify that a delivery genuinely came from
your Loombre server and hasn't been tampered with in transit. **This value
is shown exactly once, right here.** Copy it now if the plugin needs it;
Loombre never displays it again afterward (you can always mint a fresh one
later — see [Rotating the signing secret](#rotating-the-signing-secret)).

[SCREENSHOT: Registration result screen, signing secret shown once with copy button]

Finally, Loombre runs a quick check to confirm the plugin is actually
reachable and working. If that check fails, you're offered a choice: keep
the plugin registered and try again later, or remove it now. If it
succeeds, registration is done.

## What each capability can see

Every capability card on the confirmation screen (and on a plugin's own
page afterward) carries an exact, plain-language statement of what that
plugin can see and do — reproduced here verbatim:

**Metadata provider**, on a general library:

> Can look up titles, years, and other identifying details for [the kinds
> of media it declares] in any library it's attached to, and sends back
> matched descriptions and artwork for them. It never sees anything about
> who's watching or listening. It can be used on any library, restricted
> or not.

**Metadata provider**, restricted to your restricted-content libraries:

> Can look up titles, years, and other identifying details for [the kinds
> of media it declares] in any library it's attached to, and sends back
> matched descriptions and artwork for them. It never sees anything about
> who's watching or listening. It only ever sees restricted libraries —
> never a general one.

**Activity feed subscriber**, on general activity:

> Receives the activity feed events you choose to send it — nothing more
> than what you grant below. By default, who did something is shown as an
> anonymous id, not a real account. It never receives activity involving
> restricted content.

**Activity feed subscriber**, scoped to restricted-content activity:

> Receives the activity feed events you choose to send it — nothing more
> than what you grant below. By default, who did something is shown as an
> anonymous id, not a real account. It only ever receives activity
> involving restricted content if you grant that on purpose.

A plugin's restricted-or-general scope is fixed by the plugin itself (it's
part of what it declares) — you can't mix the two for one capability. A
general-scoped plugin is simply never offered restricted-library data or
restricted-content activity through any capability, full stop.

### Who gets credited

By default, when Loombre tells an activity feed subscriber that someone
did something, it uses an anonymous id rather than a real account name —
the same real account always gets the same anonymous id *for that one
plugin*, but that id can't be traced back to a real account, and a
different plugin sees a completely different anonymous id for the very
same account. This is on by default for every activity feed subscriber.

Each subscriber's own page has a toggle to turn this off and send real
account ids instead, if you have a specific reason to (a scrobbling
service that needs to tell users apart, for example). Turning protection
back on needs no confirmation; turning it off does, because it's the
direction that exposes more:

> Send real account ids to "*plugin name*" instead of anonymous ones? This
> takes effect for everything delivered from now on.

[SCREENSHOT: Plugin detail page, "Who gets credited" pseudonymization toggle]

## Configuration and secrets

If a plugin needs any settings — an address, a mode, a key — Loombre builds
the form for it automatically from what the plugin itself declares; there's
never a hand-built form to keep in sync. Ordinary fields (addresses,
numbers, on/off switches) work exactly like any other settings field.

Fields the plugin marks as sensitive (an access key, for instance) are
handled differently: they're **write-only**. You can type a value in, but
once it's saved, Loombre never shows it back to you again — not on this
screen, not anywhere else. The stored value lives in your operating
system's own secure credential store, not in Loombre's regular settings.
Editing a plugin's configuration later, an empty sensitive field simply
means "leave whatever's already stored alone" — you only need to type a
new value if you're actually changing it.

[SCREENSHOT: Plugin config form showing an ordinary field and a write-only secret field]

## Choosing what a plugin can see

An activity feed subscriber's manifest *asks* for certain kinds of
activity — but asking isn't the same as receiving. The event-grant editor
lists everything the plugin has requested, unchecked by default; only the
ones you explicitly check are ever sent to it. You can change your mind at
any time from the plugin's own page — anything you uncheck simply stops
being sent from that point on.

[SCREENSHOT: Event grants editor, requested activity types with grant toggles]

### Delivery status

An activity feed subscriber's own page shows whether deliveries are
actually getting through: how many events it's received and when the last
one landed, or a plain notice — "Hasn't delivered anything yet." — if
nothing has gone out yet. If a plugin has been unreachable for several
attempts in a row, a warning names the streak and when Loombre last tried.
Loombre keeps a short backlog of activity for a subscriber that's
temporarily unreachable and delivers it once the plugin comes back — but
if a plugin is unreachable for longer than that backlog covers, the oldest
part of it is given up on rather than kept forever, and the same panel
tells you so rather than pretending nothing was missed.

[SCREENSHOT: Plugin detail page, delivery status panel with failure warning]

## Provider chains per library

Each library has an ordered list of metadata sources it tries, one after
another, until one of them has a match — this is the **provider chain**.
Every library starts out using Loombre's own built-in default order for
its kind of media (movies, TV, or music); you don't have to do anything
for that to work.

Open a library's provider chain from the Libraries screen to see that
default order, and choose **Customize this chain** if you want to change
it just for that one library — reorder entries by dragging (or with the
up/down buttons, if you'd rather), remove one, or add another. You can add
any of Loombre's built-in sources, plus any registered metadata-provider
plugin that's eligible for *this* library specifically.

[SCREENSHOT: Provider chain editor, customized chain with drag-reorder rows]

A plugin only ever shows up as eligible for libraries that match its own
restricted-or-general scope exactly — a plugin scoped to restricted
libraries never appears as a choice for a general one, and vice versa, for
the same reason described above. If a plugin you expected to see isn't in
the list, that's why. Nothing is saved until you choose **Save**; clearing
every entry reverts the library back to Loombre's built-in default.

## Health, and being turned off automatically

Loombre confirms a plugin is actually working when you register it, when
it's re-approved, and periodically in the background afterward — every few
minutes for as long as a plugin stays turned on — re-reading what it
declares about itself and, for a metadata provider, sending it a harmless
test lookup. You'll see the outcome reflected as a status next to the
plugin's name: enabled and healthy, enabled but currently unhealthy, or
disabled, with a reason. This background check means a plugin that quietly
stops working shows up as unhealthy on its own, without you needing to
open its page and ask.

Beyond those checks, ordinary use is what Loombre actually watches too:
every real lookup a metadata provider is asked to do, and every real
delivery sent to an activity feed subscriber, counts toward the same
failure tally — an error response counts as a failure exactly like a
plugin that doesn't answer at all. If a plugin fails enough times in a row
this way — five consecutive failures — Loombre turns it off automatically
rather than letting it keep holding things up, and shows it as
**Disabled (too many failures)**. No plugin, however broken or slow, can
stall a library scan, a page load, or anything else waiting on it;
Loombre simply stops trying and moves on.

To bring a disabled-by-failure plugin back, open its page and choose
**Enable** — this also resets its failure count, so it gets a fresh run at
proving it's working again.

[SCREENSHOT: Plugin detail page showing a "Disabled (too many failures)" status with the Enable button]

## Plugins on your home network

By default, Loombre refuses to send plugin traffic to an address on your
own local network or on the server's own machine — the same protection
that keeps a plugin from being tricked into probing your router, your
other home devices, or Loombre's own internals under the guise of "just
talking to a plugin." This is deliberate and applies even though the
plugin itself is something you chose to register.

If you're actually running a plugin on your home network on purpose — a
small box in a closet, a program on the same machine as Loombre, and so
on — list its exact address in the **Local network addresses to allow**
field when you register it. Only addresses listed there, matched exactly,
are ever allowed; there's no wildcard or range shorthand, so each address
you want to use has to be listed by name. This list is set at registration
time and carried forward automatically if the plugin is later refreshed or
re-approved.

## Rotating the signing secret

If you ever suspect a plugin's signing secret has been exposed, or just
want a fresh one, open the plugin's page and choose **Rotate secret** under
its delivery-secret section. Loombre asks you to confirm (the plugin will
need to be reconfigured with the new value before deliveries verify
correctly again), then shows the new value — once, exactly the same way as
at registration. The old value stops working immediately.

## When a plugin asks for more

A plugin's own program can change over time — a new version might add a
capability, ask to see more kinds of media, or request a wider slice of
your restricted-content library than what you originally approved.
Choosing **Check for updates** on the plugin's page re-reads what it
currently declares and compares it against what you approved; if it now
asks for more, Loombre treats that exactly like a brand-new registration
request: the plugin is turned off and marked **Needs re-approval** until
you look it over.

[SCREENSHOT: Plugin detail page, "Needs re-approval" banner with review action]

Choosing **Review what changed** shows you what's different, in the same
capability-card format the original registration used — approve the parts
you're comfortable with (and nothing else) to bring the plugin back on. If
the plugin's request shrinks or stays the same instead of growing, Loombre
simply applies that quietly, with nothing for you to approve.

## Removing a plugin

Open the plugin's page and choose **Remove**. Loombre asks you to confirm,
since this can't be undone — removing a plugin deletes its registration
and every secret it had stored (its signing secret and any configuration
secrets alike). Nothing about the plugin's own program is affected; it
simply stops being registered with your server.
