# Mail

<!-- Sourcing: mail.smtpHost/mail.smtpPort/mail.smtpSecurity/
     mail.fromAddress/mail.fromName + network.publicUrl registry entries
     (packages/shared/src/settings-registry.ts) for the five fields, the
     "none" security caution text, and the public-address description;
     MailConfigService.isConfigured()/publicUrl() (apps/server/src/mail/
     mail-config.service.ts) for the "host + from-address + public address,
     credentials optional" configured-definition; AdminMailController's
     PUT/DELETE /admin/mail/credentials and POST /admin/mail/test-send
     (apps/server/src/mail/admin-mail.controller.ts) for the credentials
     being separate from the five settings and the test-send ordering
     (live-admin check, then "not configured" before "bad address"),
     always enqueuing a real job, never sending inline; MailDispatchService.
     trySend + the mail-send job's terminal-failure hook + mail.failed
     event schema for "never blocks, and a real failure surfaces on the
     Jobs screen"; STATE.md E1/E5/E6/E7/E9/M8/M9/M10/M11 for the
     no-mail-required law, the provider-neutral generic-SMTP design, and
     the docs register rule for the provider table (source-verified
     against each provider's own documentation — each provider row in the
     table below links that provider's own SMTP documentation inline;
     the verification landing is recorded in root STATE.md's E9 docs
     entry). -->

Setting up mail is completely optional. Every part of Loombre — inviting
someone, recovering a forgotten password — works without it, by handing
along a link or a temporary password yourself instead (see
[Inviting people](inviting-users.md) and the "[Resetting a
password](users-permissions.md#resetting-a-password)" section of Users &
permissions). Configuring mail just lets Loombre send those same things
by email automatically, and lets people recover their own forgotten
password without asking you at all.

## The five things Loombre needs

Wherever your mail server lives — a service built for exactly this, your
own mail server, or one your internet provider runs — Loombre asks for
the same five things, all in one place:

1. **The mail server's address.** Where Loombre connects to send mail.
2. **The port.** Which door on that address to knock on — 587 is the
   common choice.
3. **Connection security.** Whether the connection starts encrypted, or
   starts plain and is upgraded partway through, or — rarely, and only
   for a mail server on your own private network — isn't encrypted at
   all.
4. **Sign-in details**, if your mail server needs them. A username and
   password, kept separately from everything else and never shown again
   once saved. Some private, same-network mail servers need no sign-in
   at all, which is a legitimate choice too.
5. **The from-address**, the address your mail appears to come from, and
   an optional from-name to go alongside it.

None of this is provider-specific — the same five fields work for every
provider in the table below, and for a private mail server too.

[SCREENSHOT: Mail settings screen showing the five fields]

## Your server's own public address

Alongside the five settings above, Loombre also needs to know the web
address people use to reach your server from outside your own network —
set once, separately, as your server's public web address. Every link
Loombre puts in an email — an invitation, a password reset — is built
from that address alone, deliberately, so the link works no matter who
opens the email or where they open it from. Leave it blank, and Loombre
won't send any mail at all, even with everything else above filled in.

[SCREENSHOT: Mail settings screen showing the public address field]

## Sending a test message

Once you've filled in the settings above, a **Send test email** button
sends a real message through your own mail server, the same way an
invitation or password-reset email goes out — a genuine end-to-end check,
not a simulation. If it succeeds, a real email arrives. If it fails, the
reason — whatever your mail server actually said — shows up right there,
and again later on the [Jobs](jobs-dashboard.md) screen if you want to
check back.

[SCREENSHOT: Send test email button, and a failed test showing the mail server's error]

## Choosing a mail provider

For anything beyond these five settings — creating an account, verifying
a domain, raising a sending limit — each provider's own current
instructions are one click away below; those details change on their own
schedule, so this page doesn't try to repeat them.

| Provider | Server address | Port | Connection security | The one thing to know |
|---|---|---|---|---|
| [Brevo](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP), [SMTP2GO](https://developers.smtp2go.com/docs/smtp-relay), or [Mailgun](https://documentation.mailgun.com/docs/mailgun/user-manual/smtp-protocol/smtp-relay) — services built for exactly this, recommended if your Loombre is reachable from the internet | Brevo: `smtp-relay.brevo.com` · SMTP2GO: `mail.smtp2go.com` · Mailgun: `smtp.mailgun.org` | 587 | Starts plain, upgrades to encrypted | Sign in with credentials generated inside that service's own account — not the password you use to log into the service itself. All three offer a free tier (roughly 100–1,000 messages a month depending on which one), plenty for invitations and password resets on a household server. |
| [Gmail or Google Workspace](https://support.google.com/accounts/answer/185833) | `smtp.gmail.com` | 587 | Starts plain, upgrades to encrypted | Requires two-factor sign-in turned on for the account first; the sign-in password Loombre uses is a separate 16-character "app password" generated afterward, not the regular account password. |
| [Outlook.com or Microsoft 365](https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365) | `smtp.office365.com` | 587 | Starts plain, upgrades to encrypted | On a Microsoft 365 account, this kind of sign-in is switched off by default and has to be turned on for the mailbox first, by whoever administers that Microsoft 365 account. |
| [Fastmail](https://www.fastmail.help/hc/en-us/articles/1500000279921-IMAP-POP-and-SMTP) | `smtp.fastmail.com` | 587 | Starts plain, upgrades to encrypted | Requires a separate app password generated for Loombre specifically — not available on Fastmail's most basic plan tier. |
| [Proton Mail](https://proton.me/mail/bridge) | `127.0.0.1` (Loombre's own server) | 1025 | Starts plain, upgrades to encrypted | Needs Proton's own Bridge program installed and left running on the same machine as Loombre — Bridge is what Loombre actually talks to, not Proton directly — and a paid Proton plan. |
| [iCloud Mail](https://support.apple.com/en-us/102525) | `smtp.mail.me.com` | 587 | Starts plain, upgrades to encrypted | Requires two-factor sign-in turned on for the Apple Account first, then a separate "app-specific password" — the regular Apple Account password won't work. |
| Your own mail server, or one your internet provider runs | Ask whoever runs it | Ask whoever runs it | Ask whoever runs it | The same five settings above are all it needs — there's no separate convention to follow. |

## See also

- [Inviting people](inviting-users.md) and the "[Resetting a
  password](users-permissions.md#resetting-a-password)" section of Users
  & permissions — what mail sends automatically once it's set up.
- The "[If someone tries to use an email address already on another
  account](users-permissions.md#if-someone-tries-to-use-an-email-address-already-on-another-account)"
  section of Users & permissions — another notice mail sends automatically,
  and the honest delta when mail isn't configured at all.
- The Operator Guide's [mail deliverability notes](../ops/mail-notes.md) —
  the technical side of getting mail actually delivered, not just sent.
