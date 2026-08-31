# Capability report

<!-- Sourcing: the System section's six cards (SystemInfo, CapabilityReport,
     update notice, provider-keys notice, crash files, logs tail) —
     apps/web/src/app/admin/page.tsx header comment (D-5 IA restructure:
     the former /admin/system page was merged into the admin Dashboard as
     its "System" section, composed from apps/web/src/components/admin/
     system/*.tsx; /admin/system is now a redirect back to /admin).
     Capability report shape (backends x decode/encode/tone-mapping
     matrix, probe age, hardware-conversion software version identifier)
     and "null envelope rendered honestly" (no probe run yet is shown as
     such, not hidden or faked) — the CapabilityReport card's own header
     comment. -->

The **System** section, near the bottom of the admin **Dashboard**, tells
you what Loombre has figured out about the machine it's running on —
useful when you're trying to understand why playback behaves a certain
way, or before reporting a problem.

[SCREENSHOT: The Dashboard's System section showing all cards]

## System (the "System" card)

Version, operating system, performance tier, and how long the server has
been running.

## Capability report (the "Verified hardware capabilities" card)

This is the detailed part: what Loombre's hardware probe found. It shows,
for each conversion backend available on this machine, what it can play
back directly and what it can convert in hardware versus needing to fall
back to software. It also shows how long ago this probe last ran and a
short identifier for the conversion software version in use — useful when
comparing notes with someone else or reporting a problem.

If no probe has run yet, this card says so plainly instead of showing
blank or misleading information.

[SCREENSHOT: Capability report card, populated]
[SCREENSHOT: Capability report card, no probe run yet]

## Update notice

Tells you whether a newer version of Loombre is available. Loombre never
installs an update automatically — this is informational only. If the
update information couldn't be verified as authentic, this is shown as a
clear warning rather than silently trusted or hidden.

## Metadata provider keys

Shown only while no metadata-provider API key is configured on this
instance. TMDB/TVDB enrichment (posters, overviews, cast) is inactive
until at least one key is set — a scan without one still completes, just
with no provider metadata or images. The card's **Configure provider
keys** link takes you to the settings screen where keys are entered.

## Crash files

If Loombre has crashed, a record is kept locally on this machine (never
sent anywhere) — this card lists them, lets you view one, and download it.
To open the folder they're stored in directly, use the tray or menubar
app installed alongside Loombre, if you have one; this screen can only
show you the contents, not open a folder on your computer.

[SCREENSHOT: Crash files list and viewer]

## Logs

A tail of the server's recent log lines, with a choice of how many lines
to show and an optional auto-refresh toggle.
