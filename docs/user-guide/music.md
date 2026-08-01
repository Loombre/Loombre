# Listening to music

<!-- Sourcing: mini-player bar + queue as real, implemented UI —
     apps/web/src/components/music/MiniPlayerBar.tsx,
     apps/web/src/components/music/QueueDrawer.tsx,
     apps/web/src/components/music/MusicPlayerProvider.tsx. Music as v1
     scope — docs/PLAN.md §1. -->

Music in Loombre works a little differently from movies and shows — it's
built to keep playing in the background while you keep browsing.

## Browsing your music

Open **Browse** and select your Music library's pill to see your artists
and albums. Select an artist to see everything by them, or an album to
see its track list.

[SCREENSHOT: Album detail page showing track listing]

## Playing music

Select a track or an album to start playing. A small player bar appears
and stays visible near the bottom of the screen — you can keep browsing
your library, or even switch to a movie or show, while your music keeps
playing.

[SCREENSHOT: Mini player bar visible at the bottom of the screen while browsing]

## The queue

Open the queue from the player bar to see what's playing now and what's
coming up next. From there you can reorder upcoming tracks or remove ones
you don't want to hear.

[SCREENSHOT: Queue view showing now-playing and upcoming tracks]

## Restricted music

Restricted libraries (see [Restricted content](restricted-content.md))
are a movies-and-TV feature today — the Restricted zone screen lists
movies and series only, so a music library can't currently be browsed
there even if it's marked restricted.
