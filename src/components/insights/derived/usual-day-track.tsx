import type { SameTimeDayRangeReached } from "@/lib/insights/derived/same-time-baseline";

/**
 * The picture of the day-total form of the "Today so far" tile:
 * today's running total as a filled bar, the usual full day as a shaded band
 * (its middle half) with a tick at its median, all on one scale from zero.
 *
 * It replaces the two-curve sparkline when the source reports the day as one
 * total, because there is no curve to draw: the bar says how far the day has
 * come against a whole usual day and nothing about the hour. Every number is
 * the server's; this only places them. Decorative for assistive technology,
 * since the value and the framing line beside it say the same in words.
 */
export function UsualDayTrack({
  today,
  low,
  median,
  high,
  reached,
}: {
  today: number;
  low: number;
  median: number;
  high: number;
  reached: SameTimeDayRangeReached;
}) {
  // Room past the usual day's upper edge, and past today when today is
  // further still, so neither the band nor the bar ends flush with the track.
  const scale = Math.max(high * 1.25, today * 1.05, median, 1);
  const pct = (v: number) =>
    `${Math.max(0, Math.min(100, (Math.max(0, v) / scale) * 100))}%`;
  // A day that reached its usual range reads in the success tone, the same
  // tone the hourly tile gives a day ahead of its usual curve. Below the
  // range is the normal state of a morning and stays neutral, never a warning.
  const fill =
    reached === "not_yet" ? "var(--muted-foreground)" : "var(--success)";

  return (
    <div
      className="relative h-full w-full"
      data-slot="usual-day-track"
      data-reached={reached}
      aria-hidden="true"
    >
      <div
        className="bg-muted-foreground/20 absolute top-1/2 h-4 -translate-y-1/2 rounded-sm"
        data-slot="usual-day-track-band"
        style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` }}
      />
      <div className="bg-muted absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          data-slot="usual-day-track-today"
          style={{ width: pct(today), background: fill }}
        />
      </div>
      <div
        className="bg-foreground absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        data-slot="usual-day-track-median"
        style={{ left: pct(median) }}
      />
    </div>
  );
}
