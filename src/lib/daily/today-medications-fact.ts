/**
 * The Today overview's medications fact: the doses taken against every dose
 * scheduled for the person's local day (#1412), or, before the first one is
 * due with nothing taken, when the next one is (#173).
 */
import type { TodayFact, TodayOverviewInput } from "@/lib/daily/today-overview";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export function medicationsFact(
  input: Pick<
    TodayOverviewInput,
    "modules" | "medsToday" | "now" | "nextDoseTimeLabel"
  >,
  t: Translate,
): TodayFact | null {
  if (input.modules.medications === false) return null;
  const { scheduledToday, takenToday, scheduledTodayAt, nextDueAt } =
    input.medsToday;
  if (scheduledToday <= 0) return null;
  const fact = (value: string): TodayFact => ({
    kind: "medications",
    label: t("daily.todayFact.medications.label"),
    value,
    href: "/medications",
    moduleKey: "medications",
  });
  // The total is the whole day: every dose the projection scheduled for
  // today, whether its time has come or not. A window dose that is open to
  // take, or an evening dose, still belongs to today's count (#1412).
  const dayCount = fact(
    t("daily.todayFact.medications.value", {
      taken: Math.min(takenToday, scheduledToday),
      scheduled: scheduledToday,
    }),
  );
  // A snapshot cached before the slot times were kept cannot tell whether a
  // dose was due yet.
  if (!scheduledTodayAt) return dayCount;

  // #173 — "0 of 5 taken" at seven in the morning reads like five missed
  // doses. Before the first dose is due, and with nothing taken or overdue,
  // say when the next one is instead.
  // A dose is due from the moment its window opens, not only at its anchor:
  // a 12:00 to 22:00 window anchored at 17:00 is takeable at 13:00. Only a
  // candidate falling on one of today's slots counts, so a weekly dose whose
  // early window reaches into today stays tomorrow's business.
  const now = input.now.getTime();
  const todaySlots = new Set(scheduledTodayAt.map((at) => Date.parse(at)));
  const anyWindowOpen = (input.medsToday.dueCandidates ?? []).some(
    (c) =>
      todaySlots.has(Date.parse(c.dueAt)) && Date.parse(c.availableFrom) <= now,
  );
  const anyDueSoFar =
    anyWindowOpen || scheduledTodayAt.some((at) => Date.parse(at) <= now);
  const nextAt = nextDueAt ? Date.parse(nextDueAt) : NaN;
  if (
    !anyDueSoFar &&
    takenToday === 0 &&
    !input.medsToday.nextDueOverdue &&
    input.nextDoseTimeLabel &&
    Number.isFinite(nextAt) &&
    nextAt > now
  ) {
    return fact(
      t("daily.todayFact.medications.next", {
        time: input.nextDoseTimeLabel,
      }),
    );
  }
  return dayCount;
}
