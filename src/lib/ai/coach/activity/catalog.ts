/**
 * v1.41 — the labels of a turn's trail, rendered on the server in the
 * request locale.
 *
 * Every label is catalog text with server-chosen values: a domain and a
 * window from their closed enums, a count the server took. Model text never
 * reaches a label; it rides `title` and `text` on the entry, after
 * screening (`screen.ts`).
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type {
  CoachScopeWindow,
  CoachStepDomain,
  CoachStopReason,
} from "@/lib/ai/coach/types";
import {
  coachDomainLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";

import {
  COACH_ACTIVITY_KEYS,
  COACH_ACTIVITY_STOP_KEYS,
  activityAreasKey,
  activityDigestDoneKey,
  activityDigestKey,
  activityMemoryKey,
} from "./contract";

export interface ActivityLabel {
  labelKey: string;
  label: string;
}

function render(
  locale: Locale,
  labelKey: string,
  values?: Record<string, string | number>,
): ActivityLabel {
  return { labelKey, label: getServerTranslator(locale).t(labelKey, values) };
}

type SimplePhase = keyof typeof COACH_ACTIVITY_KEYS;

/** The labels with no value: thinking, remembering, planning, asking, answering. */
export function simpleActivityLabel(
  locale: Locale,
  phase: Exclude<SimplePhase, "fetching">,
): ActivityLabel {
  return render(locale, COACH_ACTIVITY_KEYS[phase]);
}

/**
 * "Fetching weight, last 30 days…". A read without a window (the cycle, the
 * patterns between metrics) has no true window to name, so it is labelled
 * with the step's own catalog label instead, passed as `fallback`.
 */
export function fetchActivityLabel(
  locale: Locale,
  args: {
    domain: CoachStepDomain;
    window?: CoachScopeWindow;
    fallback?: ActivityLabel;
  },
): ActivityLabel {
  const { t } = getServerTranslator(locale);
  if (!args.window) {
    return (
      args.fallback ??
      render(locale, COACH_ACTIVITY_KEYS.fetching, {
        domain: t(coachDomainLabelKey(args.domain)),
        window: t(coachWindowLabelKey("allTime")),
      })
    );
  }
  return render(locale, COACH_ACTIVITY_KEYS.fetching, {
    domain: t(coachDomainLabelKey(args.domain)),
    window: t(coachWindowLabelKey(args.window)),
  });
}

/** "Summarising 412 readings…", while a round's results are folded in. */
export function digestActivityLabel(
  locale: Locale,
  count: number,
): ActivityLabel {
  return render(locale, activityDigestKey(count, locale), { count });
}

/** "412 readings from 2 areas", once the round has settled. */
export function digestDoneActivityLabel(
  locale: Locale,
  count: number,
  areas: number,
): ActivityLabel {
  const { t } = getServerTranslator(locale);
  return render(locale, activityDigestDoneKey(count, locale), {
    count,
    areas: t(activityAreasKey(areas, locale), { count: areas }),
  });
}

/** "Recalls 3 things you told it". */
export function memoryActivityLabel(
  locale: Locale,
  count: number,
): ActivityLabel {
  return render(locale, activityMemoryKey(count, locale), { count });
}

/** "Time limit reached, answering with what it has". */
export function stopActivityLabel(
  locale: Locale,
  reason: CoachStopReason,
): ActivityLabel {
  return render(locale, COACH_ACTIVITY_STOP_KEYS[reason]);
}
