// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/os-label.ts
//
// Proper-noun display labels for the server OS enum (AUD-A4v4-005).
// The server emits lowercase enum values — `linux | macos | windows`
// (SystemInfo.os and CapabilityReport.platform, packages/contract/
// openapi.yaml; apps/server/src/catalog/admin.controller.ts's mapOs) —
// and the old CSS `text-transform: capitalize` rendered "Macos": a
// per-word transform cannot express Apple's own "macOS" capitalization.
// Pure map, framework-free; unknown values pass through unchanged so a
// future enum member degrades to the server's honest string instead of
// a wrong guess.

const OS_LABELS: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

export function formatOsLabel(os: string): string {
  return OS_LABELS[os] ?? os;
}
