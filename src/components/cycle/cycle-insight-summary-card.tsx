"use client";

import Link from "next/link";
import { ArrowRight, Droplets } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/ui/section-heading";
import { CyclePhaseHeadline } from "./cycle-phase-crosstab";
import { PHASE_HUE } from "./phase-tokens";
import {
  useCycleCalendar,
  useCycleInsights,
  useCycleWindow,
} from "./use-cycle";
import { QueryErrorRow } from "@/components/ui/query-error-row";

/**
 * v1.15.2 — the gated cycle-insights summary card for the main Insights page.
 *
 * A compact TEASER + entry point, never a duplicate of the full cycle insights
 * tab. It surfaces three things and links into the source of truth:
 *   1. the current phase (name + hue dot) and cycle day, read from the SAME
 *      server-resolved `verdict` on the calendar read the cycle wheel uses, so
 *      the two surfaces can never disagree on the day-of-cycle or phase;
 *   2. the one headline phase finding, rendered through the SHARED
 *      `<CyclePhaseHeadline>` (which already owns the FDR-gated copy + the
 *      honest "not enough cycles yet" empty line) — no re-implementation;
 *   3. a "view details" deep-link into `/cycle?tab=insights`.
 *
 * Visual idiom mirrors `phase-education-card.tsx`: a hue-tinted `wellness-tile`
 * keyed to the ACTIVE phase via `--tile-hue`, with one calm entrance that the
 * global `prefers-reduced-motion` block already zeroes. The phase semantic is
 * never colour-only — the phase word + an aria-label always accompany the hue.
 *
 * GATING IS THE CALLER'S JOB: the page only mounts this when
 * `user.cycleTrackingEnabled` is true (the same `/api/auth/me` signal the
 * sidebar nav entry uses), so the two cycle reads never fire for an account
 * without the feature. The component additionally renders nothing while the
 * calendar read is still resolving and on a hard read error, so it never shows
 * a broken or empty-framed state on the overview.
 */

export function CycleInsightSummaryCard() {
  const { t } = useTranslations();

  // Mirror the cycle-view window so the cache key is shared (no extra request
  // when the user later opens the cycle page in the same session).
  const { from, to } = useCycleWindow();

  const calendar = useCycleCalendar(from, to);
  const insights = useCycleInsights();
  // The server's resolved verdict — the teaser reports it, never recomputes it.
  const verdict = calendar.data?.verdict;

  // Stay silent until the calendar read resolves: the overview must never
  // show a half-painted teaser. A failed read is said with a retry, since
  // drawing nothing would read as "no cycle tracked".
  if (calendar.isLoading && !calendar.data) return null;
  if (calendar.isError && !calendar.data) {
    return (
      <section
        data-slot="cycle-insight-summary-section"
        aria-label={t("cycle.insightsSummary.title")}
        className="space-y-3"
      >
        <SectionHeading
          icon={Droplets}
          title={t("cycle.insightsSummary.title")}
        />
        <QueryErrorRow
          error={calendar.error}
          slot="cycle-insight-summary-error"
          onRetry={() => void calendar.refetch()}
        />
      </section>
    );
  }

  const phase = verdict?.phase ?? null;
  const hue = phase ? PHASE_HUE[phase] : PHASE_HUE.LUTEAL;
  const phaseName = phase ? t(`cycle.phase.${phase}`) : t("cycle.phase.none");
  const dayOfCycle = verdict?.dayOfCycle ?? null;

  const ariaLabel =
    phase && dayOfCycle != null
      ? t("cycle.ring.ariaPhase", { day: dayOfCycle, phase: phaseName })
      : t("cycle.ring.ariaUnknown");

  return (
    // `data-revealed` must sit on an ANCESTOR of the `.wellness-tile-rise`
    // element — the keyframe selector is `[data-revealed="true"]
    // .wellness-tile-rise` (descendant combinator). Putting both on the same
    // node never matched, so the tile stayed stuck at the rise rule's
    // `opacity: 0` — invisible but still occupying its box, which read as an
    // oversized gap on the overview. The wrapper restores the entrance.
    <section
      data-slot="cycle-insight-summary-section"
      aria-label={t("cycle.insightsSummary.title")}
      className="space-y-3"
    >
      <SectionHeading
        icon={Droplets}
        title={t("cycle.insightsSummary.title")}
      />
      {/* `data-revealed` must sit on an ANCESTOR of the `.wellness-tile-rise`
          element — the keyframe selector is `[data-revealed="true"]
          .wellness-tile-rise` (descendant combinator). */}
      <div data-revealed="true" className="contents">
        <div
          data-slot="cycle-insight-summary"
          data-phase={phase ?? "none"}
          style={{ "--tile-hue": hue } as React.CSSProperties}
          className="wellness-tile wellness-tile-rise rounded-xl p-4 md:p-6"
        >
          {/* Zone 1 — the current phase / cycle-day read. */}
          <div className="min-w-0">
            <h3
              className="text-foreground flex items-center gap-2 text-base font-semibold"
              aria-label={ariaLabel}
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: hue }}
              />
              <span>{phaseName}</span>
            </h3>

            <p
              className="text-muted-foreground mt-1 text-sm"
              aria-hidden="true"
            >
              {dayOfCycle != null
                ? t("cycle.insightsSummary.currentDay", { day: dayOfCycle })
                : t("cycle.insightsSummary.noActiveCycle")}
            </p>
          </div>

          {/* Zone 2 — the one headline phase finding (shared component owns the
            FDR-gated copy AND the honest "not enough cycles yet" empty line, so
            this can never show a broken state). */}
          <div className="mt-3">
            <CyclePhaseHeadline headline={insights.data?.headline ?? null} />
          </div>

          {/* Zone 3 — the deep-link into the single source of truth: the cycle
            insights tab. The cycle page reads `?tab=insights` and opens it. */}
          <Link
            href="/cycle?tab=insights"
            data-slot="cycle-insight-summary-link"
            className="text-foreground bg-background/55 border-foreground/15 hover:bg-background/80 focus-visible:ring-ring/50 mt-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-[3px]"
          >
            {t("cycle.insightsSummary.viewDetails")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
