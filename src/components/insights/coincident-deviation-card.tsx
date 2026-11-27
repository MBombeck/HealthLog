"use client";

import { AlertTriangle, Activity } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/ui/section-heading";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { ProvenanceExplainer } from "@/components/insights/derived/provenance-explainer";
import { METRIC_PROVENANCE } from "@/components/insights/derived/standards";
import { useDerivedMetric } from "@/components/insights/derived/use-derived-metric";
// Type-only — the compute payload never drags the server graph into the bundle
// (the v1.9.0 lesson, mirrored at vitals-dashboard.tsx).
import type { CoincidentDeviationValue } from "@/lib/insights/derived/coincident-deviation";
import type { DerivedProvenance } from "@/lib/insights/derived/types";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.10.3 — "Today's signal" headline card.
 *
 * Surfaces the COINCIDENT_DEVIATION flag at the top of the Insights overview as
 * a calm awareness read drawn off the SINGLE existing `Derived` payload — no new
 * engine math, no new route, no schema change.
 *
 * The card renders ONLY when there is an actual signal to show. A day where
 * every vital sits inside its personal range (all-clear), or an account still
 * building its baselines (insufficient), produces no card at all — the section
 * stays absent rather than surfacing an empty header. The two states that DO
 * render:
 *   - watch (ok, 1 contributing vital, or a thin-history multi-signal flag) →
 *     a calm, non-alert line naming the vital.
 *   - fired (ok, fired, ≥ 2 contributing, with enough history) → an amber
 *     awareness card naming the vitals + the load-bearing "possible factors —
 *     never a cause" line.
 *
 * Restraint guarantees: at most the `warning` (amber) band — never
 * `destructive`/red, never a score, never a chart (so no Recharts), never a
 * push. When `confidence.band` is thin (low/draft) the fired tone is softened
 * to the watch tone + the coverage meter, so a multi-signal flag from too
 * little history never reads as a confident verdict.
 */

const COINCIDENT_METRIC = "COINCIDENT_DEVIATION";

interface CoincidentDeviationCardProps {
  /** Gate the underlying derived-metric read (e.g. on the auth flag). */
  enabled?: boolean;
  className?: string;
}

/** The four calm visual states, derived from the single payload. */
type SignalState = "insufficient" | "all-clear" | "watch" | "fired";

/** The provenance ⓘ explainer for the coincident flag, wired from the map. */
function CoincidentProvenance({
  provenance,
}: {
  provenance: DerivedProvenance;
}) {
  const { t } = useTranslations();
  const meta = METRIC_PROVENANCE.COINCIDENT_DEVIATION;
  const method = t(meta.methodKey);
  return (
    <ProvenanceExplainer
      provenance={provenance}
      method={method}
      standard={meta.standard}
    />
  );
}

/**
 * The card shell — the "Signals of the day" heading lives ABOVE the card now
 * (via `SectionHeading`, mirroring every other overview section), with the
 * provenance ⓘ as the heading's trailing action. The card body carries the
 * state-specific content. The tall `fired` state keeps a `min-h` floor; the
 * calmer everyday states size to their (short) content so the card carries no
 * empty tail.
 */
function CardShell({
  state,
  provenance,
  className,
  children,
}: {
  state: SignalState;
  provenance?: DerivedProvenance;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <section
      data-slot="coincident-deviation-section"
      aria-label={t("insights.derived.coincident.cardTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Activity}
        title={t("insights.derived.coincident.cardTitle")}
        action={
          provenance ? (
            <CoincidentProvenance provenance={provenance} />
          ) : undefined
        }
      />
      <InsightSectionCard
        slot="coincident-deviation-card"
        data-state={state}
        className={cn(
          // `min-h` floor only on the tallest state (fired: the named-vitals
          // body + the mandatory factors line). The calmer everyday states
          // (all-clear / watch / insufficient) carry a single short body, so
          // flooring them to the fired height left a large empty tail; they now
          // size to their content. The in-flight `CardSkeleton` keeps the
          // `min-h-48` footprint so the initial paint still reserves the row and
          // does not shift as the read resolves.
          state === "fired" && "min-h-32",
          // At most amber — never destructive/red. The fired state borders
          // warning; every calmer state keeps the neutral card border.
          state === "fired" ? "border-warning/40" : "border-border",
        )}
      >
        {children}
      </InsightSectionCard>
    </section>
  );
}

/**
 * A fixed-footprint skeleton matching the resolved card geometry exactly
 * (CLS-safe): the same `min-h-48` shell, the same gap, and a 44px header row
 * mirroring the provenance trigger the resolved header carries — so the card
 * does not shift when the real content drops in.
 */
function CardSkeleton({ className }: { className?: string }) {
  const { t } = useTranslations();
  return (
    <section
      data-slot="coincident-deviation-section"
      aria-label={t("insights.derived.coincident.cardTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Activity}
        title={t("insights.derived.coincident.cardTitle")}
      />
      <InsightSectionCard
        slot="coincident-deviation-card-skeleton"
        aria-hidden="true"
        className="border-border min-h-32"
      >
        <div className="bg-muted/40 h-4 w-3/4 rounded" />
        <div className="bg-muted/40 h-3 w-1/2 rounded" />
      </InsightSectionCard>
    </section>
  );
}

export function CoincidentDeviationCard({
  enabled = true,
  className,
}: CoincidentDeviationCardProps) {
  const { t } = useTranslations();
  const { data, isError, error, refetch } =
    useDerivedMetric<CoincidentDeviationValue>(COINCIDENT_METRIC, { enabled });

  // A failed read says so with a retry. Without this branch the card sat on
  // its skeleton forever, which read as "still loading" rather than failed.
  if (isError && !data) {
    return (
      <section
        data-slot="coincident-deviation-section"
        aria-label={t("insights.derived.coincident.cardTitle")}
        className={cn("space-y-3", className)}
      >
        <SectionHeading
          icon={Activity}
          title={t("insights.derived.coincident.cardTitle")}
        />
        <QueryErrorRow
          error={error}
          slot="coincident-deviation-error"
          onRetry={() => void refetch()}
        />
      </section>
    );
  }

  // CLS-safe placeholder while the single read is in flight.
  if (!data) {
    return <CardSkeleton className={className} />;
  }

  // Building the baselines — fewer than two banded vitals. There is no signal
  // to show, so the section stays absent rather than rendering an empty husk.
  if (data.status === "insufficient") {
    return null;
  }

  const v = data.value!;
  const contributing = v.contributing;
  const names = contributing
    .map((d) => {
      const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[d.type];
      return labelKey ? t(labelKey) : d.type;
    })
    .join(", ");

  // Thin history behind the deepest contributing vital → soften a fired flag
  // to the watch tone rather than presenting a confident multi-signal verdict
  // from too little data. Read straight off the existing payload.
  const band = data.confidence?.band;
  const thinHistory = band === "low" || band === "draft";

  // Map the single payload onto one of the four calm states.
  const state: SignalState =
    contributing.length === 0
      ? "all-clear"
      : v.fired && contributing.length >= 2 && !thinHistory
        ? "fired"
        : "watch";

  // All clear — every vital is inside its personal range, so there is no signal
  // worth a card. Hide the whole section rather than surface an empty header.
  if (state === "all-clear") {
    return null;
  }

  if (state === "watch") {
    return (
      <CardShell
        state="watch"
        provenance={data.provenance}
        className={className}
      >
        <div className="flex items-start gap-2">
          <Activity
            className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p
              className="text-foreground text-sm font-medium"
              data-slot="coincident-headline"
            >
              {t("insights.derived.coincident.watch")}
            </p>
            <p className="text-muted-foreground text-xs leading-snug">
              {t("insights.derived.coincident.watchVital", { vital: names })}
            </p>
          </div>
        </div>
        {thinHistory ? <CoverageMeter coverage={data.coverage} /> : null}
      </CardShell>
    );
  }

  // fired — amber awareness, named vitals, possible-factors line (mandatory).
  // `role="status"` (a polite live region, not the assertive `role="alert"`)
  // so a screen-reader user gets the day-to-day state change in the calm tone
  // the card keeps visually — the one state whose meaning shifts vs all-clear.
  return (
    <CardShell state="fired" provenance={data.provenance} className={className}>
      <div className="flex items-start gap-2" role="status">
        <AlertTriangle
          className="text-warning mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          <p
            className="text-foreground text-sm font-medium"
            data-slot="coincident-headline"
          >
            {t("insights.derived.coincident.firedHeadline", {
              count: contributing.length,
            })}
          </p>
          <p
            className="text-muted-foreground text-xs leading-snug"
            data-slot="coincident-vitals"
          >
            {t("insights.derived.coincident.vitals", { list: names })}
          </p>
        </div>
      </div>
      <p
        className="text-muted-foreground text-xs leading-snug"
        data-slot="coincident-factors"
      >
        {/* v1.18.1 — Rest Mode reframe. When an illness episode is active
            the deviations have a known explanation, so the card states it
            plainly instead of leaving "possible factors" open. Neutral copy,
            no extra colour. */}
        {v.illnessExplained
          ? t("insights.derived.coincident.illnessExplained")
          : t("insights.derived.coincident.factors")}
      </p>
    </CardShell>
  );
}
