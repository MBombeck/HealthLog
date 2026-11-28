"use client";

import { useMemo } from "react";
import { Activity } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";
import { CYCLE_SYMPTOM_CATALOG } from "./symptom-catalog";
import { PHASE_HUE } from "./phase-tokens";
import type { CyclePhase } from "./types";
import type { SymptomPhaseRow } from "./use-cycle";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * v1.15.0 — symptom patterns by phase (the cycle-NATIVE insight).
 *
 * The phase×vitals crosstab correlates the cycle against your measurements;
 * this card answers the complementary, cycle-own question: which of your logged
 * symptoms cluster in which phase. Each row shows the symptom's per-phase
 * distribution as a proportional 4-segment bar (phase-hued, never colour-only —
 * the dominant phase is named in words) plus "mostly in your luteal phase
 * (7 of 9 days)". Observational, never causal; only symptoms logged on ≥3
 * phase-labelled days surface (the server floor).
 */

const PHASE_ORDER: CyclePhase[] = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
];

export interface CycleSymptomPatternsProps {
  rows: SymptomPhaseRow[];
}

export function CycleSymptomPatterns({ rows }: CycleSymptomPatternsProps) {
  const { t } = useTranslations();

  // Flatten the catalog once: symptom key → { labelKey, icon }.
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

  return (
    <Card data-slot="cycle-symptom-patterns">
      <CardHeader>
        <TileHeader
          icon={Activity}
          title={t("cycle.insights.symptomPatternsTitle")}
        />
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            title={t("cycle.insights.symptomPatternsEmpty")}
          />
        ) : (
          <ul className="space-y-3" data-slot="cycle-symptom-pattern-list">
            {rows.map((row) => {
              const meta = byKey.get(row.symptomKey);
              const Icon = meta?.icon;
              const name = meta ? t(meta.labelKey) : row.symptomKey;
              const phaseName = t(`cycle.phase.${row.topPhase}`);
              return (
                <li key={row.symptomKey} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                      {Icon ? (
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : null}
                      {name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t("cycle.insights.symptomMostlyIn", {
                        phase: phaseName,
                        count: row.counts[row.topPhase],
                        total: row.total,
                      })}
                    </span>
                  </div>
                  {/* Proportional phase-distribution bar — phase-hued, with the
                      dominant phase named above so it is never colour-only. */}
                  <div
                    className="bg-muted flex h-2 overflow-hidden rounded-full"
                    role="img"
                    aria-label={t("cycle.insights.symptomMostlyIn", {
                      phase: phaseName,
                      count: row.counts[row.topPhase],
                      total: row.total,
                    })}
                  >
                    {PHASE_ORDER.map((phase) => {
                      const share =
                        row.total > 0 ? row.counts[phase] / row.total : 0;
                      if (share <= 0) return null;
                      return (
                        <span
                          key={phase}
                          style={{
                            width: `${share * 100}%`,
                            backgroundColor: PHASE_HUE[phase],
                            opacity: phase === row.topPhase ? 1 : 0.45,
                          }}
                        />
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
