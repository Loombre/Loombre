// SPDX-License-Identifier: AGPL-3.0-only
// TS 6.0's TS2882 rejects side-effect imports of files that resolve to no
// module (app/layout.tsx's `import "./globals.css"`). Next's own global
// types only declare `*.module.css`; plain-CSS side-effect imports need
// this wildcard. `*.module.css` stays typed by Next — the more specific
// pattern wins.
declare module "*.css";
