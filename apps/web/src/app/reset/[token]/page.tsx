// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/reset/[token]/page.tsx
//
// Route entry only (Next rejects any export beyond default/route-config on
// a page.tsx) — the actual screen, and the named export the unit test
// reaches for, lives in ./ResetPasswordScreen.tsx. See that file's header.

import { use } from "react";
import { ResetPasswordScreen } from "./ResetPasswordScreen.js";

export default function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }): React.JSX.Element {
  const { token } = use(params);
  return <ResetPasswordScreen token={token} />;
}
