import { Flame, RotateCw } from "lucide-react";

import { ComplianceInfoTip } from "@/components/medications/card-parts/compliance-info-tip";
import { Progress } from "@/components/ui/progress";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

interface MedicationComplianceBarsProps {
  rate7: number;
  rate30: number;
  streak: number;
  /**
   * v1.8.6 — the span of the short row in days. The server scales the two
   * windows to the dosing cadence (7 / 30 for dense meds, stepping up to
   * 90 / 365 for sparse ones), so the labels follow the chosen windows
   * instead of a hardcoded 7 / 30. Defaults to 7 / 30 so older callers and
   * fixtures keep their prior labels.
   */
  shortDays?: number;
  /** v1.8.6 — the span of the long row in days. */
  longDays?: number;
  /**
   * Projected supply runway in whole days, set ONLY while it sits below the
   * user's low-stock threshold (the card variants gate it). Non-null renders
   * the muted warning-toned "Vorrat: ≈ N Tage" notice on the meta row, flush
   * right beside the streak flame; null keeps the row free of stock noise.
   */
  lowStockRunwayDays?: number | null;
}

/**
 * The always-mounted `min-h-4` meta row beneath the two bars. It carries the
 * streak flame (left) and, when supply has dropped below the user's runway
 * threshold, the low-stock notice (right, `ml-auto`). Both ride the SAME
 * reserved slot every compliance state already holds, so the low-stock line
 * no longer inserts a flow row above the bars — the two bars stay aligned
 * across a grid row whether or not a card is low on supply. The row stays
 * mounted at `min-h-4` even when empty so a streak / low-stock state arriving
 * or expiring never changes the card height.
 */
function ComplianceMetaRow({
  streak,
  lowStockRunwayDays,
}: {
  streak: number;
  lowStockRunwayDays: number | null;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex min-h-4 items-center gap-4 text-xs">
      {streak > 0 && (
        <span className="text-warning flex items-center gap-1 font-medium">
          <Flame className="h-3.5 w-3.5" />
          {streak}{" "}
          {streak === 1
            ? t("medications.dayStreakOne")
            : t("medications.dayStreak")}
        </span>
      )}
      {lowStockRunwayDays != null && (
        <span
          className="text-warning ml-auto font-medium"
          data-slot="medication-card-low-stock"
        >
          {t("medications.cardLowStockRunway", { days: lowStockRunwayDays })}
        </span>
      )}
    </div>
  );
}

/**
 * Shared two-row compliance bars plus the day-streak flame for the
 * medication cards. Extracted from the generic and GLP-1 cards so the bars
 * are structurally identical rather than hand-synced.
 *
 * v1.8.6 — the two windows scale with the dosing cadence. A daily med shows
 * 7-day / 30-day; a weekly med 30-day / 90-day; a rare injection up to a
 * 365-day long window. The labels are parametrised on the chosen day-counts
 * so each row names the window it actually covers.
 *
 * v1.15.9 — the per-row dose count (`· 12 / 12`) is gone: the operator wants
 * the percentage only. The auto-miss engine now makes the two windows'
 * percentages genuinely diverge, so the counts no longer earn the row noise.
 * The engine still carries `expected` / `taken` / `missed` on the wire for
 * iOS + the Health Score; the card simply does not render them.
 *
 * The streak flame uses the semantic `text-warning` token (an alias over
 * Dracula orange in dark mode, AA-safe on the light card). The generic card
 * historically drifted onto Tailwind stock `text-orange-400`, and the flame
 * later carried the raw `text-warning` palette token; v1.12.2 routes
 * it through the semantic vocabulary the rest of the status surface uses.
 */
export function MedicationComplianceBars({
  rate7,
  rate30,
  streak,
  shortDays = 7,
  longDays = 30,
  lowStockRunwayDays = null,
}: MedicationComplianceBarsProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const shortLabel = t("medications.complianceWindow", { days: shortDays });
  const longLabel = t("medications.complianceWindow", { days: longDays });

  // v1.12.2 — route the rate through the locale number formatter and round
  // so a non-integer rate (e.g. 33.333) never leaks raw into the caption,
  // matching how every other percentage renders.
  const shortRounded = Math.round(rate7);
  const longRounded = Math.round(rate30);
  const shortPct = fmt.number(shortRounded);
  const longPct = fmt.number(longRounded);

  // v1.16.6 — both rows carry an identical, FIXED geometry: the label line
  // is pinned to one text line (`h-5` + `truncate`) and the bar to `h-2`,
  // so neither a long locale label wrapping, nor the `?` trigger, nor any
  // status-coloured caption can make the two rows differ in height. Status
  // is colour / text only — never geometry; the two bars on a card (and
  // across a grid row) always align.
  return (
    // Both rates ride the block as plain data attributes. The percentages
    // themselves are locale-formatted text inside a fixed-height caption, and
    // the bar beside them is a shadcn `Progress` that keeps its value for the
    // indicator transform and never forwards it to the primitive — so the one
    // number this card exists to show has, until now, been readable only by
    // parsing a translated string. The attributes carry the ROUNDED value the
    // caption renders, so a reader and an assertion see the same figure.
    // Presentation is untouched; the loading and error variants below stay
    // free of them, which is what makes their presence mean "loaded".
    <div
      className="space-y-2.5"
      data-slot="medication-card-compliance"
      data-rate-short={shortRounded}
      data-rate-long={longRounded}
    >
      <div className="space-y-1.5">
        <div className="flex h-5 items-center justify-between text-sm">
          <span className="text-muted-foreground flex min-w-0 items-center gap-1">
            <span className="truncate">{shortLabel}</span>
            {/* One `?` for the whole block — both rows measure the same
                thing over different windows, so a second trigger on the
                long row would only add noise. */}
            <ComplianceInfoTip />
          </span>
          <span className="shrink-0 font-medium">{shortPct}%</span>
        </div>
        {/* aria-label so the bar has an accessible name. */}
        <Progress value={rate7} className="h-2" aria-label={shortLabel} />
      </div>

      <div className="space-y-1.5">
        <div className="flex h-5 items-center justify-between text-sm">
          <span className="text-muted-foreground min-w-0 truncate">
            {longLabel}
          </span>
          <span className="shrink-0 font-medium">{longPct}%</span>
        </div>
        <Progress value={rate30} className="h-2" aria-label={longLabel} />
      </div>

      {/* Streak flame + low-stock notice — the shared meta row, always
          mounted at `min-h-4` so a streak or low-stock state arriving (or
          expiring) never changes the card height and the action row below
          stays on one baseline across a grid row. The skeleton and error
          fallbacks reserve the same slot through the same component. */}
      <ComplianceMetaRow
        streak={streak}
        lowStockRunwayDays={lowStockRunwayDays}
      />
    </div>
  );
}

/**
 * Constant-height placeholder for the compliance block, shown while the
 * per-card `/compliance` query is in flight or returns null. Without it a
 * card whose compliance has not yet resolved is ~5rem shorter than a sibling
 * whose compliance loaded, so the two cards in a 2-col grid row jump to
 * unequal heights (transiently on first paint, persistently for any med
 * whose endpoint returns null). The skeleton mirrors the two-bar layout's
 * footprint so the card body keeps a constant inventory and the action row
 * pins to the same baseline across the row.
 *
 * The streak-flame slot IS reserved (`min-h-4`, matching the loaded card's
 * always-mounted row) — the loaded card reserves it whether or not a streak
 * exists, so the skeleton must too or a resolving card would grow by one
 * row and shift the grid.
 */
export function MedicationComplianceSkeleton({
  lowStockRunwayDays = null,
}: {
  lowStockRunwayDays?: number | null;
}) {
  return (
    <div className="space-y-2.5">
      {/* Only the bars are a placeholder; the meta row below is real (the
          low-stock runway is independent of the in-flight compliance query),
          so a card that sits on the skeleton still surfaces low supply and
          announces it. */}
      <div className="space-y-2.5" aria-hidden>
        <div className="space-y-1.5">
          <div className="flex h-5 items-center justify-between">
            <span className="bg-muted h-4 w-20 rounded" />
            <span className="bg-muted h-4 w-9 rounded" />
          </div>
          <div className="bg-muted h-2 rounded" />
        </div>
        <div className="space-y-1.5">
          <div className="flex h-5 items-center justify-between">
            <span className="bg-muted h-4 w-20 rounded" />
            <span className="bg-muted h-4 w-9 rounded" />
          </div>
          <div className="bg-muted h-2 rounded" />
        </div>
      </div>
      <ComplianceMetaRow streak={0} lowStockRunwayDays={lowStockRunwayDays} />
    </div>
  );
}

/**
 * Quiet error fallback for the compliance block, shown when the batched
 * `/api/medications/compliance` query failed after its retries. Mirrors
 * the skeleton's two-row footprint exactly (same `h-5` label lines, same
 * `h-2` bar slots, same gaps) so the card height never jumps between the
 * loading, loaded, and failed states. No bars are drawn — a failed read
 * must not paint a 0 % adherence — just one muted notice line and a small
 * retry affordance that refetches the shared query for every card at once.
 */
export function MedicationComplianceError({
  onRetry,
  lowStockRunwayDays = null,
}: {
  onRetry: () => void;
  lowStockRunwayDays?: number | null;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex h-5 items-center text-sm">
          <span className="text-muted-foreground min-w-0 truncate">
            {t("medications.complianceUnavailable")}
          </span>
        </div>
        <div className="bg-muted/40 h-2 rounded" />
      </div>
      <div className="space-y-1.5">
        <div className="flex h-5 items-center">
          <button
            type="button"
            onClick={onRetry}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs underline-offset-2 hover:underline"
          >
            <RotateCw className="h-3 w-3" aria-hidden="true" />
            {t("common.retry")}
          </button>
        </div>
        <div className="bg-muted/40 h-2 rounded" />
      </div>
      {/* Meta-row parity with the loaded card + skeleton — still surfaces
          low supply even when the compliance read failed. */}
      <ComplianceMetaRow streak={0} lowStockRunwayDays={lowStockRunwayDays} />
    </div>
  );
}
