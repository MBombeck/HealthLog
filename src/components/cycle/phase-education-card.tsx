"use client";

import { useMemo } from "react";
import { BookOpen } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  PHASE_WHATS_HAPPENING_KEY,
  PHASE_CONTEXT_KEY,
} from "@/lib/cycle/phase-copy";
import { PHASE_HUE } from "./phase-tokens";
import { CYCLE_SYMPTOM_CATALOG } from "./symptom-catalog";
import type { CyclePhase } from "./types";
import type { SymptomPhaseRow } from "./use-cycle";

/**
 * v1.15.1 — the per-phase "what's happening now" education card.
 *
 * Anchored to the wheel: a hue-tinted `wellness-tile` surface keyed to the
 * ACTIVE phase (`--tile-hue`), so it reads as part of the ring, not a generic
 * tip card. Three zones:
 *   1. phase name + hue dot,
 *   2. a short, factual, descriptive-only "what's happening" line (curated i18n,
 *      never clinical advice / a medical claim),
 *   3. a "you often notice this here" chip row sourced from the user's OWN
 *      symptom-by-phase history (`symptomPatterns`), filtered to symptoms that
 *      cluster in THIS phase — never a generic population claim. Logging lives
 *      on the top-level log entry, so the card carries no own log button.
 *
 * Honesty gate (Clue precedent): when prediction is disabled / raw-chart mode
 * or fewer than three observed cycles, the predictive framing is suppressed and
 * the card shows a calm "still learning" line instead of phase copy + chips.
 *
 * Motion: NO competing animation. The card rides the wheel's once-per-session
 * reveal — `animate` drives the shared `wellness-tile-rise` keyframe (a single
 * calm entrance), which the global `prefers-reduced-motion` block already
 * zeroes. No bespoke transitions.
 */

const MIN_CYCLES_FOR_PREDICTION = 3;

export interface PhaseEducationCardProps {
  /** The active phase from the calendar read, or null when none is resolved. */
  phase: CyclePhase | null;
  /** The user's own symptom-by-phase rows (from `useCycleInsights`). */
  symptomPatterns: SymptomPhaseRow[];
  /** Honesty-gate inputs from the calendar profile. */
  predictionEnabled: boolean;
  rawChartMode: boolean;
  cyclesObserved: number;
  /** Ride the wheel's once-per-session reveal — no independent animation. */
  animate?: boolean;
  className?: string;
}

export function PhaseEducationCard({
  phase,
  symptomPatterns,
  predictionEnabled,
  rawChartMode,
  cyclesObserved,
  animate = false,
  className,
}: PhaseEducationCardProps) {
  const { t } = useTranslations();

  // Honesty gate: with prediction off / raw-chart mode / too few cycles, the
  // phase label is not trustworthy — suppress the framing and stay calm.
  const stillLearning =
    !phase ||
    !predictionEnabled ||
    rawChartMode ||
    cyclesObserved < MIN_CYCLES_FOR_PREDICTION;

  // Flatten the catalog once: symptom key → { labelKey, icon }. Reuses the same
  // catalog the symptom-patterns card draws from so the chip labels + icons
  // match exactly.
  const byKey = useMemo(() => {
    const map = new Map<
      string,
      {
        labelKey: string;
        icon: (typeof CYCLE_SYMPTOM_CATALOG)[number]["symptoms"][number]["icon"];
      }
    >();
    for (const cat of CYCLE_SYMPTOM_CATALOG) {
      for (const s of cat.symptoms) {
        map.set(s.key, { labelKey: s.labelKey, icon: s.icon });
      }
    }
    return map;
  }, []);

  // The "common here" chips are the user's OWN symptoms that cluster in the
  // ACTIVE phase (topPhase === phase). Most-concentrated first; capped so the
  // row stays scannable. Empty when no pattern points at this phase yet.
  const chips = useMemo(() => {
    if (stillLearning || !phase) return [];
    return symptomPatterns
      .filter((row) => row.topPhase === phase)
      .sort((a, b) => b.topShare - a.topShare || b.total - a.total)
      .slice(0, 5);
  }, [symptomPatterns, phase, stillLearning]);

  const hue = phase ? PHASE_HUE[phase] : PHASE_HUE.LUTEAL;
  const phaseName = phase ? t(`cycle.phase.${phase}`) : null;

  return (
    // `data-revealed` must sit on an ANCESTOR of `.wellness-tile-rise` — the
    // keyframe selector is `[data-revealed="true"] .wellness-tile-rise`
    // (descendant combinator). Both on the same node never matched, leaving the
    // tile stuck at the rise rule's `opacity: 0`. The `contents` wrapper carries
    // the flag without adding a layout box.
    <div data-revealed={animate ? "true" : undefined} className="contents">
      <section
        data-slot="cycle-phase-education"
        data-phase={phase ?? "none"}
        aria-label={t("cycle.phaseEducation.title")}
        style={{ "--tile-hue": hue } as React.CSSProperties}
        className={cn(
          "wellness-tile rounded-xl p-4 md:p-6",
          animate && "wellness-tile-rise",
          className,
        )}
      >
        {/* Zone 1 — eyebrow + phase name with a hue dot (never colour-only). */}
        <div className="flex items-center gap-2">
          <BookOpen
            className="text-foreground h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <span className="text-muted-foreground text-xs font-medium">
            {t("cycle.phaseEducation.title")}
          </span>
        </div>

        {stillLearning ? (
          <p
            data-slot="cycle-phase-education-learning"
            className="text-muted-foreground mt-2 text-sm"
          >
            {t("cycle.phaseEducation.stillLearning")}
          </p>
        ) : (
          <>
            <h3 className="text-foreground mt-2 flex items-center gap-2 text-base font-semibold">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: hue }}
              />
              {phaseName}
            </h3>

            {/* Zone 2 — the curated, descriptive-only "what's happening" line,
              followed by a deeper "context" line (what someone might notice +
              gentle framing of normal variation). Both stay descriptive, never
              clinical advice / a medical claim. */}
            <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
              {t(PHASE_WHATS_HAPPENING_KEY[phase as CyclePhase])}
            </p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              {t(PHASE_CONTEXT_KEY[phase as CyclePhase])}
            </p>

            {/* Zone 3 — the user's OWN clustered symptoms for this phase
              ("you often notice this here"). */}
            {chips.length > 0 ? (
              <div className="mt-4">
                <p className="text-muted-foreground text-xs font-medium">
                  {t("cycle.phaseEducation.commonHere")}
                </p>
                <ul
                  data-slot="cycle-phase-education-chips"
                  className="mt-2 flex flex-wrap gap-1.5"
                >
                  {chips.map((row) => {
                    const meta = byKey.get(row.symptomKey);
                    const Icon = meta?.icon;
                    const name = meta ? t(meta.labelKey) : row.symptomKey;
                    return (
                      <li
                        key={row.symptomKey}
                        className="border-foreground/15 bg-background/55 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
                      >
                        {Icon ? (
                          <Icon
                            className="h-3 w-3 shrink-0"
                            style={{ color: hue }}
                            aria-hidden="true"
                          />
                        ) : null}
                        {name}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
