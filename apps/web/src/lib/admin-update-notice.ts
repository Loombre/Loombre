// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-update-notice.ts
//
// Pure verification-state -> {tone, label, detail} mapping for the System
// panel's update notice card (Phase 4 deliverable D task brief: "verified
// verification state rendered honestly... 'signature-invalid' is a
// WARNING state"). GET /system/update's SystemUpdateVerification enum
// (packages/contract/openapi.yaml): verified | signature-invalid |
// unreachable | disabled.

import type { PillTone } from "./admin-status.js";

export interface UpdateVerificationInfo {
  tone: PillTone;
  label: string;
  detail: string;
}

const VERIFICATION_INFO: Record<string, UpdateVerificationInfo> = {
  verified: {
    tone: "success",
    label: "Verified",
    detail: "The release manifest's minisign signature checked out against the pinned public key.",
  },
  // The one case the task brief calls out explicitly: a signature that
  // failed to verify is NOT an error to shrug off as "couldn't check" —
  // it means a manifest was fetched and did NOT match the pinned key
  // (tampered, wrong key, or an unsupported prehashed variant). Rendered
  // as a WARNING (not "danger"/error) because it doesn't affect THIS
  // server's own running software — only the notification is untrusted;
  // the admin should investigate, not panic.
  "signature-invalid": {
    tone: "warning",
    label: "Signature invalid",
    detail:
      "A release manifest was fetched, but its signature did not verify against the pinned public key. This update notice is untrusted — do not act on latestVersion below until this is investigated.",
  },
  unreachable: {
    tone: "neutral",
    label: "Unreachable",
    detail: "The manifest mirror could not be reached, or returned an unexpected response.",
  },
  disabled: {
    tone: "neutral",
    label: "Disabled",
    detail: "Update checking is turned off on this instance (LOOMBRE_UPDATE_CHECK=off) — no network request was made.",
  },
};

export function describeUpdateVerification(verification: string): UpdateVerificationInfo {
  return (
    VERIFICATION_INFO[verification] ?? {
      tone: "neutral",
      label: verification,
      detail: "Unrecognized verification state — this build may be behind the server's contract.",
    }
  );
}
