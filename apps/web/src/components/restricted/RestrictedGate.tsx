// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedGate.tsx
//
// The LOCKED (default) state of /restricted (design/phosphor/README.md
// "Interactions -> Restricted content"): "the screen is a gate — lock
// roundel, `This zone is locked`, the item count, the separation rule
// restated, `SESSION-SCOPED · RE-LOCKS ON SIGN-OUT AND AFTER 30 MIN IDLE ·
// ALL DEVICES TOGETHER`, and an `Unlock with PIN` button -> existing PIN
// flow". The mono session line is verbatim from the README; the
// "separation rule restated" line is paraphrased (the README gives it as a
// requirement, not an exact quote) but must convey the same fact the
// Interactions section states elsewhere: restricted titles never appear in
// Browse/Search/Home, locked or not — only the ZONE's own access is gated.
//
// Item count comes from useRestrictedZoneCount() (W1c, wired here per this
// lane's scope) — visible while locked by design (U10: the zone's
// existence/size is a deliberate disclosure, titles/artwork are not).
// "Unlock with PIN" opens the EXISTING PinModal via useRestricted()'s
// openUnlockModal() — this component never renders its own PIN UI.

import { Lock } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { Button } from "../ui/Button.js";
import { useRestricted } from "./RestrictedProvider.js";
import styles from "./RestrictedGate.module.css";

export interface RestrictedGateProps {
  /** null while the count is still loading — the gate renders without a
   *  count line rather than a flash of "0 items". */
  itemCount: number | null;
}

export function RestrictedGate({ itemCount }: RestrictedGateProps): React.JSX.Element {
  const { openUnlockModal } = useRestricted();

  return (
    <div className={styles.gate}>
      <div className={styles.roundel} aria-hidden="true">
        <Icon icon={Lock} size="dense" />
      </div>
      <h1 className={styles.title}>This zone is locked</h1>
      {itemCount !== null && (
        <p className={styles.count}>
          {itemCount} {itemCount === 1 ? "item" : "items"}
        </p>
      )}
      <p className={styles.separation}>
        Restricted titles live in this zone only — they never appear in Browse, Search, or Home, locked or not. The
        lock only governs access to this screen.
      </p>
      <p className={styles.sessionLine}>SESSION-SCOPED · RE-LOCKS ON SIGN-OUT AND AFTER 30 MIN IDLE · ALL DEVICES TOGETHER</p>
      <Button type="button" variant="primary" onClick={openUnlockModal}>
        Unlock with PIN
      </Button>
    </div>
  );
}
