# Browsing the restricted zone

<!-- Sourcing: the zone's nav hub (Browse/Performers/Studios/Search tiles,
     running item count) — apps/web/src/app/restricted/page.tsx. Browse
     with combinable filters (performers, studios, genres, rating, length,
     picture quality, year) and sort (Recently Added, Release Date, Title
     A-Z, Highest Rated, Duration) — apps/web/src/lib/zone-browse-filters.ts
     (ZONE_SORT_OPTIONS, ZONE_RESOLUTION_BANDS) and
     apps/web/src/components/restricted/ZoneFilterBar.tsx. "Clear search &
     filters" reset on an empty filtered result —
     apps/web/src/components/restricted/RestrictedZoneEmptyState.tsx. Poster
     wall vs detailed rows toggle, remembered per device only —
     apps/web/src/components/restricted/ZoneDensityToggle.tsx +
     apps/web/src/lib/zone-density-prefs.ts. Poster wall shows title + year;
     detailed rows additionally show rating, studio, length, picture
     quality, and genres — apps/web/src/components/restricted/
     ZonePosterCard.tsx + ZoneDetailedRow.tsx. Performer page (name, scene
     count, filmography) and studio page (logo, name, scene count, full
     catalog) — apps/web/src/app/restricted/performers/[id]/page.tsx and
     apps/web/src/app/restricted/studios/[id]/page.tsx. Scene page (cover,
     release year, rating, length, quality, studio, description, performer
     and tag chips, chapter markers list, Play) —
     apps/web/src/app/restricted/scenes/[id]/page.tsx. Zone-scoped search,
     debounced, separate from general search — apps/web/src/app/restricted/
     search/page.tsx. -->

Once you've unlocked restricted content (see
[Restricted content](restricted-content.md)), it works like its own
separate space inside Loombre — its own home, its own way of looking
through what's there, and its own search, kept apart from your regular
library the whole time.

## Getting around

From the zone's home, you'll find your way to everything else it offers:
**Browse**, **Performers**, **Studios**, and **Search**, along with a
running count of how much is in the zone right now.

[SCREENSHOT: Restricted zone home, showing the section tiles and item count]

A **Lock now** button is always available here too, in case you'd rather
put the zone away before it locks on its own — see
[Restricted content](restricted-content.md) for how locking and unlocking
work.

## Browsing with filters and sorting

Selecting **Browse** shows you everything visible in the zone, with a
filter bar across the top. You can narrow what you're looking at by any
combination of: people, studios, genres, rating, length, picture
quality (from standard definition up through ultra high definition, or
4K), and release year — and combine as many of these at once as you like.

[SCREENSHOT: Browse view for the restricted zone, showing the filter bar and poster wall]

Alongside the filters, a sort control puts results in the order you want:
Recently Added, Release Date, Title A–Z, Highest Rated, or Duration. If a
particular combination of filters comes up empty, a **Clear search &
filters** option resets everything in one step.

## Wall or list — your choice

Next to the sort control, a small toggle switches how results are shown:

- **Poster wall** — just the artwork and a title, for browsing by look.
- **Detailed rows** — a smaller thumbnail alongside more at a glance:
  rating, studio, length, picture quality, and genres for each title.

Whichever you pick stays that way on this device the next time you come
back — it isn't something you need to set again every visit, and it
doesn't follow you to another device.

[SCREENSHOT: Detailed rows view of the restricted zone browse screen]

## Performers and studios

Selecting **Performers** or **Studios** gives you a searchable list of
everyone and everywhere credited on something visible in the zone, each
showing how many scenes they appear in.

Selecting a performer opens their own page: their name, how many scenes
they're in, and the full list of those scenes, so you can see everything
they've been credited on in one place.

[SCREENSHOT: A performer's page showing their scene count and filmography]

Selecting a studio opens its own page the same way — its logo where one
is available, its name, and its full catalog of scenes.

[SCREENSHOT: A studio's page showing its logo and catalog]

## Looking at a scene

Selecting anything in the zone opens its own page: cover art, release
year, rating, length, and picture quality, its studio (select it to see
everything else from that studio), a description, and — where they
apply — chips for each performer and tag, so you can select a performer
to see everything else they're in.

[SCREENSHOT: A scene's detail page showing its description, performer chips, and Play button]

If Loombre knows about named moments within a scene, you'll also see a
**Chapters** list underneath it — each one showing a title and a time, so
you can see at a glance what a scene covers before you start watching.

## Searching the zone

**Search**, inside the zone, works separately from your regular search —
results appear as you type, and cover titles, performers, studios, and
tags, but only ever within the zone itself. Nothing you find here ever
mixes with, or shows up in, your everyday search.

[SCREENSHOT: Zone search showing live results as you type]
