// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/DetailFetchStatus.tsx
//
// Not-found / load-error panels for the single-entity detail screens —
// same visual treatment as app/people/[id]/page.module.css's .notFound
// (the one route that already had this), generalized here (see
// useDetailFetch.ts's header) so the screens it now covers don't hand-roll
// their own copies.

import { Button } from "../ui/Button.js";
import styles from "./DetailFetchStatus.module.css";

export function DetailNotFound({ label }: { label: string }): React.JSX.Element {
  return <div className={styles.status}>{label} not found.</div>;
}

export function DetailLoadError({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className={styles.status}>
      <p className={styles.message}>{message}</p>
      <Button type="button" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
