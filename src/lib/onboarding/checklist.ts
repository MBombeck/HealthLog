/**
 * Pure progression logic for the v1.4 dashboard "Getting started"
 * checklist. Decoupled from React so it can be unit-tested without a
 * DOM. The component layer (`<GettingStartedChecklist>`) reads inputs
 * (auth user + analytics summaries + medications count + Withings
 * status + dismissed-ids set) and renders against the result.
 */

export const CHECKLIST_ITEM_IDS = [
  "profile",
  "measurement",
  "medication",
  "withings",
  "notifications",
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
  /** True iff Withings OAuth is connected (status.connected). */
  withingsConnected: boolean;
  /**
   * True iff the user has set up at least one notification channel
   * (Telegram, ntfy, or Web Push).
   */
  notificationsConfigured: boolean;
  /** Dismissed item ids (per-item localStorage state). */
  dismissedIds: ReadonlySet<ChecklistItemId>;
}

/**
 * Compute the ordered checklist for the dashboard hero. Stable order:
 * profile → measurement → medication → withings → notifications. Each
 * item carries the deep-link the row's CTA should navigate to.
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
      id: "withings",
      done: inputs.withingsConnected,
      href: "/settings/integrations",
      dismissed: inputs.dismissedIds.has("withings"),
    },
    {
      id: "notifications",
      done: inputs.notificationsConfigured,
      href: "/settings/notifications",
      dismissed: inputs.dismissedIds.has("notifications"),
    },
  ];
  return items;
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
 * Visible while the user is still in the setup phase:
 *   - `onboardingCompletedAt` is null  OR
 *   - they have fewer than 5 measurements
 *
 * AND the user has not dismissed the entire checklist
 * AND there is at least one undone, non-dismissed item.
 */
export function shouldShowChecklist(args: {
  onboardingCompletedAt: string | null;
  measurementCount: number;
  dismissedAll: boolean;
  items: ChecklistItem[];
}): boolean {
  if (args.dismissedAll) return false;
  const stillInSetup =
    args.onboardingCompletedAt == null || args.measurementCount < 5;
  if (!stillInSetup) return false;
  const visible = visibleChecklist(args.items);
  if (visible.length === 0) return false;
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
