# Mail deliverability notes

<!-- Sourcing: E9 deliverability-note requirement (STATE.md "Optional mail
     transport + invitation & reset flows", deliverable 5 — "SPF/DKIM/DMARC
     are the mail provider's job when you relay through them; direct-send
     from home IPs is generally futile; no rabbit hole"); mail.smtpHost
     registry entry (packages/shared/src/settings-registry.ts) for the
     "provider or your own server" framing the Admin Guide's Mail page
     already uses; MailDispatchService/the mail-send job/mail.failed event
     for where a real delivery failure already surfaces — no new mechanism
     documented here, just the reality of getting a message accepted in
     the first place. -->

Getting a message *sent* and getting it *delivered* — accepted by the
recipient's mail provider instead of silently dropped, quarantined, or
flagged as spam — are two different problems, and Loombre only solves the
first one.

If your outgoing mail server address points at a transactional-relay
service or a mailbox provider (see the Admin Guide's
[Mail](../admin-guide/mail.md) page for the reference table), the
deliverability groundwork — the SPF, DKIM, and DMARC DNS records that
convince a receiving mail server your mail is legitimate — is that
provider's job, and their own setup instructions cover it; you generally
don't need to touch DNS yourself, and adding those records for a domain
you don't control (a shared subdomain a relay service issues you) is
usually unnecessary or actively wrong. Sending directly from a home
connection's own IP address, with no relay in between, is a different
story: most residential and small-business ISP address ranges are
pre-emptively blocked or heavily distrusted by major mail providers
regardless of how correctly everything else is configured, so direct-send
from a self-hosted instance's own address is, in practice, usually
futile — route through a relay, or your domain registrar's or ISP's own
mail service, instead of fighting that particular battle yourself.

## See also

- [Mail](../admin-guide/mail.md) — the Admin Guide's setup page, and its
  provider reference table.
- [Environment variable reference](env-reference.md) — every mail-related
  variable, including `LOOMBRE_PUBLIC_URL`.
