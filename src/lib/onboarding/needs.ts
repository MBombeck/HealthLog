/**
 * v1.39 (C1) — the needs-based onboarding's server state, as data.
 *
 * The design spec (`.planning/2026-09-09-onboarding-design-spec.md`) asks five
 * questions, saves each answer as it is given, and derives the record's module
 * map from the set of answers once. This file is the vocabulary and the
 * fail-soft readers for the three JSON columns behind that: the answers, the
 * ordered steps, and the one task the flow ended on.
 *
 * Pure and Prisma-free on purpose — the Zod schemas in
 * `src/lib/validations/onboarding-needs.ts` build on it, the OpenAPI generator
 * pulls it in without dragging the server graph along, and the browser reads
 * the same step ids the server writes.
 *
 * ── Coexistence with the wizard of today ───────────────────────────────────
 *
 * Nothing here retires anything. `User.onboardingStep`, `User.onboardingGoals`
 * and the six goal slugs in `./goals.ts` keep their meaning and keep driving
 * the four-step wizard and its one-time dashboard seed until C2 replaces that
 * surface. The two states are disjoint by construction: the goal slugs decide
 * TILE ORDER, these answers decide WHICH MODULES ARE ON, and neither reads the
 * other. `User.onboardingCompletedAt` also stays what it was — the first-run
 * redirect's gate — which is why the needs flow carries a completion stamp of
 * its own rather than borrowing that column: "set up again" has to be able to
 * re-ask the questions without pushing the person back through the first-run
 * redirect.
 */
import type {
  OnboardingAreaKey,
  OnboardingModuleNeeds,
} from "@/lib/modules/registry";
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";

/**
 * The ordered steps, with the stable ids the spec names. Order is the order
 * they are asked in; the ids are the wire contract a client (web now, native
 * later) matches on, and a client that meets an id it does not know is
 * expected to skip it rather than refuse the list.
 */
export const ONBOARDING_STEP_IDS = [
  "who",
  "areas",
  "medication",
  "sources",
  "visit",
  "units",
  "confirm",
  "first-result",
  "done",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const ONBOARDING_STEP_STATUSES = ["pending", "done", "skipped"] as const;

export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUSES)[number];

/**
 * The steps a person may pass without answering. `who` is the one required
 * question in the spec; `confirm` and `done` are not questions at all, so
 * "skipped" would not mean anything for them.
 */
export const ONBOARDING_SKIPPABLE_STEP_IDS = [
  "areas",
  "medication",
  "sources",
  "visit",
  "units",
  "first-result",
] as const;

export type OnboardingSkippableStepId =
  (typeof ONBOARDING_SKIPPABLE_STEP_IDS)[number];

/**
 * Q1 — whose record this is. The vocabularies below are pinned against the
 * registry's derivation input with `satisfies`, so a value added here that the
 * mapping cannot read fails to compile rather than falling through the
 * derivation silently.
 */
export const ONBOARDING_RECORD_TARGETS = [
  "me",
  "someone-else",
  "both",
] as const satisfies readonly OnboardingModuleNeeds["recordTarget"][];

export type OnboardingRecordTarget = (typeof ONBOARDING_RECORD_TARGETS)[number];

/** Q3 — medication on a schedule. */
export const ONBOARDING_MEDICATION_ANSWERS = [
  "yes",
  "no",
  "sometimes",
] as const satisfies readonly OnboardingModuleNeeds["medication"][];

export type OnboardingMedicationAnswer =
  (typeof ONBOARDING_MEDICATION_ANSWERS)[number];

/** Q4 — where the readings come from today. */
export const ONBOARDING_SOURCE_KEYS = [
  "manual",
  "apple-health",
  "withings",
  "oura",
  "whoop",
  "polar",
  "fitbit",
  "strava",
  "nightscout",
  "file",
] as const;

export type OnboardingSourceKey = (typeof ONBOARDING_SOURCE_KEYS)[number];

/** Q5 — a doctor's visit coming up. */
export const ONBOARDING_VISIT_ANSWERS = [
  "within-a-month",
  "later",
  "no",
] as const satisfies readonly OnboardingModuleNeeds["visit"][];

export type OnboardingVisitAnswer = (typeof ONBOARDING_VISIT_ANSWERS)[number];

/**
 * The one task the flow ends on. `target` names what the task is about — a
 * source key for a connection, an area key for a reading — and is null for the
 * medication task, which has nothing to disambiguate.
 */
export const ONBOARDING_FIRST_RESULT_TASKS = [
  "connect-source",
  "add-medication",
  "log-reading",
] as const;

export type OnboardingFirstResultTask =
  (typeof ONBOARDING_FIRST_RESULT_TASKS)[number];

/**
 * Q6 — the unit answers, recorded as given.
 *
 * These are NOT the source of truth for how a value is displayed:
 * `User.glucoseUnit` and `User.unitPreference` are, and the answers step
 * writes them. What is kept here is what the flow was TOLD, so a restart can
 * show the person the answer they already gave without re-deriving it from a
 * display column somebody may have changed in Settings since.
 */
export interface OnboardingUnitAnswers {
  glucoseUnit: "mg/dL" | "mmol/L" | null;
  unitPreference: "metric" | "imperial" | null;
}

/** The answers as given. Every field is null / empty until it is answered. */
export interface OnboardingNeeds {
  recordTarget: OnboardingRecordTarget | null;
  areas: OnboardingAreaKey[];
  medication: OnboardingMedicationAnswer | null;
  sources: OnboardingSourceKey[];
  visit: OnboardingVisitAnswer | null;
  units: OnboardingUnitAnswers;
}

export interface OnboardingStepState {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
}

export interface OnboardingFirstResult {
  task: OnboardingFirstResultTask;
  target: string | null;
  /** ISO instant when the offered task produced its result, or null. */
  completedAt: string | null;
}

/**
 * What `GET /api/auth/me` publishes under `onboarding`, and what a client
 * reads. Additive: an account that never entered the flow gets the empty
 * answers and nine `pending` steps rather than a missing field, so a consumer
 * never has to branch on absence.
 */
export interface OnboardingStateDto {
  steps: OnboardingStepState[];
  needs: OnboardingNeeds;
  completedAt: string | null;
  firstResult: OnboardingFirstResult | null;
}

export function emptyOnboardingNeeds(): OnboardingNeeds {
  return {
    recordTarget: null,
    areas: [],
    medication: null,
    sources: [],
    visit: null,
    units: { glucoseUnit: null, unitPreference: null },
  };
}

/** Nine steps, all pending, in the spec's order. */
export function defaultOnboardingSteps(): OnboardingStepState[] {
  return ONBOARDING_STEP_IDS.map((id) => ({ id, status: "pending" as const }));
}

function member<T extends string>(
  values: readonly T[],
  value: unknown,
): T | null {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function memberList<T extends string>(
  values: readonly T[],
  value: unknown,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = member(values, entry);
    if (parsed !== null && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read the stored answers, dropping anything that is not a known value.
 *
 * Fail-soft rather than throwing: a column written by an older release, or by
 * a value this release retired, must not 500 the account payload that rides
 * every app boot. What cannot be read reads as unanswered, which is the state
 * the flow already knows how to handle.
 */
export function parseOnboardingNeeds(value: unknown): OnboardingNeeds {
  const raw = asRecord(value);
  const units = asRecord(raw.units);
  return {
    recordTarget: member(ONBOARDING_RECORD_TARGETS, raw.recordTarget),
    areas: memberList(ONBOARDING_AREA_KEYS, raw.areas),
    medication: member(ONBOARDING_MEDICATION_ANSWERS, raw.medication),
    sources: memberList(ONBOARDING_SOURCE_KEYS, raw.sources),
    visit: member(ONBOARDING_VISIT_ANSWERS, raw.visit),
    units: {
      glucoseUnit: member(["mg/dL", "mmol/L"] as const, units.glucoseUnit),
      unitPreference: member(
        ["metric", "imperial"] as const,
        units.unitPreference,
      ),
    },
  };
}

/**
 * Read the stored steps as the full ordered nine.
 *
 * The stored blob is treated as a status lookup, never as the order: the order
 * is this release's `ONBOARDING_STEP_IDS`, so a step added to the flow appears
 * as `pending` for an account mid-way through rather than vanishing, and a
 * step removed from the flow stops being published without a migration.
 */
export function parseOnboardingSteps(value: unknown): OnboardingStepState[] {
  const stored = new Map<string, OnboardingStepStatus>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const row = asRecord(entry);
      const id = member(ONBOARDING_STEP_IDS, row.id);
      const status = member(ONBOARDING_STEP_STATUSES, row.status);
      if (id && status) stored.set(id, status);
    }
  }
  return ONBOARDING_STEP_IDS.map((id) => ({
    id,
    status: stored.get(id) ?? "pending",
  }));
}

export function parseOnboardingFirstResult(
  value: unknown,
): OnboardingFirstResult | null {
  const raw = asRecord(value);
  const task = member(ONBOARDING_FIRST_RESULT_TASKS, raw.task);
  if (!task) return null;
  return {
    task,
    target: typeof raw.target === "string" ? raw.target.slice(0, 64) : null,
    completedAt:
      typeof raw.completedAt === "string" && raw.completedAt.length > 0
        ? raw.completedAt
        : null,
  };
}

/** True once every step has been answered or deliberately passed. */
export function everyOnboardingStepSettled(
  steps: readonly OnboardingStepState[],
): boolean {
  return steps.every((step) => step.status !== "pending");
}

/**
 * Has the person finished setting up?
 *
 * Three conditions, and each of them is a way the flow can be left half-done:
 * a step still waiting for an answer, a set of answers never confirmed, and a
 * first-result task that was offered and never produced. The last one is the
 * point of the whole flow — it ends on one completed task — so an offer with
 * no result is not a finished setup.
 *
 * `null` (a record that never entered the flow) settles: there is no
 * unfinished flow to keep anything open for.
 */
export function isOnboardingSettled(
  state: OnboardingStateDto | null | undefined,
): boolean {
  if (!state) return true;
  if (!everyOnboardingStepSettled(state.steps)) return false;
  if (state.completedAt === null) return false;
  return state.firstResult === null || state.firstResult.completedAt !== null;
}

/**
 * The unit columns an account already holds, read as the vocabulary the wire
 * publishes.
 *
 * `User.unitPreference` is nullable and `null` means "default metric", which
 * the account payload coerces away (`unitPreference === "imperial" ?
 * "imperial" : "metric"`). That coercion is fine to compare a CHOSEN value
 * against and useless for telling a chosen metric from an unset column, so the
 * server reads the raw column here and answers `null` for "never chosen".
 */
export interface HeldUnitPreferences {
  glucoseUnit: "mg/dL" | "mmol/L" | null;
  unitPreference: "metric" | "imperial" | null;
}

/** Read the two raw columns into the wire vocabulary; anything else is unset. */
export function readHeldUnitPreferences(row: {
  glucoseUnit: string | null;
  unitPreference: string | null;
}): HeldUnitPreferences {
  return {
    glucoseUnit: member(["mg/dL", "mmol/L"] as const, row.glucoseUnit),
    unitPreference: member(["metric", "imperial"] as const, row.unitPreference),
  };
}

/** True once the account carries both unit preferences as deliberate values. */
export function accountHoldsBothUnits(held: HeldUnitPreferences): boolean {
  return held.glucoseUnit !== null && held.unitPreference !== null;
}

/**
 * The steps as they should be READ, given what the account already holds.
 *
 * The spec's Q6 is "skipped when the account already holds them", and the
 * evidence for that is the two unit columns, not the questionnaire's own
 * memory of having asked. So a record whose account carries both preferences
 * publishes `units` as `done` even though nobody answered it here — which is
 * what stops the flow re-asking a value the account holds, and what stops the
 * completion gate below waiting for an answer to a question the flow will
 * never show.
 *
 * Read-side only: the stored ledger keeps saying `pending`, because the person
 * really has not answered it, and an answer given later still lands.
 */
export function resolveOnboardingSteps(
  steps: readonly OnboardingStepState[],
  held: HeldUnitPreferences,
): OnboardingStepState[] {
  if (!accountHoldsBothUnits(held)) return [...steps];
  return steps.map((step) =>
    step.id === "units" && step.status === "pending"
      ? { ...step, status: "done" as const }
      : step,
  );
}
