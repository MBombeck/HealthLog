export interface ScheduleRecurrence {
  daysOfWeek: number[];
  intervalWeeks: number;
}

const ENCODED_PATTERN = /^i([1-4]);(.*)$/;

function normalizeDays(days: number[]): number[] {
  return [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

export function parseScheduleRecurrence(
  value: string | null | undefined,
): ScheduleRecurrence {
  if (!value) {
    return { daysOfWeek: [], intervalWeeks: 1 };
  }

  const encoded = ENCODED_PATTERN.exec(value);
  if (encoded) {
    const intervalWeeks = Number(encoded[1]);
    const days = encoded[2]
      ? encoded[2]
          .split(",")
          .map((token) => Number(token))
          .filter((num) => Number.isFinite(num))
      : [];
    return {
      daysOfWeek: normalizeDays(days),
      intervalWeeks:
        intervalWeeks >= 1 && intervalWeeks <= 4 ? intervalWeeks : 1,
    };
  }

  // Legacy format: "1,2,3"
  const legacyDays = value
    .split(",")
    .map((token) => Number(token))
    .filter((num) => Number.isFinite(num));
  return { daysOfWeek: normalizeDays(legacyDays), intervalWeeks: 1 };
}

export function serializeScheduleRecurrence(
  recurrence: ScheduleRecurrence,
): string | null {
  const days = normalizeDays(recurrence.daysOfWeek);
  const intervalWeeks =
    recurrence.intervalWeeks >= 1 && recurrence.intervalWeeks <= 4
      ? recurrence.intervalWeeks
      : 1;

  if (intervalWeeks === 1 && days.length === 0) return null;
  if (intervalWeeks === 1) return days.join(",");
  return `i${intervalWeeks};${days.join(",")}`;
}

