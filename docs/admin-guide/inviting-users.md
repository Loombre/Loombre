# Inviting people

<!-- Sourcing: invite creation/claim/revoke — apps/server/src/invites/
     invites.controller.ts (createInvite's restricted-library rejection and
     the request carrying no role/admin field at all; revokeInvite's
     404-when-nothing-left-to-revoke; formatExpiresLabel's 72h default);
     contract CreateInviteRequest/CreateInviteResponse/Invite/
     ClaimInviteRequest schemas (packages/contract/openapi.yaml) for the
     exact preset fields, expiry bounds (1h-30d, default 72h), and
     claimToken-shown-once/single-use semantics; STATE.md E2/M3/M4 (invites
     can never grant admin or restricted-library access by construction —
     no such field exists on the request at all); apps/server/src/mail/
     mail-config.service.ts + mail-dispatch.service.ts for the mail-upgrade
     behavior (a mail send is only attempted when the invite has an email
     AND mail is configured; never blocks invite creation either way). -->

Loombre never requires mail to add someone new. Whether or not you've set
up mail sending, inviting someone works the same way: you create a link,
and you hand it to them however suits you — read it out, print it, send
it in a message, whatever gets it to them.

## Send someone a link

[SCREENSHOT: Users screen showing the option to invite someone]

From the Users screen, choose the option to invite someone new. You can
optionally set their username and display name in advance — leave either
blank and the person picks their own when they open the link — and choose
which of your libraries they'll be able to see from the start (the same
library access you could grant anyone else afterward, from this same
screen).

[SCREENSHOT: Invite setup form showing the optional presets and library access]

Once you create it, Loombre shows you the link exactly once, with a
button to copy it.

[SCREENSHOT: Invite created, showing the one-time link and copy button]

That's the whole thing — no email required, no account of theirs
anywhere yet. Copy the link and hand it over however you like: read it to
them, write it down, send it in a text or a chat message, whatever's
easiest. The person opens the link, picks a password (and a username, if
you didn't set one for them), and they're signed in immediately.

## If you've also set up mail

If you've configured mail (see [Mail](mail.md)) and give the invite an
email address, Loombre can send that same link by email for you as well.
It's entirely optional — nothing about inviting someone requires it, and
the copy-link option above always works, with or without mail.

## Expiry and single use

An invite link expires on its own — 72 hours after you create it, by
default, though you can choose anywhere from one hour to thirty days when
you set it up. It's single-use: the moment someone claims it, or the
moment you revoke it, that link stops working for anyone else.

[SCREENSHOT: Pending invites list with a revoke action]

You can see every invite that hasn't been claimed yet from the Users
screen, and revoke any of them before they're used — for instance, if you
sent it to the wrong person, or simply changed your mind. A revoked or
already-claimed link can't be un-revoked or reused; you'd create a new
one instead.

## What an invite link can never do

An invite link can never make someone an administrator, and it can never
grant access to a restricted library, no matter what you preset or what
the person does when they claim it — a link that can leave your hands
must never be able to hand over more power than the link itself carries.
If the new person needs either of those, grant it afterward yourself from
the Users screen, the exact same way you would for anyone already on your
Loombre.

## See also

- [Users & permissions](users-permissions.md) — granting library access
  and administrator rights after the fact, and what to do if someone
  forgets their password.
- [Mail](mail.md) — setting up mail sending, entirely optional.
