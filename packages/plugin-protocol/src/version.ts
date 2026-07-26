// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/version.ts
//
// LPP v1 is additive-only (C8, mission "Locked protocol decisions"): every
// wire shape in this package may grow new OPTIONAL members across time, but
// `protocolVersion` itself only changes when a genuinely breaking change is
// required — at which point a v2 module lands beside this one (this file's
// constant never becomes a union; a future LPP_PROTOCOL_VERSION_2 lives in
// its own version.ts under a v2 sibling package/module). A plugin declares
// the protocol version it speaks in its manifest (GET /lpp/manifest); the
// host rejects a manifest whose protocolVersion it does not recognize
// during registration (C8 "protocolVersion negotiation at registration").

/** The only protocol version this package implements. */
export const LPP_PROTOCOL_VERSION = 1 as const;

export type LppProtocolVersion = typeof LPP_PROTOCOL_VERSION;
