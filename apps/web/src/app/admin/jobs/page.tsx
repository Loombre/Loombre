// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/jobs/page.tsx
//
// Phase 4 deliverable D: the admin Jobs dashboard. Extracted (Phosphor
// retheme Wave 2, Lane L2) into components/admin/JobsPanel.tsx so the
// /admin dashboard's collapsible job-queue panel reuses the exact same
// live-merge logic — this page is now a thin wrapper.

import { Card } from "../../../components/ui/Card.js";
import { JobsPanel } from "../../../components/admin/JobsPanel.js";

export default function AdminJobsPage(): React.JSX.Element {
  return (
    <Card>
      <JobsPanel />
    </Card>
  );
}
