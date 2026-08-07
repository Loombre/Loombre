// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/wizard-state.ts
//
// Pure, framework-free logic for the first-boot onboarding wizard (STATE.md
// P4.6/P4.10) — step sequencing, the admin-creation form's client-side
// validation (mirroring FirstAdminRequest's contract minimums), the
// restore-step availability gate, and job-status/boot-redirect helpers.
// Kept deliberately free of React/DOM so it is directly unit-testable
// without a component-rendering harness (this repo's established web test
// pattern — see apps/web/src/lib/auth-store.ts, device-profile.ts,
// playback-reasons.ts, etc.: every *.test.ts here tests plain functions/
// classes, never rendered JSX; no @testing-library/react dependency exists
// in this workspace, and this wave doesn't introduce one).
//
// Step order matches the task spec's literal P4.6 sequence: welcome ->
// admin -> libraries -> hardware -> restricted -> restore -> done.
//
// RESTORE-STEP ORDERING NOTE (a real tension worth recording, not papered
// over): apps/worker/src/import/consumer.ts's module header documents that
// POST /import's `mode` defaults to 'fail-if-not-empty' with NO
// client-exposed override (ExportArchive is the entire request body — the
// contract has no `mode` field), and its "empty target" check requires
// libraries/catalog_items/progress to be LITERALLY empty. If the wizard's
// earlier "libraries" step actually creates a library, a later restore
// attempt is no longer running against an empty instance and the import
// job WILL fail with ImportConflictError ('failed' status, a real
// lastError). Reordering restore to run immediately after admin creation
// (before libraries) would sidestep this, but the task's own enumerated
// step order explicitly lists libraries -> hardware -> restricted ->
// restore, and its "offer restore ONLY right after admin creation while
// the instance is empty-but-for-you" clause reads as the CONSTRAINT that
// order must still satisfy, not a mandate to move the step. Resolution
// implemented here: the "libraries" step stays skippable (a user who
// intends to restore afterward skips manual library creation), and
// canOfferRestore() below tracks whether a library WAS created earlier in
// THIS wizard session — if so, the restore step is shown but disabled with
// an honest explanation instead of silently attempting (and failing) an
// import. This keeps the literal step order intact while still being
// technically correct about when restore can actually succeed. Flagged in
// this lane's report for the orchestrator to weigh against reordering.

export type StepId = "welcome" | "admin" | "libraries" | "hardware" | "restricted" | "restore" | "done";

export const STEP_ORDER: readonly StepId[] = [
  "welcome",
  "admin",
  "libraries",
  "hardware",
  "restricted",
  "restore",
  "done",
];

export function stepIndex(step: StepId): number {
  return STEP_ORDER.indexOf(step);
}

export function nextStep(current: StepId): StepId {
  const idx = stepIndex(current);
  return STEP_ORDER[Math.min(idx + 1, STEP_ORDER.length - 1)]!;
}

export function previousStep(current: StepId): StepId {
  const idx = stepIndex(current);
  return STEP_ORDER[Math.max(idx - 1, 0)]!;
}

export interface WizardFlags {
  /** True once POST /setup/first-admin has succeeded this session. Every
   *  step after "admin" requires this (the wizard holds no admin token
   *  before it). */
  adminCreated: boolean;
  /** True iff THIS wizard session already called POST /libraries at least
   *  once — see the module header's restore-ordering note. */
  libraryCreatedThisSession: boolean;
}

/** See the module header's "RESTORE-STEP ORDERING NOTE". */
export function canOfferRestore(flags: WizardFlags): boolean {
  return flags.adminCreated && !flags.libraryCreatedThisSession;
}

// ── Admin-creation form validation (mirrors FirstAdminRequest, openapi.yaml) ──

export interface AdminFormInput {
  username: string;
  email: string;
  password: string;
}

export interface AdminFormErrors {
  username?: string;
  email?: string;
  password?: string;
}

// Deliberately permissive (matches the HTML5 <input type="email"> spirit,
// not a full RFC 5322 parser) — the server is the actual source of truth
// for "email" format validity; this exists to catch obvious typos before a
// round trip, not to be exhaustive.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8; // FirstAdminRequest.password: { minLength: 8 }

export function validateAdminForm(input: AdminFormInput): AdminFormErrors {
  const errors: AdminFormErrors = {};
  if (input.username.trim().length === 0) {
    errors.username = "Username is required.";
  }
  if (input.email.trim().length === 0) {
    errors.email = "Email is required.";
  } else if (!EMAIL_PATTERN.test(input.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return errors;
}

export function isAdminFormValid(input: AdminFormInput): boolean {
  return Object.keys(validateAdminForm(input)).length === 0;
}

// ── Library-path form validation. Manual entry always; the step ALSO
//    offers the server-enumeration DirectoryPicker (the P4.6 "no picker"
//    deviation was about a NATIVE controller-app picker and is reversed —
//    see LibraryStep.tsx's header) ──

export interface LibraryFormInput {
  name: string;
  paths: string[];
}

export interface LibraryFormErrors {
  name?: string;
  paths?: string;
}

export function validateLibraryForm(input: LibraryFormInput): LibraryFormErrors {
  const errors: LibraryFormErrors = {};
  if (input.name.trim().length === 0) {
    errors.name = "Library name is required.";
  }
  if (input.paths.length === 0 || input.paths.every((p) => p.trim().length === 0)) {
    errors.paths = "At least one path is required.";
  }
  return errors;
}

// ── Job polling (GET /admin/jobs/{id}) ──

export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

// ── Per-step render-state derivation (pure, so "each step's rendering
//    states" is unit-testable without a component-rendering harness — see
//    the module header) ──

export type HardwareViewState = "never-ran" | "pending" | "failed" | "ready";

export interface CapabilityProbeStatusLike {
  status: "never-ran" | "pending" | "failed" | "completed";
  lastError: string | null;
}

/** GET /admin/capabilities returns `{report, probe}` (contract's
 *  CapabilityReportEnvelope). W1/D-1: the three no-report states are
 *  distinct and each gets honest copy — `never-ran` (no self-test on
 *  record), `pending` (self-test queued/running), `failed` (the last
 *  self-test errored; report stays null). A non-null report is `ready`
 *  even with ZERO backends — an empty capability set is the valid
 *  "software everything" state, not an error. The hardware step polls
 *  regardless of which state it's in. `probe` is optional so callers
 *  (and older cached envelopes) degrade to the never-ran copy rather
 *  than crashing. */
export function deriveHardwareViewState(
  report: unknown,
  probe?: CapabilityProbeStatusLike | null,
): HardwareViewState {
  if (report) return "ready";
  if (probe?.status === "failed") return "failed";
  if (probe?.status === "pending") return "pending";
  return "never-ran";
}

export type RestrictedViewState = "capability-off" | "opt-in-form";

/** GET /system/capabilities's `details['restricted-content'].enabled`
 *  (STATE.md P1.19: instance-level env flag, LOOMBRE_RESTRICTED_ENABLED) —
 *  off means the wizard can only explain the flag, never offer opt-in. */
export function deriveRestrictedViewState(instanceCapabilityEnabled: boolean): RestrictedViewState {
  return instanceCapabilityEnabled ? "opt-in-form" : "capability-off";
}

export type RestoreViewState = "offer" | "blocked-library-created" | "polling" | "succeeded" | "failed";

export function deriveRestoreViewState(
  flags: WizardFlags,
  job: { status: JobStatus; lastError: string | null } | null,
): RestoreViewState {
  if (job) {
    if (job.status === "completed") return "succeeded";
    if (job.status === "failed" || job.status === "cancelled") return "failed";
    return "polling";
  }
  return canOfferRestore(flags) ? "offer" : "blocked-library-created";
}

// ── Boot-redirect decision (apps/web/src/app/page.tsx, the "unauthenticated
//    web boot checks GET /setup/state once" wiring) ──

export type BootRoute = "/home" | "/setup" | "/login";

export function decideBootRoute(input: { isAuthenticated: boolean; needsSetup: boolean }): BootRoute {
  if (input.isAuthenticated) return "/home";
  return input.needsSetup ? "/setup" : "/login";
}
