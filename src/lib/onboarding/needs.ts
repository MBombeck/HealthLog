/**
 * v1.39 — the needs-based onboarding's server state, as data.
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
 * ── The completion stamp ───────────────────────────────────────────────────
 *
 * `User.onboardingCompletedAt` stays what it was — the first-run redirect's
 * gate — which is why the needs flow carries a completion stamp of its own
 * rather than borrowing that column: "set up again" has to be able to re-ask
 * the questions without pushing the person back through the first-run
 * redirect. The five-step wizard that used to share this state is gone (C2);
 * its step counter and goal slugs left the account row with it, and the
 * dashboard order those slugs seeded now comes from the answers here
 * (`./dashboard-seed.ts`).
 */
import type {
  OnboardingAreaKey,
  OnboardingModuleNeeds,
} from "@/lib/modules/registry";
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import {
  MEDICINE_REGISTRY_CHOICES,
  type MedicineRegistryChoice,
} from "@/lib/medications/leaflet-registries";
import { isValidTimezone } from "@/lib/tz/format";

/**
 * The ordered steps, with the stable ids the spec names. Order is the order
 * they are asked in; the ids are the wire contract a client (web now, native
 * later) matches on, and a client that meets an id it does not know is
 * expected to skip it rather than refuse the list.
 *
 * `units` is shown as "Region & units" since 1.49 and keeps its id. The two
 * steps after `confirm` that 1.49 added, `reminders` and `ai`, are follow-ups:
 * offers made once the answers are confirmed, each conditional, each
 * skippable, and neither ever holds the setup open (see
 * `ONBOARDING_FOLLOW_UP_STEP_IDS`), so a client that predates them and skips
 * them finishes exactly as it did.
 */
export const ONBOARDING_STEP_IDS = [
  "who",
  "areas",
  "medication",
  "sources",
  "visit",
  "units",
  "confirm",
  "reminders",
  "ai",
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
  "reminders",
  "ai",
  "first-result",
] as const;

/**
 * The follow-up steps: offered after the confirm screen, never required.
 *
 * Two rules keep them from reopening a setup that is finished:
 *
 *  - a ledger stored before a follow-up existed, on a record whose flow was
 *    already confirmed, reads that follow-up as `skipped` (it was passed by
 *    finishing; `parseOnboardingSteps`), so every 1.48 account stays settled
 *    and is never sent back into the flow;
 *  - a follow-up that does not apply to the record reads as `skipped` too
 *    (`resolveOnboardingSteps`), so nothing waits for a screen the flow will
 *    never show.
 */
export const ONBOARDING_FOLLOW_UP_STEP_IDS = ["reminders", "ai"] as const;

export type OnboardingFollowUpStepId =
  (typeof ONBOARDING_FOLLOW_UP_STEP_IDS)[number];

export function isOnboardingFollowUpStep(
  id: string,
): id is OnboardingFollowUpStepId {
  return (ONBOARDING_FOLLOW_UP_STEP_IDS as readonly string[]).includes(id);
}

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
  "garmin",
  "fitbit",
  "strava",
  "nightscout",
  "file",
] as const;

export type OnboardingSourceKey = (typeof ONBOARDING_SOURCE_KEYS)[number];

/** A doctor's visit coming up. */
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
 * The unit answers, recorded as given.
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
  /**
   * 1.49, "Region & units": the IANA time zone the person confirmed, as
   * given. `User.timezone` is the value every surface reads.
   */
  timezone: string | null;
  /**
   * 1.49: the medicine registry the person chose for "Find leaflet", as
   * given. `User.medicineRegistry` is the value the medication read uses.
   */
  medicineRegistry: MedicineRegistryChoice | null;
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
  /** What this server offers the record, for the conditional follow-ups. */
  offers: OnboardingOffers;
}

/**
 * The server facts a follow-up step depends on, published beside the ledger
 * so every client decides the same way and none recomputes them (1.49).
 *
 * `ai` is true while this record may use the Coach on this server: the
 * operator offers it, a provider can serve it (or the person can set one up),
 * and the person has not switched the Coach off. The `ai` step applies only
 * then. Additive: a reader that predates it ignores it.
 */
export interface OnboardingOffers {
  ai: boolean;
}

/** No offers: what a reader without the server facts assumes. */
export const NO_ONBOARDING_OFFERS: OnboardingOffers = Object.freeze({
  ai: false,
});

export function emptyOnboardingNeeds(): OnboardingNeeds {
  return {
    recordTarget: null,
    areas: [],
    medication: null,
    sources: [],
    visit: null,
    units: {
      glucoseUnit: null,
      unitPreference: null,
      timezone: null,
      medicineRegistry: null,
    },
  };
}

/** Every step, all pending, in the spec's order. */
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
      timezone:
        typeof units.timezone === "string" && isValidTimezone(units.timezone)
          ? units.timezone
          : null,
      medicineRegistry: member(
        MEDICINE_REGISTRY_CHOICES,
        units.medicineRegistry,
      ),
    },
  };
}

/**
 * Read the stored steps as the full ordered list.
 *
 * The stored blob is treated as a status lookup, never as the order: the order
 * is this release's `ONBOARDING_STEP_IDS`, so a step added to the flow appears
 * as `pending` for an account mid-way through rather than vanishing, and a
 * step removed from the flow stops being published without a migration.
 *
 * `completedAt` is the record's confirmation stamp, required so no reader can
 * forget it. A follow-up step absent from a confirmed record's blob reads as
 * `skipped`: the record finished its setup before that step existed. Every
 * write stores the full list, so a flow that runs on this release always
 * carries the follow-ups it owes. The backup reads and writes through this
 * too, which is what keeps a restored 1.48 ledger finished.
 */
export function parseOnboardingSteps(
  value: unknown,
  completedAt: Date | string | null,
): OnboardingStepState[] {
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
    status:
      stored.get(id) ??
      // A follow-up the stored ledger never had, on a confirmed flow: the
      // flow was finished before the step existed, which passed it.
      (completedAt !== null && isOnboardingFollowUpStep(id)
        ? "skipped"
        : "pending"),
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

/**
 * The steps that are QUESTIONS — everything the flow puts to the person before
 * the confirm screen.
 *
 * Sliced out of the ordered list rather than written out again, so a question
 * added to the flow joins this set on the day it lands and the completion gate
 * below cannot fall behind the screens.
 */
export const ONBOARDING_QUESTION_STEP_IDS: readonly OnboardingStepId[] =
  ONBOARDING_STEP_IDS.slice(0, ONBOARDING_STEP_IDS.indexOf("confirm"));

/**
 * Has the questionnaire been finished?
 *
 * Every question answered or deliberately passed — not "Q1 is set". The
 * difference matters because the answers become a module map: deriving from a
 * flow somebody abandoned after the first screen reads every unanswered
 * question as its conservative default and switches off the surfaces that
 * default implies, and the derivation latch then makes that unrepeatable.
 *
 * `who` cannot be passed (the schema gives it no skip arm), so "not pending"
 * means "answered" for it and "answered or passed" for the rest.
 */
export function everyOnboardingQuestionSettled(
  steps: readonly OnboardingStepState[],
): boolean {
  return ONBOARDING_QUESTION_STEP_IDS.every(
    (id) => steps.find((step) => step.id === id)?.status !== "pending",
  );
}

/** True once every step has been answered or deliberately passed. */
export function everyOnboardingStepSettled(
  steps: readonly OnboardingStepState[],
): boolean {
  return steps.every((step) => step.status !== "pending");
}

/**
 * Did this record ever enter the setup flow?
 *
 * Q1 is the one question with no skip arm, so an answer to it is the mark of
 * having started, and the flow's own completion stamp covers a row whose
 * answers a later release stopped recognising.
 *
 * Deliberately NOT "any step is not pending": `units` resolves to `done` from
 * the account's own unit columns, so a record that never saw a question can
 * carry a settled step. The published state is additive — every record has an
 * `onboarding` field, and a record that predates the flow reads as empty
 * answers with nine pending steps — so this is what tells the two apart.
 */
export function hasEnteredOnboardingFlow(
  state:
    | (Pick<OnboardingStateDto, "completedAt" | "needs"> &
        Partial<OnboardingStateDto>)
    | null
    | undefined,
): boolean {
  if (!state) return false;
  return state.completedAt !== null || state.needs.recordTarget !== null;
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
 * Two things settle it outright. `null`, and a record that never entered the
 * flow: there is no unfinished setup to keep anything open for, and since the
 * payload publishes the field for every record, without that arm every account
 * that predates the flow would read as permanently unfinished.
 *
 * And a first-result step the person deliberately passed. The task is offered
 * (`firstResult` records which one, with no completion) and then skipped; the
 * offer is still on the row, so asking only "did the offered task produce
 * anything" answers "no" forever. A deliberate pass is an answer, not an
 * unfinished task.
 */
export function isOnboardingSettled(
  state: OnboardingStateDto | null | undefined,
): boolean {
  if (!state) return true;
  if (!hasEnteredOnboardingFlow(state)) return true;
  if (!everyOnboardingStepSettled(state.steps)) return false;
  if (state.completedAt === null) return false;
  const offered = state.steps.find((step) => step.id === "first-result");
  if (offered?.status === "skipped") return true;
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

/** Areas whose readings come with a reminder of their own. */
const REMINDER_AREAS = new Set<OnboardingAreaKey>(["mood", "cycle"]);

/**
 * Whether the `reminders` follow-up applies: a medication on a schedule, or an
 * area with reminders of its own, on the person's own record. Answers given
 * for somebody else's record say nothing about where the guardian's own
 * notifications should go.
 */
export function remindersFollowUpApplies(needs: OnboardingNeeds): boolean {
  if (needs.recordTarget === "someone-else") return false;
  return (
    needs.medication === "yes" ||
    needs.medication === "sometimes" ||
    needs.areas.some((area) => REMINDER_AREAS.has(area))
  );
}

/**
 * Whether the `ai` follow-up applies: when the server offers the Coach, or
 * when the flow already answered it.
 *
 * The second arm is what keeps an answer in the order. "No" switches the Coach
 * off, which turns the offer off with it; without this arm the answered step
 * dropped out of the order under the person, "Continue" lost its place and
 * "Back" could not reach the screen again.
 */
export function aiFollowUpApplies(
  needs: OnboardingNeeds,
  offers: OnboardingOffers,
  status: OnboardingStepStatus = "pending",
): boolean {
  if (needs.recordTarget === "someone-else") return false;
  return offers.ai || status === "done";
}

export function followUpApplies(
  id: OnboardingFollowUpStepId,
  needs: OnboardingNeeds,
  offers: OnboardingOffers,
  status: OnboardingStepStatus = "pending",
): boolean {
  return id === "reminders"
    ? remindersFollowUpApplies(needs)
    : aiFollowUpApplies(needs, offers, status);
}

/**
 * The Coach offer, read off the record's resolved AI block.
 *
 * Offered while the Coach is available, while the one thing missing is the
 * person's consent, or while no provider is set up but the person could set
 * one up. Never while the operator switched it off or the person did.
 */
export function onboardingOffersFromAi(ai: {
  capabilities: {
    coach: { available: boolean; reason: string | null };
  };
  provider: { canConfigure: boolean };
}): OnboardingOffers {
  const coach = ai.capabilities.coach;
  return {
    ai:
      coach.available ||
      coach.reason === "consent_required" ||
      (coach.reason === "no_provider" && ai.provider.canConfigure),
  };
}

/** What `resolveOnboardingSteps` needs beside the ledger. */
export interface OnboardingResolveContext {
  held: HeldUnitPreferences;
  needs: OnboardingNeeds;
  offers: OnboardingOffers;
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
 * A follow-up that does not apply to the record reads as `skipped`, for the
 * same reason: nothing may wait on a screen the flow will not show.
 *
 * Read-side only: the stored ledger keeps saying `pending`, because the person
 * really has not answered it, and an answer given later still lands.
 */
export function resolveOnboardingSteps(
  steps: readonly OnboardingStepState[],
  context: OnboardingResolveContext,
): OnboardingStepState[] {
  const holdsUnits = accountHoldsBothUnits(context.held);
  return steps.map((step) => {
    if (step.status !== "pending") return step;
    if (step.id === "units" && holdsUnits) {
      return { ...step, status: "done" as const };
    }
    if (
      isOnboardingFollowUpStep(step.id) &&
      !followUpApplies(step.id, context.needs, context.offers)
    ) {
      return { ...step, status: "skipped" as const };
    }
    return step;
  });
}
