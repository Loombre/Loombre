// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/web-url.ts
//
// IpcStatusResponse.webUrl / GET /ipc/v1/open-web-target resolution.
// Orchestrator instruction: "webUrl from LOOMBRE_WEB_URL env else the
// server's own resolved origin".
//
// STATE.md Phase 4 Open item, unresolved and NOT this lane's to fix:
// "Web-serving architecture unresolved for installed deployments —
// installers stage apps/web build output but nothing serves it (no
// `output: standalone` in next.config, no static serving in apps/server);
// IpcStatus.webUrl assumes an answer." The fallback below is exactly that
// assumed answer — apps/server's OWN bound origin — even though apps/
// server does not today actually serve the Next.js web client there (dev
// mode serves the web client separately on :3000; an installed build has
// no serving story yet at all, per the Open item above). This fallback is
// deliberately what the orchestrator specified for this wave regardless —
// it is a reasonable placeholder (the API origin IS where a future static-
// serving answer would most likely live) and gives "open web UI" a URL to
// try rather than nothing, but a controller's "open web target" button may
// land on a 404 until that architecture question is resolved. Flagged
// again in this lane's report; not something the IPC listener itself can
// decide.

import type { TlsMode } from "../tls/config.js";

export function resolveWebUrl(env: NodeJS.ProcessEnv, boundPort: number, tlsMode: TlsMode): string {
  const override = env["LOOMBRE_WEB_URL"]?.trim();
  if (override && override.length > 0) return override;

  const protocol = tlsMode === "off" ? "http" : "https";
  return `${protocol}://localhost:${boundPort}`;
}
