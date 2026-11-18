/**
 * The Today overview's medications fact (#173): the doses taken against the
 * doses due so far, or, before the first one is due with nothing taken, when
 * the next one is.
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
  const count = (taken: number, due: number) =>
    fact(
      t("daily.todayFact.medications.value", {
        taken: Math.min(taken, due),
        scheduled: due,
      }),
    );
  // A snapshot cached before the slot times were kept counts the whole day.
  if (!scheduledTodayAt) return count(takenToday, scheduledToday);

  // #173 — "0 of 5 taken" at seven in the morning reads like five missed
  // doses. Count only the doses due so far; before the first one is due,
  // and with nothing taken or overdue, say when the next one is.
  const now = input.now.getTime();
  const dueSoFar = scheduledTodayAt.filter(
    (at) => Date.parse(at) <= now,
  ).length;
  const nextAt = nextDueAt ? Date.parse(nextDueAt) : NaN;
  if (
    dueSoFar === 0 &&
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
  // A dose taken before its time counts as due: never "1 of 0".
  const due = Math.max(dueSoFar, Math.min(takenToday, scheduledToday));
  return due > 0 ? count(takenToday, due) : count(takenToday, scheduledToday);
}
