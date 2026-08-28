// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/auth/InvalidLinkScreen.tsx
//
// LD-15 (rc.6): the ONE dead-link screen every token-bearing public page
// renders. /claim and /reset had each hand-copied the identical block into
// their own render bodies — same <AuthScreen> with no tagline, same
// `.formHeading` heading, same `.bodyText` body, same secondary
// `.submit` Button — differing only in the three strings and where the CTA
// goes. Two hand-maintained copies is exactly the lookalike fork LD-15
// forbids, so the shared half is frozen here and both screens consume it.
//
// The copy stays a PROP, not a member of this component: the remedy
// genuinely differs (an invite holder must ask whoever sent it; a reset
// holder can mint a new link themselves at /forgot), and each screen's
// wording is asserted verbatim by its own test. What this component
// guarantees is that the two can never drift in LAYOUT or TREATMENT again.
//
// Deliberately NOT the load-error screen. A network failure gets its own
// distinct wording on both pages ("Couldn't load…"/"Couldn't check…" +
// "Try again") precisely so an unreachable server never reads to the
// viewer as a dead token — see ClaimScreen/ResetPasswordScreen's
// "load-error" phases. This component is only ever the 404 answer.

import { AuthScreen } from "./AuthScreen.js";
import { Button } from "../ui/Button.js";
import styles from "./AuthScreen.module.css";

export function InvalidLinkScreen({
  heading,
  body,
  actionLabel,
  onAction,
}: {
  heading: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}): React.JSX.Element {
  return (
    <AuthScreen>
      <p className={styles.formHeading}>{heading}</p>
      <p className={styles.bodyText}>{body}</p>
      <Button type="button" variant="secondary" className={styles.submit} onClick={onAction}>
        {actionLabel}
      </Button>
    </AuthScreen>
  );
}
