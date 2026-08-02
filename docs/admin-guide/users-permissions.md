# Users & permissions

<!-- Sourcing: user CRUD + per-library permission grants via a single
     library-scoped endpoint, restricted-grant note shown whenever a user's
     library list includes a restricted library ("gate 4 of 5") —
     apps/web/src/app/admin/users/page.tsx header comment. Five-gate model
     for restricted content — docs/PLAN.md §6.4 (linked in full from the
     User Guide's restricted-content page; summarized here from the admin
     side only). Optional mail transport + invitation & reset flows run:
     contract CreateUserRequest (email now nullable, M1) — apps/server/src/
     catalog/users.controller.ts's createUser header; admin/CLI password
     recovery — apps/server/src/catalog/users.controller.ts's
     resetUserPassword (temporary password shown once, must_change_password,
     every refresh token revoked, non-fatal security-notice mail when
     configured and an email is on file) and apps/server/src/cli/
     admin-reset-password.ts (the CLI twin, actor "cli"); STATE.md
     E3a/E4/M1/M14 for the email-optional framing and the two-tier
     recovery design. -->

## Adding people

From the Users screen, choose **+ Add user** to create an account for
someone else in your household yourself, right now — you choose their
username and set an initial password together. Adding an email address
is optional: without one, the account works exactly the same, except
that person won't be able to recover a forgotten password themselves
even once mail is set up (see "[Resetting a password](#resetting-a-password)"
below for the alternative either way). They can change their own
password, and add or remove their email address, once signed in.

If you'd rather hand them a link and let them choose their own username
and password instead of setting it up yourself, see
[Inviting people](inviting-users.md).

[SCREENSHOT: Users list with + Add user button]
[SCREENSHOT: Create user modal]

## Library access

Nobody — not even another admin — can see a library until you explicitly
grant them access to it. Open a user's **Library access** to see every
library and toggle which ones they can see. The one exception: the admin
who *created* a **general** library is automatically granted access to it
at creation time. A **restricted** library is never auto-granted to
anyone — including its creator — so after creating one, grant yourself
access here the same way you'd grant anyone else.

[SCREENSHOT: Per-user library access editor]

## Restricted libraries — what a grant does, and doesn't, do

Granting someone access to a restricted library is **one of several
required steps**, not the whole story — full detail on all of them is in
the User Guide's [Restricted content](../user-guide/restricted-content.md)
page, written for the person using the account. From the admin side, your
part is:

1. Turning on restricted-content support for the server at all (a
   one-time, server-wide setting).
2. Granting the specific user access to the specific restricted library,
   from this screen.

Even with both of those done, the user still needs to be an adult (by
birth date on file) and choose to opt in themselves, with their own PIN
that you cannot see or set. When a user's library list includes a
restricted library, the permissions editor shows a reminder of this —
your grant is necessary but not sufficient by itself, by design.

[SCREENSHOT: Library access editor showing the restricted-grant reminder note]

## Removing access or an account

Toggle a library off in the same **Library access** editor to revoke it,
or delete a user's account entirely from the Users screen if they should
no longer have any access at all.

## Resetting a password

If someone forgets their password, you can reset it for them from the
Users screen — no need to know or guess what it was. Loombre generates a
brand new, temporary password and shows it to you once, with a copy
button; write it down or hand it straight over, because there's no way
to see it again afterward.

[SCREENSHOT: Users screen showing the reset-password action, and the resulting temporary password shown once]

Hand the temporary password to whoever needs it. The next time they sign
in, Loombre requires them to choose a real password of their own before
they can do anything else — and every device they were previously signed
in on is signed out immediately, so the reset takes effect everywhere at
once, not just on whichever device signs in first.

If mail is configured (see [Mail](mail.md)) and the person has an email
address on file, Loombre also sends them a short notice that their
password was reset — informational only; it never contains the temporary
password itself.

Prefer not to use a screen at all? The exact same reset is available to
whoever runs your Loombre server directly — see the Operator Guide's
[password-reset recovery steps](../ops/cli.md#forgot-a-password).

## If someone tries to use an email address already on another account

People add or change their own email address from their own account
settings — or from a claim link, when they first join. If the address
they try turns out to already be on somebody else's account here, Loombre
doesn't hand that account over, and it doesn't tell the person trying
anything different — their sign-up or change goes through exactly the
same as it always does, just without that particular address attached.

If mail is configured (see [Mail](mail.md)), the person who actually owns
that address gets a short, informational notice letting them know someone
tried to use it — at most one such notice per address per day, so it can
never be turned into a nuisance. Without mail configured, no notice goes
out at all; the person trying still sees no difference either way.

## Forgot PIN?

Nobody administering Loombre can see or set someone else's restricted-
content PIN — but whoever runs the server itself can reset it. Resetting
clears it completely and turns off that person's opt-in; they simply
choose a brand new PIN the next time they turn restricted content back on.
There's no screen for this here by design — see the Operator Guide's
[PIN-reset recovery steps](../ops/cli.md#forgot-a-pin) for exactly how.
