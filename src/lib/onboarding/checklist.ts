/**
 * Pure progression logic for the v1.4 dashboard "Getting started"
 * checklist. Decoupled from React so it can be unit-tested without a
 * DOM. The component layer (`<GettingStartedChecklist>`) reads inputs
 * (auth user + analytics summaries + medications count + Withings
 * status + dismissed-ids set) and renders against the result.
 */

import {
  hasEnteredOnboardingFlow,
  isOnboardingSettled,
  type OnboardingNeeds,
  type OnboardingStateDto,
} from "./needs";

export const CHECKLIST_ITEM_IDS = [
  "profile",
  "measurement",
  "medication",
  "dataSource",
  "notifications",
  "insights",
] as const;

export type ChecklistItemId = (typeof CHECKLIST_ITEM_IDS)[number];

export interface ChecklistItem {
  id: ChecklistItemId;
  done: boolean;
  /**
   * Pre-built href the CTA should jump to. The settings entries point at
   * the v1.4 split routes under `/settings/[section]` (introduced by PR
   * A2-shell), so the CTA lands directly on the right section instead of
   * relying on a hash anchor on the legacy monolith.
   */
  href: string;
  /** True if the user explicitly hid this row. */
  dismissed: boolean;
}

export interface ChecklistInputs {
  /** Profile completeness — height + dateOfBirth + gender all set. */
  profile: {
    heightCm: number | null;
    dateOfBirth: string | null;
    gender: string | null;
  };
  /** Total measurements logged across all types. */
  measurementCount: number;
  /** Number of medications the user has created. */
  medicationCount: number;
  /**
   * True iff at least one data source is connected — Withings, WHOOP,
   * Oura, Polar, Nightscout, Fitbit, or Apple Health. Any one satisfies
   * the "connect a data source" step.
   */
  dataSourceConnected: boolean;
  /**
   * True iff the user has set up at least one notification channel
   * (Telegram, ntfy, or Web Push).
   */
  notificationsConfigured: boolean;
  /**
   * True iff any AI provider can serve this user — a personal key,
   * a local model, an OAuth sign-in, OR the operator's shared key.
   * Derived from `/api/user/ai-provider`'s `aiAvailable`, so the row
   * self-satisfies the moment insights become reachable (including on a
   * deployment that ships a shared operator key). Presence-only — it
   * never decrypts a credential or probes liveness.
   */
  insightsConfigured: boolean;
  /** Dismissed item ids (per-item localStorage state). */
  dismissedIds: ReadonlySet<ChecklistItemId>;
  /**
   * v1.39 (C1) — the needs-based setup state from `GET /api/auth/me`, or null
   * for a record that never entered the flow.
   *
   * Required rather than optional: the ordering below is the whole reason the
   * answers are published, and a caller that stops passing them should fail to
   * compile rather than quietly fall back to the fixed order.
   */
  onboarding: OnboardingStateDto | null;
}

/**
 * v1.39 (C1) — the order the answers imply.
 *
 * The rows themselves are fixed; what the questionnaire decides is which of
 * them a person sees first. Someone who said they take medication daily should
 * not have to scroll past "connect a data source" to find it, and someone who
 * named a wearable should meet that row before the manual-entry one.
 *
 * `profile` stays first whatever the answers say — it is the identity the
 * clinical surfaces derive from, not a domain choice — and any row the answers
 * do not speak to keeps its position relative to the others. The result is a
 * reordering, never a removal: nothing here drops a row.
 */
export function checklistOrderFromNeeds(
  needs: OnboardingNeeds,
): ChecklistItemId[] {
  const promoted: ChecklistItemId[] = [];
  const promote = (id: ChecklistItemId) => {
    if (!promoted.includes(id)) promoted.push(id);
  };

  if (needs.medication === "yes" || needs.medication === "sometimes") {
    promote("medication");
  }
  // "I type them in" and "a file I already have" are not connections, so they
  // say nothing about the data-source row.
  if (needs.sources.some((s) => s !== "manual" && s !== "file")) {
    promote("dataSource");
  }
  if (needs.areas.length > 0) promote("measurement");

  return [
    "profile",
    ...promoted,
    ...CHECKLIST_ITEM_IDS.filter(
      (id) => id !== "profile" && !promoted.includes(id),
    ),
  ];
}

/**
 * Compute the ordered checklist for the dashboard hero. Stable order:
 * profile → measurement → medication → dataSource → notifications →
 * insights. Each item carries the deep-link the row's CTA should
 * navigate to.
 */
export function buildChecklist(inputs: ChecklistInputs): ChecklistItem[] {
  const profileDone = isProfileComplete(inputs.profile);
  const items: ChecklistItem[] = [
    {
      id: "profile",
      done: profileDone,
      href: "/settings/account",
      dismissed: inputs.dismissedIds.has("profile"),
    },
    {
      id: "measurement",
      done: inputs.measurementCount >= 1,
      href: "/measurements",
      dismissed: inputs.dismissedIds.has("measurement"),
    },
    {
      id: "medication",
      done: inputs.medicationCount >= 1,
      href: "/medications",
      dismissed: inputs.dismissedIds.has("medication"),
    },
    {
      id: "dataSource",
      done: inputs.dataSourceConnected,
      href: "/settings/integrations",
      dismissed: inputs.dismissedIds.has("dataSource"),
    },
    {
      id: "notifications",
      done: inputs.notificationsConfigured,
      href: "/settings/notifications",
      dismissed: inputs.dismissedIds.has("notifications"),
    },
    {
      id: "insights",
      done: inputs.insightsConfigured,
      href: "/settings/ai",
      dismissed: inputs.dismissedIds.has("insights"),
    },
  ];
  if (!inputs.onboarding) return items;
  // Ordered from the answers only once the flow has been confirmed: before
  // that the answers are still being given, and re-ordering the dashboard
  // under someone mid-question would be movement they did not ask for.
  if (inputs.onboarding.completedAt === null) return items;
  const order = checklistOrderFromNeeds(inputs.onboarding.needs);
  return order
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is ChecklistItem => item !== undefined);
}

/**
 * The checklist visible to the user — drops dismissed items and items
 * already done **and** hidden by completion. We keep done items
 * visible until the user completes the whole list, so they get the
 * satisfaction of ticking the last box.
 */
export function visibleChecklist(items: ChecklistItem[]): ChecklistItem[] {
  return items.filter((item) => !item.dismissed);
}

export interface ChecklistProgress {
  total: number;
  done: number;
  /** Integer percentage 0-100. */
  percent: number;
  /** True iff every non-dismissed item is done. */
  allDone: boolean;
}

export function checklistProgress(items: ChecklistItem[]): ChecklistProgress {
  const visible = visibleChecklist(items);
  const total = visible.length;
  const done = visible.filter((item) => item.done).length;
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  return { total, done, percent, allDone: total > 0 && done === total };
}

/**
 * Should the dashboard render the checklist at all?
 *
 * Never when the whole list is dismissed, and never when there is no
 * non-dismissed row left to show.
 *
 * For a record that ran the setup flow the design spec retires the old
 * five-reading rule: the list goes when its rows are done or the person hides
 * it. Five readings were never evidence that anything was set up. A record
 * that never entered the flow keeps the pre-v1.39 rule unchanged — first-run
 * wizard unfinished, or fewer than five readings.
 *
 * A list whose rows are all done still stays while the flow itself is
 * unfinished, because the one task the flow offered is not one of the six
 * rows: "every row done" and "the setup finished" are different statements.
 */
export function shouldShowChecklist(args: {
  onboardingCompletedAt: string | null;
  measurementCount: number;
  dismissedAll: boolean;
  items: ChecklistItem[];
  /**
   * v1.39 (C1) — the needs-based setup state for this record, or null before
   * the account payload resolves. A record that never entered the flow reads
   * as empty answers with nine pending steps and is treated as having no
   * unfinished setup, which is what keeps every account that predates the flow
   * on the rule it already had.
   */
  onboarding?: OnboardingStateDto | null;
}): boolean {
  if (args.dismissedAll) return false;
  const onboarding = args.onboarding ?? null;
  const visible = visibleChecklist(args.items);
  if (visible.length === 0) return false;

  const stillInSetup =
    hasEnteredOnboardingFlow(onboarding) ||
    args.onboardingCompletedAt == null ||
    args.measurementCount < 5;
  if (!stillInSetup) return false;

  if (!isOnboardingSettled(onboarding)) return true;
  return visible.some((item) => !item.done);
}

/**
 * Profile is "complete" once height, date of birth and gender are all
 * set. Display name is captured automatically at signup, so it doesn't
 * gate this item.
 */
export function isProfileComplete(
  profile: ChecklistInputs["profile"],
): boolean {
  return (
    profile.heightCm != null &&
    profile.heightCm > 0 &&
    profile.dateOfBirth != null &&
    profile.gender != null &&
    profile.gender !== ""
  );
}

/**
 * Trend hint: when the user has between 1 and 4 readings of a metric we
 * surface "First trend after 5 readings — N more to go". 0 readings is
 * handled by the existing chart empty-state. ≥5 readings hides the
 * hint entirely.
 */
export function trendHintFor(
  count: number,
): { kind: "hidden" } | { kind: "show"; remaining: number } {
  if (count < 1 || count >= 5) return { kind: "hidden" };
  return { kind: "show", remaining: 5 - count };
}
