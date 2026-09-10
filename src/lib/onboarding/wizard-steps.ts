/**
 * v1.39 (C2) — the step machine behind the setup screens.
 *
 * The server publishes the ledger (`steps`) and the answers (`needs`); this
 * file turns them into a route. Pure and browser-free, so the page that
 * guards a URL, the screen that decides where "Next" goes, and the shell
 * that prints "2 of 6" all ask the same function and cannot disagree.
 *
 * One vocabulary is added on top of the server's: `welcome`, the screen
 * before the first question. It is not a step the server records — a person
 * who has not answered Q1 has not entered the flow, whichever screen they are
 * looking at — so it exists only here.
 */
import type { OnboardingSourceKey } from "./needs";
import {
  hasEnteredOnboardingFlow,
  ONBOARDING_STEP_IDS,
  type OnboardingFirstResultTask,
  type OnboardingNeeds,
  type OnboardingStateDto,
  type OnboardingStepId,
} from "./needs";

export type OnboardingScreenId = "welcome" | OnboardingStepId;

export const ONBOARDING_SCREEN_IDS: readonly OnboardingScreenId[] = [
  "welcome",
  ...ONBOARDING_STEP_IDS,
];

export function isOnboardingScreenId(
  value: string,
): value is OnboardingScreenId {
  return (ONBOARDING_SCREEN_IDS as readonly string[]).includes(value);
}

/**
 * The Q4 sources whose connection the browser can finish on its own — an
 * OAuth handshake or a URL-plus-secret form on Settings → Integrations.
 * Apple Health needs the phone, and "a file" is an import rather than a
 * connection, so neither can be the one task the flow ends on.
 */
export const BROWSER_CONNECTABLE_SOURCES = [
  "withings",
  "oura",
  "whoop",
  "polar",
  "fitbit",
  "strava",
  "nightscout",
] as const satisfies readonly OnboardingSourceKey[];

export type BrowserConnectableSource =
  (typeof BROWSER_CONNECTABLE_SOURCES)[number];

export function isBrowserConnectableSource(
  source: OnboardingSourceKey,
): source is BrowserConnectableSource {
  return (BROWSER_CONNECTABLE_SOURCES as readonly string[]).includes(source);
}

type FlowState = Pick<OnboardingStateDto, "steps" | "needs">;

function status(state: FlowState, id: OnboardingStepId) {
  return state.steps.find((step) => step.id === id)?.status ?? "pending";
}

const UNIT_AREAS = new Set<OnboardingNeeds["areas"][number]>([
  "glucose",
  "weight-body",
]);

/**
 * Whether Q6 is part of this flow at all.
 *
 * Two conditions from the spec: an area that needs a unit is among the
 * answers, and the account does not already hold the preferences. The
 * second is read off the published ledger rather than off the account —
 * the server resolves `units` to `done` when both columns are held — with
 * one refinement: a `done` the FLOW itself produced (an answer is recorded
 * beside it) keeps the screen in the order, so a person can go back to it,
 * and a deliberate skip does the same.
 */
export function unitsQuestionApplies(state: FlowState): boolean {
  if (!state.needs.areas.some((area) => UNIT_AREAS.has(area))) return false;
  const flowAnswered =
    state.needs.units.glucoseUnit !== null ||
    state.needs.units.unitPreference !== null;
  return !(status(state, "units") === "done" && !flowAnswered);
}

const FIXED_QUESTIONS: readonly OnboardingStepId[] = [
  "who",
  "areas",
  "medication",
  "sources",
  "visit",
];

/** The question screens this flow shows, in order. */
export function questionScreens(state: FlowState): OnboardingStepId[] {
  return unitsQuestionApplies(state)
    ? [...FIXED_QUESTIONS, "units"]
    : [...FIXED_QUESTIONS];
}

export interface FirstResultOffer {
  task: OnboardingFirstResultTask;
  /** A source key for a connection, an area key for a reading, else null. */
  target: string | null;
}

/**
 * The one task the flow ends on, by the spec's fixed priority: a connection
 * the browser can complete → the first medication with a reminder, if the
 * answer to Q3 was a daily schedule → one reading for the first Q2 area.
 * Everything the priority passes over goes to the checklist instead.
 */
export function chooseFirstResultTask(
  needs: OnboardingNeeds,
): FirstResultOffer | null {
  const connectable = needs.sources.find(isBrowserConnectableSource);
  if (connectable) return { task: "connect-source", target: connectable };
  if (needs.medication === "yes")
    return { task: "add-medication", target: null };
  const area = needs.areas[0];
  if (area) return { task: "log-reading", target: area };
  return null;
}

/**
 * Whether the first-result screen is part of this flow.
 *
 * Not for "someone I look after": the three tasks write the caller's own
 * record and the routes refuse under a switch, so the profile is created on
 * the confirm screen and the flow ends there — the new record's first entry
 * happens inside that record, from the done screen's link into it.
 */
export function firstResultApplies(state: FlowState): boolean {
  if (state.needs.recordTarget === "someone-else") return false;
  return chooseFirstResultTask(state.needs) !== null;
}

/** Every screen this flow shows, in order. */
export function screenOrder(state: FlowState): OnboardingScreenId[] {
  return [
    "welcome",
    ...questionScreens(state),
    "confirm",
    ...(firstResultApplies(state) ? (["first-result"] as const) : []),
    "done",
  ];
}

/**
 * Where a person lands when they come back.
 *
 * The first screen still owed, in order: a record that never entered the
 * flow starts at the welcome, a question still pending is asked, an
 * unconfirmed set of answers goes to confirm, an offered task not yet acted
 * on goes to the first result, and everything else is done. A restart puts
 * every step back to pending, so a restarted flow resumes on Q1 with the old
 * answers as prefill — which is the point of keeping them.
 */
export function resumeScreen(state: FlowState): OnboardingScreenId {
  if (
    !hasEnteredOnboardingFlow({
      ...state,
      completedAt: null,
      firstResult: null,
    })
  ) {
    return "welcome";
  }
  for (const id of questionScreens(state)) {
    if (status(state, id) === "pending") return id;
  }
  if (status(state, "confirm") === "pending") return "confirm";
  if (
    firstResultApplies(state) &&
    status(state, "first-result") === "pending"
  ) {
    return "first-result";
  }
  return "done";
}

export function nextScreen(
  state: FlowState,
  current: OnboardingScreenId,
): OnboardingScreenId | null {
  const order = screenOrder(state);
  const index = order.indexOf(current);
  if (index === -1) return null;
  return order[index + 1] ?? null;
}

export function previousScreen(
  state: FlowState,
  current: OnboardingScreenId,
): OnboardingScreenId | null {
  const order = screenOrder(state);
  const index = order.indexOf(current);
  if (index <= 0) return null;
  return order[index - 1] ?? null;
}

/**
 * May this URL be shown? Everything up to the resume point, nothing past it:
 * going back is always allowed, jumping ahead is bounced to where the flow
 * actually is. A screen the order does not contain (units for someone who
 * ticked no unit-bearing area) is refused too, so a stale link cannot show
 * a question whose answer would mean nothing.
 */
export function canVisitScreen(
  state: FlowState,
  screen: OnboardingScreenId,
): boolean {
  const order = screenOrder(state);
  const index = order.indexOf(screen);
  if (index === -1) return false;
  return index <= order.indexOf(resumeScreen(state));
}

/**
 * "2 of 6" — for the question screens only. The welcome, confirm, first
 * result and done screens carry no counter: the count is a promise about how
 * many questions are left, and those screens are not questions.
 */
export function stepCounter(
  state: FlowState,
  screen: OnboardingScreenId,
): { current: number; total: number } | null {
  const questions = questionScreens(state);
  const index = (questions as readonly string[]).indexOf(screen);
  if (index === -1) return null;
  return { current: index + 1, total: questions.length };
}
