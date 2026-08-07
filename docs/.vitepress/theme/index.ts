// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: docs/.vitepress/theme/index.ts
//
// Default theme + the Phosphor skin (custom.css). No components are
// overridden and no client code is added — this entry exists only so the
// brand stylesheet rides the theme bundle. Keeping it CSS-only means
// VitePress upgrades stay trivial and the CSP story is unchanged (the
// website's tools/build.mjs hashes whatever inline scripts VitePress
// itself emits; we add none).
import DefaultTheme from "vitepress/theme";
import "./custom.css";

export default DefaultTheme;
