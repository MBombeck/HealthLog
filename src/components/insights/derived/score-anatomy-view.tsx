"use client";

import type { ReactNode } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { LearningGate } from "@/components/ui/learning-gate";
import type {
  DerivedConfidence,
  DerivedCoverage,
  DerivedProvenance,
} from "@/lib/insights/derived/types";
import { TileHeader } from "@/components/insights/tile-header";
import { TagChip } from "@/components/ui/tag-chip";
import { ScoreRing } from "./score-ring";
import { CoverageMeter } from "./coverage-meter";
import {
  ProvenanceExplainer,
  type ProvenanceStandard,
} from "./provenance-explainer";
import { TILE_HUE, type RingHue } from "./ring-hues";
import { clampScore, type ScoreBand } from "./band-tokens";

/**
 * v1.10.0 — the Oura-style score-anatomy detail view (the Hybrid
 * direction's "reinhauen" surface).
 *
 * A full-bleed `ScoreRing` + ranked contributor rows + a cited-standard
 * `ProvenanceExplainer`. Each contributor row is one input's push/pull on
 * the score: a label, an impact bar (neutral, width = the contributor's
 * 0..100 value), and the contributor's own mini coverage (its effective
 * weight share). The bar carries no band colour: a contributor is not a
 * score, and a traffic light on it would call a 45 "out of range" when it
 * only means the input sat a little off its usual (1.50, one band rule). Reused by every composite (sleep score,
 * readiness, …) — the caller normalises its `value` into the
 * `contributors` list, so this component stays metric-agnostic.
 *
 * Renders the same three states the rest of the design system speaks:
 *   - ok          → ring + contributors + coverage + provenance
 *   - insufficient → the ring's provisional state + the coverage "track N"
 *                    nudge (never a blank, never a fabricated number)
 *
 * Mobile-first (the ring is large where there is room), dark-first, a11y:
 * the ring restates the number in its aria-label; contributor bars carry a
 * text value (never colour-only); the provenance explainer threads
 * aria-describedby. Plain React text children only — no markdown library.
 */

/** One normalised contributor the view ranks by impact. */
export interface AnatomyContributor {
  /** Stable key (drives the data-attr + the localised label lookup by caller). */
  key: string;
  /** Localised display label. */
  label: ReactNode;
  /** 0..100 contribution score, or null when the input was missing (dropped). */
  value: number | null;
  /** Effective weight share after null-redistribution, 0..1. */
  weight: number;
  /**
   * What a missing contributor still needs, when the server says why it is
   * missing (the sleep score's rhythm sub-scores). Shown in place of the
   * generic "no data".
   */
  missingLabel?: string;
}

export interface ScoreAnatomyViewProps {
  /** Localised metric title (e.g. "Readiness", "Sleep score"). */
  title: ReactNode;
  /** The composite 0..100 score, or null for the insufficient/empty state. */
  score: number | null;
  /** Band override; derived from the score when omitted. */
  band?: ScoreBand;
  /** Stress / strain: the ring bands and words the score as a load. */
  load?: boolean;
  /**
   * The metric's hue. When set, the detail card carries the gentle
   * per-metric tint its Insights tile wears (continuity from tap to detail).
   * The ring itself is always coloured by its band (`ring-color.ts`).
   */
  hue?: RingHue;
  /** Short caption under the ring (a one-line summary, never a band word). */
  caption?: ReactNode;
  /** Ranked contributors (the caller pre-ranks; the view renders in order). */
  contributors: AnatomyContributor[];
  coverage: DerivedCoverage;
  confidence?: DerivedConfidence | null;
  provenance: DerivedProvenance;
  /** Plain-language method shown in the provenance explainer. */
  method: ReactNode;
  /** Cited standard rendered as an external link in the explainer footer. */
  standard?: ProvenanceStandard;
  /** When true the score is unavailable — render the provisional state. */
  insufficient?: boolean;
  /** Localised "not enough data" nudge for the insufficient state. */
  insufficientNote?: ReactNode;
  /** Keep the shared provisional ring unless the caller requires rows only. */
  showProvisionalRing?: boolean;
  /**
   * A score that exists but is not about today (a readiness resting on
   * yesterday's values): the ring shows its bare track with this as its
   * accessible name, and `caption` says when the values are from.
   */
  staleLabel?: string;
  /** Heading over the contributor rows; "Contributors" when omitted. */
  contributorsHeading?: ReactNode;
  /**
   * The one sentence a score without parts shows under the same heading,
   * in the place of the rows (an estimate, a device's number).
   */
  noFactorsNote?: ReactNode;
  /** Whose number it is ("Estimate", "Device value"), beside the title. */
  originLabel?: ReactNode;
  className?: string;
}

export function ScoreAnatomyView({
  title,
  score,
  band,
  load = false,
  hue,
  caption,
  contributors,
  coverage,
  confidence,
  provenance,
  method,
  standard,
  insufficient = false,
  insufficientNote,
  showProvisionalRing = true,
  staleLabel,
  contributorsHeading,
  noFactorsNote,
  originLabel,
  className,
}: ScoreAnatomyViewProps) {
  const { t } = useTranslations();
  const effectiveScore = insufficient ? null : score;

  return (
    <section
      data-slot="score-anatomy-view"
      data-status={insufficient ? "insufficient" : "ok"}
      // v1.15.12 — when a `hue` is set, the detail card carries the same
      // gentle `--tile-hue` mix + bottom-leaning gradient the dashboard ring
      // tile wears (`.wellness-tile` family), so the tap-through reads as the
      // same surface deepened. No hue → the plain bordered `--card` look.
      data-tinted={hue ? "true" : undefined}
      style={
        hue
          ? ({ "--tile-hue": TILE_HUE[hue] } as React.CSSProperties)
          : undefined
      }
      className={cn(
        "flex flex-col gap-4 rounded-xl border p-4 md:p-6",
        hue ? "wellness-detail-card" : "border-border bg-card",
        className,
      )}
      aria-label={typeof title === "string" ? title : undefined}
    >
      {/* Left-aligned canonical tile header — sits on the same reading edge as
          the sibling assessment card that stacks beneath it on a score
          sub-page, instead of the old centred uppercase title that floated
          toward the middle and shared no left line with any card. */}
      <TileHeader
        title={title}
        right={
          originLabel ? (
            <TagChip data-slot="score-anatomy-origin">{originLabel}</TagChip>
          ) : undefined
        }
      />
      {/* Hero: ring + caption — a centred identity block below the header. */}
      <div className="flex flex-col items-center gap-3 text-center">
        {/* v1.15.12 — vertical breathing room so the ring's bloom/glow is
            never clipped top/bottom by the hero container. */}
        {!insufficient || showProvisionalRing ? (
          <div className="py-2">
            <ScoreRing
              score={effectiveScore}
              band={band}
              load={load}
              label={t("insights.derived.anatomy.outOf")}
              size="lg"
              emptyFace={staleLabel !== undefined}
              ariaLabel={staleLabel}
            />
          </div>
        ) : null}
        {caption && !insufficient ? (
          <p
            data-slot="score-anatomy-caption"
            className="text-muted-foreground text-xs"
          >
            {caption}
          </p>
        ) : null}
        <CoverageMeter
          coverage={coverage}
          confidence={confidence ?? undefined}
          size="md"
        />
      </div>

      {insufficient ? (
        <LearningGate
          variant="bordered"
          bodySlot="score-anatomy-insufficient"
          message={
            insufficientNote ?? t("insights.derived.anatomy.insufficient")
          }
        />
      ) : null}
      {contributors.length > 0 || (noFactorsNote && !insufficient) ? (
        <div data-slot="score-anatomy-contributors" className="space-y-3">
          <p className="text-muted-foreground text-xs font-semibold">
            {contributorsHeading ??
              t("insights.derived.anatomy.contributorsLabel")}
          </p>
          {contributors.length > 0 ? (
            <ul className="space-y-2.5">
              {contributors.map((c) => (
                <ContributorRow key={c.key} contributor={c} />
              ))}
            </ul>
          ) : (
            <p
              data-slot="score-anatomy-no-factors"
              className="text-foreground text-sm"
            >
              {noFactorsNote}
            </p>
          )}
        </div>
      ) : null}

      {/* The plain-language method caption closes the card, in normal flow.
          `ProvenanceExplainer` (v1.22) is no longer a top-right ⓘ glyph — it
          renders its full method body inline as a muted caption, so it must
          sit in the document flow at the foot of the surface. The earlier
          `absolute top-right` wrapper yanked the whole paragraph out of flow
          and painted it over the centred title, ring and contributor rows on
          every breakpoint; rendering it here keeps the spine readable. */}
      <ProvenanceExplainer
        provenance={provenance}
        method={method}
        standard={standard}
      />
    </section>
  );
}

/** One ranked contributor row — label + impact bar + value + weight share. */
function ContributorRow({ contributor }: { contributor: AnatomyContributor }) {
  const { t } = useTranslations();
  const present =
    contributor.value != null && Number.isFinite(contributor.value);
  const clamped = present ? clampScore(contributor.value as number) : 0;
  const weightPct = Math.round(contributor.weight * 100);

  return (
    <li
      data-slot="anatomy-contributor-row"
      data-contributor={contributor.key}
      data-present={present ? "true" : "false"}
      className="space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground text-xs font-medium">
          {contributor.label}
        </span>
        <span
          data-slot="anatomy-contributor-value"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {present
            ? t("insights.derived.anatomy.contributorValue", {
                value: Math.round(clamped),
                weight: weightPct,
              })
            : (contributor.missingLabel ??
              t("insights.derived.anatomy.contributorMissing"))}
        </span>
      </div>
      <div
        className="bg-muted/40 h-1.5 w-full overflow-hidden rounded-full"
        role="presentation"
      >
        <div
          data-slot="anatomy-contributor-bar"
          className={cn(
            "h-full rounded-full transition-all",
            present ? "bg-muted-foreground/60" : "bg-muted",
          )}
          style={{ width: present ? `${clamped}%` : "0%" }}
        />
      </div>
    </li>
  );
}
