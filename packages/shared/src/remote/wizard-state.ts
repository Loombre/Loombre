// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/wizard-state.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R8, Wave 0 freeze).
//
// THE WIZARD STATE MACHINE — pure, framework-free step sequencing for the
// three-path remote-access wizard. Modeled on apps/web/src/app/setup/
// wizard-state.ts's own shape (pure module + tests now; a thin React
// orchestrator consumes it later — U1's job, not this lane's). The server
// persists only OUTCOMES (settings, peers, tunnel config — RG10), never
// step state; this module is the client-side source of truth for "where
// in the flow am I" and "what comes next", driven by ordinary idempotent
// REST calls against the frozen contract (packages/contract/openapi.yaml).
//
// Wave-0 ADJUDICATION (flagged for the orchestrator, no R/RG number covers
// the exact step ids or the recommendation heuristic below): R8 names the
// five top-level stages and the three paths' own subsystems (R2/R4/R5) but
// does not spell out per-path step ids, the exact switch/disable step
// vocabulary, or a concrete interview -> recommendation function. This
// module makes a reasonable, exhaustively-tested first cut so lane U1 has
// something to build the real wizard UI against; U1 (or the orchestrator
// at freeze review) may refine step ids without touching STAGE_ORDER,
// PathId, or the pure-function shapes this file establishes.

/** The top-level R8 sequence, literal: interview (who needs access? ...) ->
 *  recommendation (comparison card) -> path-flow (the chosen path's guided
 *  flow) -> proof (R6's reachability proof) -> posture-handoff (R7's
 *  card). Mirrors setup/wizard-state.ts's STEP_ORDER/stepIndex/nextStep/
 *  previousStep shape exactly. */
export type StageId = "interview" | "recommendation" | "path-flow" | "proof" | "posture-handoff";

export const STAGE_ORDER: readonly StageId[] = ["interview", "recommendation", "path-flow", "proof", "posture-handoff"];

export function stageIndex(stage: StageId): number {
  return STAGE_ORDER.indexOf(stage);
}

export function nextStage(current: StageId): StageId {
  const idx = stageIndex(current);
  return STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)]!;
}

export function previousStage(current: StageId): StageId {
  const idx = stageIndex(current);
  return STAGE_ORDER[Math.max(idx - 1, 0)]!;
}

/** The three SELECTABLE wizard paths (R2/R4/R5). Distinct from the
 *  contract's RemotePathId, which additionally carries 'none' for the
 *  DERIVED "nothing enabled yet" state (RG15) — 'none' is never something
 *  a wizard step-flow runs FOR, only a fact the wizard reads on entry
 *  (see deriveEntryStage below). */
export type PathId = "remote" | "tunnel" | "direct";

/** R5's one branch point: Direct's server-side mode choice. */
export type DirectMode = "acme" | "reverse-proxy";

export type PathFlowStepId =
  | "remote-enable"
  | "remote-enroll-first-device"
  | "tunnel-token"
  | "tunnel-enable"
  | "direct-mode"
  | "direct-acme-test"
  | "direct-enable"
  | "direct-router-instructions";

/** Per-path step sequences within the "path-flow" stage (R2 remote / R4
 *  tunnel / R5 direct). Direct's own R5 sequence — mode choice, THEN
 *  (acme only) a staged test issuance, THEN enable, THEN router
 *  instruction cards — is written here in acme's full-length form;
 *  reverse-proxy's shorter path is expressed as a skip in
 *  nextPathFlowStep below, not as a second array, so there is exactly one
 *  ordered list of Direct's possible steps to keep in sync. */
export const PATH_FLOW_STEPS: Record<PathId, readonly PathFlowStepId[]> = {
  remote: ["remote-enable", "remote-enroll-first-device"],
  tunnel: ["tunnel-token", "tunnel-enable"],
  direct: ["direct-mode", "direct-acme-test", "direct-enable", "direct-router-instructions"],
};

export function firstPathFlowStep(path: PathId): PathFlowStepId {
  return PATH_FLOW_STEPS[path][0]!;
}

export interface PathFlowContext {
  /** Only meaningful once Direct's "direct-mode" step has been answered;
   *  undefined everywhere else. */
  directMode?: DirectMode;
}

/**
 * Pure transition: given a path, the current step, and context (Direct's
 * acme-vs-reverse-proxy choice is the only branch point anywhere in this
 * table), returns the next PathFlowStepId, or null once the path's flow is
 * complete (the wizard then advances to the "proof" stage, R6).
 *
 * R5: reverse-proxy mode has nothing to test, so it skips
 * "direct-acme-test" entirely — every other step, and every other path,
 * follows PATH_FLOW_STEPS' own linear order exactly.
 */
export function nextPathFlowStep(path: PathId, current: PathFlowStepId, context: PathFlowContext): PathFlowStepId | null {
  const steps = PATH_FLOW_STEPS[path];
  const idx = steps.indexOf(current);
  if (idx === -1) {
    throw new Error(`wizard-state: "${current}" is not a step of the "${path}" path`);
  }

  if (path === "direct" && current === "direct-mode" && context.directMode === "reverse-proxy") {
    return "direct-enable";
  }

  const next = steps[idx + 1];
  return next ?? null;
}

export interface SwitchPlan {
  /** R8: "switch = verified teardown then enable" — true whenever a
   *  DIFFERENT path is currently active (re-selecting the already-active
   *  path is idempotent re-entry, not a switch). */
  requiresTeardown: boolean;
  teardownPath: PathId | null;
  /** The target path's flow always restarts from its own first step. */
  firstStep: PathFlowStepId;
}

/** Pure derivation of what a path selection implies, given the DERIVED
 *  active path read from GET /admin/remote/state (RG15's activePath,
 *  'none' included). */
export function planPathSwitch(activePath: "none" | PathId, targetPath: PathId): SwitchPlan {
  const requiresTeardown = activePath !== "none" && activePath !== targetPath;
  return {
    requiresTeardown,
    teardownPath: requiresTeardown ? (activePath as PathId) : null,
    firstStep: firstPathFlowStep(targetPath),
  };
}

export type DisableVerificationStep = "revoke-peers" | "drop-listeners" | "teardown-connector";

/** R8/R9: what "disable" verifies per path — revoke peers + drop the
 *  listener (Remote), tear down the connector (Tunnel), or drop the
 *  listener/cert state (Direct). A UI checklist descriptor the wizard's
 *  disable confirmation renders from — the actual teardown work is
 *  server-side; this module only names what must be true afterward. */
export const DISABLE_VERIFICATION_STEPS: Record<PathId, readonly DisableVerificationStep[]> = {
  remote: ["revoke-peers", "drop-listeners"],
  tunnel: ["teardown-connector"],
  direct: ["drop-listeners"],
};

/** GET /admin/remote/state's wizard re-entry read (RG15): a fresh
 *  instance (activePath 'none') starts the interview; an instance with any
 *  path already active re-enters straight at the posture handoff — there
 *  is nothing left to interview or recommend once a path is live. */
export function deriveEntryStage(state: { activePath: "none" | PathId }): StageId {
  return state.activePath === "none" ? "interview" : "posture-handoff";
}

export interface InterviewAnswers {
  /** R8's second interview question: "everyone willing to install a small app?" */
  everyoneWillingToInstallApp: boolean;
  /** R8's third interview question: "need a public shareable URL?" */
  needsPubliclyShareableUrl: boolean;
  /** R8's fourth interview question: "comfortable with router settings?" */
  comfortableWithRouterSettings: boolean;
}

/**
 * R8's interview -> recommendation heuristic (pure, total over all 8
 * boolean combinations — see this module's header for the Wave-0
 * adjudication flag). A public shareable URL is something only Tunnel/
 * Direct produce — Remote grants private per-device network access, never
 * a browsable public link — so `needsPubliclyShareableUrl` rules Remote
 * out regardless of app-install willingness; otherwise, Remote (least
 * attack surface, no third party, no router touch, R9's own comparison
 * framing) wins whenever everyone is willing to install a small app. The
 * remaining split between Tunnel and Direct is router-settings comfort:
 * comfortable -> Direct (avoids Tunnel's third-party Cloudflare
 * dependency); not comfortable -> Tunnel (avoids Direct's router
 * port-forwarding requirement, the lowest-friction fallback).
 */
export function recommendPath(answers: InterviewAnswers): PathId {
  if (!answers.needsPubliclyShareableUrl && answers.everyoneWillingToInstallApp) {
    return "remote";
  }
  return answers.comfortableWithRouterSettings ? "direct" : "tunnel";
}
