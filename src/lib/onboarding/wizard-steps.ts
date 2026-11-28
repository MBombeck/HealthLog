/**
 * The step machine behind the person setup screens (v1.50).
 *
 * The flow is a short run of segments, each with one or more screens:
 *
 *   you        who (with the disclaimer), areas, units ("Region & units")
 *   profile    the managed profile, for "someone I look after" and "both"
 *   sources    connect where the readings come from
 *   reminders  where reminders arrive
 *   ai         the Coach, yes or no (only while this server offers it)
 *
 * Which segments a flow has is decided once, on the answer to "who", and
 * pinned on the server (`OnboardingRecord.planJson`), so the stepper's count
 * never changes under the person. Screens inside a segment only advance the
 * segment's fill.
 *
 * The server publishes the ledger (`steps`) and the answers (`needs`); this
 * file turns them into a route. Pure and browser-free, so the page that
 * guards a URL, the screen that decides where "Continue" goes and the frame
 * that paints the stepper all ask the same function.
 *
 * The ledger keeps the step ids it has had since 1.39 (they are the wire
 * contract the account payload publishes). The screens map onto them:
 * `profile` is the `confirm` step for "someone I look after" (the record is
 * created and the answers applied to it there) and the `done` step for
 * "both". The 1.39 questions this flow no longer asks (`medication`,
 * `visit`) and the retired first-result task are passed on the ledger when
 * the answers are confirmed.
 */
import type { OnboardingSourceKey } from "./needs";
import {
  hasEnteredOnboardingFlow,
  ONBOARDING_SKIPPABLE_STEP_IDS,
  type OnboardingOffers,
  type OnboardingRecordTarget,
  type OnboardingStateDto,
  type OnboardingStepId,
} from "./needs";

/**
 * The Q4 sources whose connection the browser can finish on its own, an
 * OAuth handshake or a URL-plus-secret form on Settings › Integrations.
 */
export const BROWSER_CONNECTABLE_SOURCES = [
  "withings",
  "oura",
  "whoop",
  "polar",
  "garmin",
  "fitbit",
  "strava",
  "nightscout",
] as const satisfies readonly OnboardingSourceKey[];

export type BrowserConnectableSource =
  (typeof BROWSER_CONNECTABLE_SOURCES)[number];

export function isBrowserConnectableSource(
  source: string,
): source is BrowserConnectableSource {
  return (BROWSER_CONNECTABLE_SOURCES as readonly string[]).includes(source);
}

/** The segments a person flow can have, in the order they are shown. */
export const PERSON_SEGMENT_IDS = [
  "you",
  "profile",
  "sources",
  "reminders",
  "ai",
] as const;

export type PersonSegmentId = (typeof PERSON_SEGMENT_IDS)[number];

/** The screens, which are also the URL segments under `/onboarding/`. */
export const PERSON_SCREEN_IDS = [
  "who",
  "areas",
  "units",
  "profile",
  "sources",
  "reminders",
  "ai",
] as const;

export type OnboardingScreenId = (typeof PERSON_SCREEN_IDS)[number];

export function isPersonScreenId(value: string): value is OnboardingScreenId {
  return (PERSON_SCREEN_IDS as readonly string[]).includes(value);
}

const SEGMENT_SCREENS: Readonly<
  Record<PersonSegmentId, readonly OnboardingScreenId[]>
> = {
  you: ["who", "areas", "units"],
  profile: ["profile"],
  sources: ["sources"],
  reminders: ["reminders"],
  ai: ["ai"],
};

/** The segment a screen belongs to. */
export function segmentOf(screen: OnboardingScreenId): PersonSegmentId {
  return (
    PERSON_SEGMENT_IDS.find((id) => SEGMENT_SCREENS[id].includes(screen)) ??
    "you"
  );
}

/**
 * The segments for an answer to "who", given whether this server offers the
 * Coach at that moment.
 *
 *   me (or not answered yet)  you, sources, reminders, ai
 *   someone I look after      you, profile (nothing that connects or
 *                             reminds: those belong to the acting account)
 *   both                      you, sources, reminders, ai, profile
 */
export function computePlan(
  recordTarget: OnboardingRecordTarget | null,
  aiOffered: boolean,
): PersonSegmentId[] {
  if (recordTarget === "someone-else") return ["you", "profile"];
  const own: PersonSegmentId[] = ["you", "sources", "reminders"];
  if (aiOffered) own.push("ai");
  if (recordTarget === "both") own.push("profile");
  return own;
}

/** Read a stored plan, fail-soft: anything unreadable is no plan. */
export function parsePinnedPlan(value: unknown): PersonSegmentId[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: PersonSegmentId[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(PERSON_SEGMENT_IDS as readonly string[]).includes(entry) ||
      out.includes(entry as PersonSegmentId)
    ) {
      return null;
    }
    out.push(entry as PersonSegmentId);
  }
  return out[0] === "you" ? out : null;
}

/** What the machine reads: the published state and the pinned plan. */
export type FlowState = Pick<OnboardingStateDto, "steps" | "needs"> & {
  offers?: OnboardingOffers;
  /** The pinned plan, or null to derive it from the answers. */
  plan?: readonly PersonSegmentId[] | null;
};

/** The flow's segments: the pinned plan, or the one the answers give. */
export function planOf(state: FlowState): PersonSegmentId[] {
  return state.plan && state.plan.length > 0
    ? [...state.plan]
    : computePlan(state.needs.recordTarget, state.offers?.ai ?? false);
}

/** The ledger step a screen answers. */
export function ledgerStepOf(
  screen: OnboardingScreenId,
  recordTarget: OnboardingRecordTarget | null,
): OnboardingStepId {
  if (screen === "profile") {
    return recordTarget === "someone-else" ? "confirm" : "done";
  }
  return screen;
}

function status(state: FlowState, id: OnboardingStepId) {
  return state.steps.find((step) => step.id === id)?.status ?? "pending";
}

function screenStatus(state: FlowState, screen: OnboardingScreenId) {
  return status(state, ledgerStepOf(screen, state.needs.recordTarget));
}

/**
 * Every screen this flow shows, in order. The AI screen drops out when the
 * server stopped offering the Coach after the plan was pinned and the person
 * never answered it: a question nobody can act on is not asked.
 */
export function screenOrder(state: FlowState): OnboardingScreenId[] {
  const aiOffered = state.offers?.ai ?? false;
  return planOf(state)
    .flatMap((segment) => SEGMENT_SCREENS[segment])
    .filter(
      (screen) =>
        screen !== "ai" || aiOffered || screenStatus(state, "ai") === "done",
    );
}

/**
 * Where a person lands when they come back: the first screen still owed, or
 * null once every screen of the flow is answered or passed.
 */
export function resumeScreen(state: FlowState): OnboardingScreenId | null {
  if (!hasEnteredOnboardingFlow({ needs: state.needs, completedAt: null })) {
    return "who";
  }
  for (const screen of screenOrder(state)) {
    if (screenStatus(state, screen) === "pending") return screen;
  }
  return null;
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
 * actually is. A screen the order does not contain is refused too.
 */
export function canVisitScreen(
  state: FlowState,
  screen: OnboardingScreenId,
): boolean {
  const order = screenOrder(state);
  const index = order.indexOf(screen);
  if (index === -1) return false;
  const resume = resumeScreen(state);
  const reach = resume === null ? order.length - 1 : order.indexOf(resume);
  return index <= Math.max(reach, 0);
}

/**
 * The stepper's reading of a screen: which segment is current and how far
 * its fill reaches (a segment with three screens fills a third per screen).
 */
export function stepperPosition(
  state: FlowState,
  screen: OnboardingScreenId,
): { segments: PersonSegmentId[]; current: number; fraction: number } {
  const segments = planOf(state);
  const segment = segmentOf(screen);
  const screens = SEGMENT_SCREENS[segment];
  return {
    segments,
    current: Math.max(segments.indexOf(segment), 0),
    fraction: (screens.indexOf(screen) + 1) / screens.length,
  };
}

/**
 * The questions to pass on the ledger before the answers are confirmed:
 * every skippable question this flow does not show and that is still
 * pending. The completion route derives the module map only once EVERY
 * question is answered or passed, and since 1.50 the flow no longer asks the
 * medication and visit questions at all.
 */
type PassableQuestionId = Exclude<
  (typeof ONBOARDING_SKIPPABLE_STEP_IDS)[number],
  "first-result" | "reminders" | "ai"
>;

const QUESTION_IDS: readonly PassableQuestionId[] = [
  "areas",
  "medication",
  "sources",
  "visit",
  "units",
];

export function questionsToPassBeforeConfirm(
  state: FlowState,
): PassableQuestionId[] {
  const shown = new Set<string>(screenOrder(state));
  return QUESTION_IDS.filter(
    (id) => !shown.has(id) && status(state, id) === "pending",
  );
}

/**
 * Whether a pathname is the setup flow's. The auth shell paints these screens
 * without the app chrome.
 */
export function isOnboardingPathname(pathname: string): boolean {
  return pathname === "/onboarding" || pathname.startsWith("/onboarding/");
}
