"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { InfoPopover } from "@/components/ui/info-popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { GlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.17.0 — "advanced" progressive disclosure for the glucose panel.
 *
 * The default panel view leads with TIR / GMI / eA1C / CV%. The research-grade
 * composites the maintainer chose for v1.17.0 — J-index (Wojcicki) and the
 * Kovatchev low/high blood-glucose risk indices — live behind this disclosure
 * so a casual user is not confronted with them, while a clinician or an engaged
 * user can open them. Per-context reading counts ride along so the advanced
 * view also answers "where do these readings come from". Values are computed
 * server-side; this only renders them.
 *
 * No Collapsible primitive exists in the UI kit, so this is a minimal,
 * accessible button + region disclosure (the same pattern other insights cards
 * use): `aria-expanded` on the trigger, `aria-controls`/`hidden` on the region.
 */

const CONTEXT_LABEL_KEYS: Record<string, string> = {
  FASTING: "insights.bloodGlucose.clinical.advanced.byContext.fasting",
  POSTPRANDIAL:
    "insights.bloodGlucose.clinical.advanced.byContext.postprandial",
  RANDOM: "insights.bloodGlucose.clinical.advanced.byContext.random",
  BEDTIME: "insights.bloodGlucose.clinical.advanced.byContext.bedtime",
  // #943 — readings whose source recorded no meal-time context.
  UNSPECIFIED: "insights.bloodGlucose.clinical.advanced.byContext.unspecified",
};

export interface GlucoseAdvancedDisclosureProps {
  advanced: NonNullable<GlucoseClinicalMetrics["advanced"]>;
  /** Per-context summaries keyed by `GlucoseContext`; optional. */
  byContext?: Record<string, DataSummary> | undefined;
  /** Decimals for the index values. Defaults to 1. */
  fractionDigits?: number;
}

export function GlucoseAdvancedDisclosure({
  advanced,
  byContext,
  fractionDigits = 1,
}: GlucoseAdvancedDisclosureProps) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const regionId = useId();

  const fmt = (v: number | null) =>
    v === null ? "—" : v.toFixed(fractionDigits);

  const contexts = Object.entries(byContext ?? {}).filter(
    ([, s]) => s && s.count > 0,
  );

  return (
    <div data-slot="glucose-advanced" className="border-border border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        data-slot="glucose-advanced-toggle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-2 rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span>{t("insights.bloodGlucose.clinical.advanced.toggle")}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
        />
      </button>

      <div
        id={regionId}
        hidden={!open}
        data-slot="glucose-advanced-region"
        className="space-y-4 pt-3"
      >
        <p className="text-muted-foreground text-xs">
          {t("insights.bloodGlucose.clinical.advanced.intro")}
        </p>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <AdvancedStat
            label={t("insights.bloodGlucose.clinical.advanced.jIndex.label")}
            help={t("insights.bloodGlucose.clinical.advanced.jIndex.help")}
            value={fmt(advanced.jIndex)}
          />
          <AdvancedStat
            label={t("insights.bloodGlucose.clinical.advanced.lbgi.label")}
            help={t("insights.bloodGlucose.clinical.advanced.lbgi.help")}
            value={fmt(advanced.lbgi)}
          />
          <AdvancedStat
            label={t("insights.bloodGlucose.clinical.advanced.hbgi.label")}
            help={t("insights.bloodGlucose.clinical.advanced.hbgi.help")}
            value={fmt(advanced.hbgi)}
          />
        </dl>

        {contexts.length > 0 ? (
          <div className="space-y-2" data-slot="glucose-advanced-context">
            <p className="text-foreground text-xs font-medium">
              {t("insights.bloodGlucose.clinical.advanced.byContext.title")}
            </p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {contexts.map(([ctx, summary]) => (
                <li
                  key={ctx}
                  className="flex items-center justify-between gap-2"
                >
                  <span>
                    {CONTEXT_LABEL_KEYS[ctx] ? t(CONTEXT_LABEL_KEYS[ctx]) : ctx}
                  </span>
                  <span className="tabular-nums">
                    {summary.count === 1
                      ? t(
                          "insights.bloodGlucose.clinical.advanced.byContext.readingsShortOne",
                        )
                      : t(
                          "insights.bloodGlucose.clinical.advanced.byContext.readingsShort",
                          { count: summary.count },
                        )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AdvancedStat({
  label,
  help,
  value,
}: {
  label: string;
  help: string;
  value: string;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground flex items-center gap-1 text-xs">
        {label}
        <InfoPopover content={help} />
      </dt>
      <dd className="text-foreground text-base font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}
