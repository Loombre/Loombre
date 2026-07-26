# Jobs dashboard

<!-- Sourcing: cursor-paged newest-first job list, live in-place updates
     over the admin events connection (no polling while connected),
     progress tracked separately from the stored job record — apps/web/src/
     app/admin/jobs/page.tsx header comment. -->

Scanning a library, fetching a title's details, and preparing video for
playback all happen as background jobs — work Loombre does outside of a
direct request, so the rest of the server stays responsive. The Jobs
screen lets you watch this work happen.

[SCREENSHOT: Jobs dashboard, list of jobs with status pills]

## What you'll see

Jobs are listed newest first. Each one shows:

- **What kind of job it is** — a library scan, a metadata lookup, image
  preparation, and so on.
- **Status** — queued, running, completed, or failed, shown as a colored
  status pill.
- **Progress**, while a job is actively running.

The list updates live while you have this screen open — you don't need
to refresh the page to see a job move from queued to running to
completed.

[SCREENSHOT: A job in progress, showing live progress update]

## When a job fails

A failed job shows its status clearly, along with the reason it failed
where one is available. This is often the fastest way to understand why,
for example, a scan didn't pick up a file you expected — check here
before assuming something is silently broken.

[SCREENSHOT: A failed job showing its status and reason]
