"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W3e — 7-day consistency strip.
 *
 * Renders one dot per Berlin-tz day in `days` (oldest → newest, index 6
 * is today). Each dot's appearance encodes both whether the day was
 * logged and whether the day's mean reading landed in the target's
 * green band:
 *
 *   • Solid green   — `"in"`   : day's mean was in the target band
 *   • Solid amber   — `"near"` : day's mean was in the orange band
 *   • Solid red     — `"out"`  : day's mean was outside both bands
 *   • Hollow ring   — `null`   : day had no readings (dim border only)
 *
 * Cap to the right: "5 of 7 in range" (or the user's locale's
 * equivalent). The cap reads off `daysInRange` and `daysLogged`. When
 * the cap would be misleading on thin data (≤ 2 days logged) we surface
 * "X of 7 logged" instead so the user sees the cadence problem, not the
 * misleading range count.
 *
 * Hidden by the parent when the target's `insufficientData` flag is
 * true — there is no "— not enough data" empty-state mode here; the
 * card surfaces that copy in a different slot per Marc's "no empty hint
 * inside the strip" directive.
 *
 * Visual rationale (frontend-design skill): seven dots over the v1.4.22
 * 24-px sparkline trades a continuous-but-distorted signal for seven
 * honest atomic answers. The hollow-ring "no data" state means the
 * gap is visible without leaving the user wondering whether the
 * sparkline simply ended there.
 */
export type ConsistencyBand = "in" | "near" | "out" | null;

export interface ConsistencyStripProps {
  /**
   * Seven entries, index 0 = six days ago, index 6 = today. Anything
   * other than 7 is rendered as-is (so callers can pass a short array
   * for tests), but the live API always sends exactly 7.
   */
  days: ReadonlyArray<ConsistencyBand>;
  daysInRange: number;
  daysLogged: number;
  className?: string;
}

// An arbitrary shadow utility with an opacity modifier (a "/20" suffix
// on the bracketed value) hits the same Turbopack CSS-parser issue as
// the bracket-form CSS-variable utilities — see the comment in
// target-card.tsx for the full diagnosis. The shadow's alpha is now
// encoded inside the value via color-mix so the opacity modifier is
// no longer needed and the bracketed form parses cleanly.
const BAND_STYLES: Record<NonNullable<ConsistencyBand>, string> = {
  in: "bg-(--dracula-green) border-(--dracula-green) shadow-[0_0_0_1px_color-mix(in_oklab,var(--dracula-green)_20%,transparent)]",
  near: "bg-(--dracula-orange) border-(--dracula-orange)",
  out: "bg-(--dracula-red) border-(--dracula-red)",
};

const BAND_ARIA: Record<NonNullable<ConsistencyBand>, string> = {
  in: "targets.consistency.dotInRange",
  near: "targets.consistency.dotNearRange",
  out: "targets.consistency.dotOutOfRange",
};

const RELATIVE_DAY_KEYS = [
  "targets.consistency.relativeDay.sixDaysAgo",
  "targets.consistency.relativeDay.fiveDaysAgo",
  "targets.consistency.relativeDay.fourDaysAgo",
  "targets.consistency.relativeDay.threeDaysAgo",
  "targets.consistency.relativeDay.twoDaysAgo",
  "targets.consistency.relativeDay.yesterday",
  "targets.consistency.relativeDay.today",
];

export function ConsistencyStrip({
  days,
  daysInRange,
  daysLogged,
  className,
}: ConsistencyStripProps) {
  const { t } = useTranslations();

  // Cap rule: if very few days logged, surface the cadence problem
  // ("X of 7 logged") rather than the misleading range count. The
  // threshold matches the server's `insufficientData < 3 readings`
  // guard one tier lower so the strip can still render gracefully
  // when the parent decided to mount it.
  const showLoggedCap = daysLogged <= 2;
  const cap = showLoggedCap
    ? t("targets.consistency.daysLogged", {
        count: String(daysLogged),
        total: "7",
      })
    : t("targets.consistency.daysInRange", {
        count: String(daysInRange),
        total: "7",
      });

  return (
    <div
      data-slot="consistency-strip"
      className={cn(
        "flex items-center justify-between gap-3 text-xs",
        className,
      )}
    >
      <ul
        role="list"
        aria-label={t("targets.consistency.ariaLabel")}
        className="flex items-center gap-1.5"
      >
        {days.map((band, index) => {
          const relativeKey =
            RELATIVE_DAY_KEYS[
              index + (RELATIVE_DAY_KEYS.length - days.length)
            ] ?? RELATIVE_DAY_KEYS[RELATIVE_DAY_KEYS.length - 1];
          const dayLabel = t(relativeKey);
          const statusLabel = band
            ? t(BAND_ARIA[band])
            : t("targets.consistency.dotNotLogged");
          return (
            <li
              key={`${index}-${band ?? "none"}`}
              aria-label={`${dayLabel}: ${statusLabel}`}
              data-band={band ?? "none"}
              className={cn(
                "size-2.5 rounded-full border transition-colors",
                band ? BAND_STYLES[band] : "border-border bg-transparent",
              )}
            />
          );
        })}
      </ul>
      <span
        className="text-muted-foreground tabular-nums"
        data-slot="consistency-cap"
      >
        {cap}
      </span>
    </div>
  );
}
