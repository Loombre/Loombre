// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/layout.tsx
//
// Phase 4 deliverable D: the /admin section shell. Wraps every /admin/*
// route in the normal AppShell (same nav rail/topbar as the rest of the
// app — P2.20 glass chrome) PLUS an admin-only route guard: a non-admin
// (or an admin whose token hasn't resolved yet) never sees admin content
// flash on screen, even for a frame — `status` starts "checking" and only
// flips to "allowed" after a real GET /users/me confirms isAdmin === true;
// anything else redirects to /home. This is UX, not the security boundary
// (every actual admin endpoint independently 403s a non-admin token
// server-side — apps/server/src/catalog/*.controller.ts's requireAdmin —
// so a client-side bypass of this guard could see loading skeletons at
// worst, never real data).

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/shell/AppShell.js";
import { AdminNav } from "../../components/admin/AdminNav.js";
import { apiGet } from "../../lib/api-client.js";
import styles from "./layout.module.css";

type GuardStatus = "checking" | "allowed" | "denied";

export default function AdminLayout({ children }: { children: ReactNode }): React.JSX.Element | null {
  const router = useRouter();
  const [status, setStatus] = useState<GuardStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    apiGet("/users/me")
      .then((user) => {
        if (cancelled) return;
        if ((user as { isAdmin?: boolean }).isAdmin === true) {
          setStatus("allowed");
        } else {
          setStatus("denied");
          router.replace("/home");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("denied");
          router.replace("/home");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <AppShell>
      {status === "allowed" ? (
        <div className={styles.page}>
          <h1 className={styles.heading}>Admin</h1>
          <AdminNav />
          {children}
        </div>
      ) : null}
    </AppShell>
  );
}
