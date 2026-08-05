// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/SecretReveal.tsx
//
// Lane D (invitation/recovery/mail UI run): the ONE-TIME secret-reveal
// pattern, extracted from apps/web/src/components/admin/plugins/
// RegisterPluginWizard.tsx:326-339's `secretBox`/`secretValue`/
// `secretWarning` markup (that lane's HMAC-delivery-secret reveal is the
// exact same shape this run needs twice: the invite claim-link reveal on
// creation (E2 — "the full link is shown ONCE at creation with a copy
// button") and the admin/CLI temporary-password reveal (E3a/M14 —
// AdminResetPasswordResponse.temporaryPassword, "shown exactly once; the
// server retains only its hash"). Extracted rather than duplicated a
// third time; RegisterPluginWizard.tsx itself is left untouched (working,
// tested, out of this lane's scope) rather than retrofitted to use this —
// a call recorded in this lane's freeze report.
//
// Deliberately NOT wired to useToast()'s "copied" feedback — the visible
// copied/uncopied icon swap (same 2s window RegisterPluginWizard used) is
// enough, and every consumer here already sits inside a sheet/modal where a
// bottom-center toast could be visually competing with the secret box
// itself.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { Button } from "./Button.js";
import styles from "./SecretReveal.module.css";

export interface SecretRevealProps {
  /** Field label above the value, e.g. "Invite link" / "Temporary password". */
  label: string;
  /** The one-time secret itself — never re-fetchable, so this component
   *  never re-derives or caches it beyond the render it's given. */
  value: string;
  /** Defaults to the RegisterPluginWizard precedent's own wording. */
  warning?: string;
  /** Loombre Remote's enrollment ceremony (R2/R3, Lane U2) needs this for
   *  a multi-line wg-quick config: the default single-line `<code>` (see
   *  SecretReveal.module.css) has no `white-space` rule, so a browser's
   *  default inline/normal handling COLLAPSES newlines — fine for a link
   *  or a password, silently wrong for a config format where blank lines
   *  and line breaks between [Interface]/[Peer] stanzas are semantically
   *  load-bearing. `multiline: true` swaps the value into a `<pre>` with
   *  `white-space: pre-wrap` instead — every other caller (CreateInviteSheet,
   *  the temp-password reveal) is unaffected (defaults to false, unchanged
   *  `<code>` rendering). */
  multiline?: boolean;
}

export function SecretReveal({ label, value, warning, multiline = false }: SecretRevealProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser — the value is still
      // selectable/visible on screen, so this is a nicety, not a blocker.
    }
  }

  return (
    <div className={styles.secretBox}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={multiline ? `${styles.secretValue} ${styles.secretValueMultiline}` : styles.secretValue}>
        {multiline ? <pre className={styles.secretValuePre}>{value}</pre> : <code>{value}</code>}
        <Button type="button" variant="ghost" iconOnly onClick={() => void handleCopy()} title="Copy">
          <Icon icon={copied ? Check : Copy} size="dense" aria-label="Copy" />
        </Button>
      </div>
      <p className={styles.secretWarning}>{warning ?? "This will not be shown again."}</p>
    </div>
  );
}
