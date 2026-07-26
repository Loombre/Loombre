// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/login/ServerIndicator.tsx
//
// Login screen's server row (design/phosphor/dc:2640-2643): a read-only
// pill summarizing the real serverUrl field this form already posts with,
// plus a SWITCH affordance that discloses the actual editable input in its
// place. Split out of page.tsx (which needs next/navigation's useRouter()
// and the auth store) purely so this presentational piece can be jsdom-
// tested with plain props — no router/auth-store mocking required (house
// convention: pure logic + jsdom component tests, see ServerIndicator.test
// .tsx and lib/server-url.test.ts for describeServerUrl itself).
//
// The prototype's fixture pill reads "LOOMBRE-01 · 192.168.1.40:3001 · TLS
// · 2 MS" — a server NAME and round-trip LATENCY. Neither exists anywhere
// in this app (no discovery/naming concept, no latency probe), so this
// renders only what describeServerUrl() can honestly derive from the URL
// itself: host[:port] and TLS. See page.tsx's header for the full U9
// ledger for this screen.

import { TextInput } from "../../components/ui/Input.js";
import { describeServerUrl } from "../../lib/server-url.js";
import styles from "./ServerIndicator.module.css";

export interface ServerIndicatorProps {
  serverUrl: string;
  showField: boolean;
  onShowField: () => void;
  onHideField: () => void;
  onChangeServerUrl: (value: string) => void;
}

export function ServerIndicator({
  serverUrl,
  showField,
  onShowField,
  onHideField,
  onChangeServerUrl,
}: ServerIndicatorProps): React.JSX.Element {
  const summary = describeServerUrl(serverUrl);

  if (showField) {
    return (
      <div className={styles.serverField}>
        <span className={styles.label} id="serverUrl-label">
          Server
        </span>
        <div className={styles.serverFieldRow}>
          <TextInput
            id="serverUrl"
            name="serverUrl"
            type="url"
            autoComplete="url"
            required
            aria-labelledby="serverUrl-label"
            value={serverUrl}
            onChange={(e) => onChangeServerUrl(e.target.value)}
            className={styles.serverInput}
          />
          {summary && (
            <button type="button" className={styles.switchLink} onClick={onHideField}>
              Done
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pill}>
      <span className={styles.pillDot} aria-hidden="true" />
      <span className={styles.pillText}>{summary ? `${summary.host} · ${summary.tls ? "TLS" : "NO TLS"}` : "No server set"}</span>
      <button type="button" className={styles.switchLink} onClick={onShowField}>
        Switch ▾
      </button>
    </div>
  );
}
