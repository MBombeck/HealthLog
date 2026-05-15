"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Flame,
  History,
  Loader2,
  Pencil,
  SkipForward,
  Stethoscope,
  Syringe,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { formatDateTime, formatTime } from "@/lib/format";
import {
  describeInjectionSite,
  nextInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { InventorySection } from "@/components/medications/inventory-section";

/**
 * v1.4.25 W4d — GLP-1 medication card variant.
 *
 * Marc directive 2026-05-14: NO chart on the medication card. The card
 * stays text-rich (drug name + current dose, last/next injection,
 * inline dose-history disclosure, injection-site rotation hint, pen
 * inventory, side-effect quick-log). Chart-only surfaces are the
 * Dashboard tile + Insights /medikamente sub-page.
 *
 * Renders inside the standard medications grid alongside generic
 * medication cards; visually mirrors `medication-card.tsx` so the page
 * stays harmonious — same Card shell, same header layout, same
 * compliance bars, same primary "Taken / Skipped" actions. The
 * GLP-1-specific rows sit between the dose line and the compliance
 * bars so the user reads top-down: drug → injection state → adherence.
 */

interface ScheduleLite {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
}

interface DoseChangeLite {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note: string | null;
}

interface IntakeLite {
  takenAt: string | null;
  injectionSite: InjectionSiteKey | null;
}

export interface Glp1Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  dosesPerUnit?: number | null;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  schedules: ScheduleLite[];
}

interface ComplianceData {
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
}

interface DetailsResponse {
  doseChanges: DoseChangeLite[];
  recentIntakes: IntakeLite[];
  inventory: {
    pensRemaining: number | null;
    dosesRemaining: number | null;
    weeksOfSupply: number | null;
    lowStock: boolean;
  } | null;
}

interface Glp1MedicationCardProps {
  medication: Glp1Medication;
  onEdit: (med: Glp1Medication) => void;
  onLogSideEffect?: (med: Glp1Medication) => void;
}

const DAY_KEYS = [
  "medications.daysSun",
  "medications.daysMon",
  "medications.daysTue",
  "medications.daysWed",
  "medications.daysThu",
  "medications.daysFri",
  "medications.daysSat",
] as const;

function parseDayList(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

function diffDays(target: Date, from: Date): number {
  const ms =
    Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) -
    Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function predictNextWeeklyDate(
  schedule: ScheduleLite | null,
  lastTakenAt: string | null,
  now: Date,
): { date: Date; daysAway: number } | null {
  if (!schedule) return null;
  const dow = parseDayList(schedule.daysOfWeek);
  if (dow.length !== 1) return null;
  const target = dow[0];
  const anchor = lastTakenAt ? new Date(lastTakenAt) : now;
  const cursor = new Date(anchor);
  cursor.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 14; i += 1) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() === target) {
      const days = diffDays(cursor, now);
      return { date: cursor, daysAway: Math.max(0, days) };
    }
  }
  return null;
}

export function Glp1MedicationCard({
  medication,
  onEdit,
  onLogSideEffect,
}: Glp1MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const doseHistoryId = useId();

  const { data: compliance } = useQuery({
    queryKey: ["medications", medication.id, "compliance"],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    staleTime: 30 * 1000,
    enabled: medication.active,
  });

  // Pull GLP-1-specific extras (dose history + recent injection sites +
  // pen inventory). Lives behind a dedicated endpoint so the standard
  // medications grid loads in parallel without paying for it.
  const { data: details } = useQuery({
    queryKey: ["medications", medication.id, "glp1-details"],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/glp1`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as DetailsResponse;
    },
    staleTime: 60 * 1000,
  });

  async function recordIntake(skipped: boolean) {
    const key = skipped ? "skip" : "take";
    setIntakeLoading(key);
    try {
      const res = await fetch(`/api/medications/${medication.id}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped }),
      });
      if (res.ok) {
        await invalidateKeys(queryClient, medicationDependentKeys);
      }
    } finally {
      setIntakeLoading(null);
    }
  }

  const schedule = medication.schedules[0] ?? null;
  const now = new Date();
  const next = predictNextWeeklyDate(schedule, medication.lastTakenAt, now);
  const rate7 = compliance?.compliance7?.rate ?? 0;
  const rate30 = compliance?.compliance30?.rate ?? 0;
  const streak = compliance?.compliance7?.streak ?? 0;

  const doseChanges = details?.doseChanges ?? [];
  const recentInjections = details?.recentIntakes ?? [];
  const lastSite =
    recentInjections.find((i) => i.injectionSite)?.injectionSite ?? null;
  const recommendedNextSite = nextInjectionSite(
    recentInjections
      .map((r) => r.injectionSite)
      .filter(Boolean) as InjectionSiteKey[],
  );

  const inventory = details?.inventory ?? null;

  function lastInjectionLabel(): string | null {
    if (!medication.lastTakenAt) return null;
    const d = new Date(medication.lastTakenAt);
    const days = diffDays(d, now);
    if (days === 0)
      return `${t("medications.today")}, ${formatTime(medication.lastTakenAt)}`;
    if (days === -1)
      return `${t("medications.yesterday")}, ${formatTime(medication.lastTakenAt)}`;
    return formatDateTime(medication.lastTakenAt);
  }

  function nextInjectionLabel(): string {
    if (!next) return "—";
    if (next.daysAway === 0) return t("medications.glp1NextInjectionToday");
    if (next.daysAway === 1) return t("medications.glp1NextInjectionTomorrow");
    const dayName = t(DAY_KEYS[next.date.getDay()]);
    const dateShort = fmt.dateShort(next.date);
    return t("medications.glp1NextInjectionDays", {
      label: `${dayName}, ${dateShort}`,
      days: next.daysAway,
    });
  }

  return (
    <Card className={medication.active ? "" : "opacity-60"}>
      <CardHeader className="pb-2.5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Syringe className="text-dracula-purple h-4 w-4 shrink-0" />
              <span>{medication.name}</span>
              <span className="text-muted-foreground text-sm font-normal">
                · {medication.dose}
              </span>
            </CardTitle>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Badge variant="outline" className="text-xs">
                {t("medications.treatmentClassGlp1")}
              </Badge>
              {!medication.notificationsEnabled && (
                <Badge variant="secondary" className="text-xs">
                  {t("medications.withoutNotification")}
                </Badge>
              )}
              {!medication.active && (
                <Badge variant="secondary" className="text-xs">
                  {medication.pausedAt
                    ? `${t("medications.pausedSince")} ${formatDateTime(medication.pausedAt)}`
                    : t("medications.inactive")}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              asChild
              aria-label={t("medications.intakeHistory")}
            >
              <Link href={`/medications/${medication.id}/history`}>
                <History className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              onClick={() => onEdit(medication)}
              aria-label={t("common.edit")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3.5">
        {/* Injection state — last + next */}
        <div className="space-y-1 text-sm">
          {medication.lastTakenAt && (
            <p className="text-muted-foreground">
              {lastSite
                ? t("medications.glp1LastInjectionWithSite", {
                    label: lastInjectionLabel() ?? "—",
                    site: t(`medications.site${siteSuffix(lastSite)}`),
                  })
                : t("medications.glp1LastInjection", {
                    label: lastInjectionLabel() ?? "—",
                  })}
            </p>
          )}
          <p className="text-foreground/85">{nextInjectionLabel()}</p>
        </div>

        {/* Rotation hint — only when we have a last + recommended site
            different from it. The picker on the dashboard tile owns
            mode-switching; the card just nudges. */}
        {lastSite &&
          recommendedNextSite &&
          recommendedNextSite !== lastSite && (
            <div className="border-border/60 bg-muted/40 rounded-md border px-3 py-2 text-xs">
              <p className="text-muted-foreground">
                {t("medications.glp1RotationLast", {
                  site: t(`medications.site${siteSuffix(lastSite)}`),
                })}
              </p>
              <p className="text-foreground/90 font-medium">
                {t("medications.glp1RotationSuggested", {
                  site: t(`medications.site${siteSuffix(recommendedNextSite)}`),
                })}
              </p>
            </div>
          )}

        {/* Inventory line — only when dosesPerUnit + at least one
            inventory event recorded. Low-stock gets a warning badge. */}
        {inventory && inventory.pensRemaining !== null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t("medications.glp1Inventory", {
                pens: inventory.pensRemaining,
                weeks: inventory.weeksOfSupply ?? "—",
              })}
            </span>
            {inventory.lowStock && (
              <Badge variant="destructive" className="text-[10px]">
                {t("medications.glp1InventoryLow")}
              </Badge>
            )}
          </div>
        )}

        {/* Dose-history disclosure — collapsible row. Stays closed by
            default so the card height matches a generic card on first
            paint. */}
        <details
          className="border-border/60 rounded-md border text-xs"
          open={showHistory}
          onToggle={(e) =>
            setShowHistory((e.target as HTMLDetailsElement).open)
          }
        >
          <summary
            className="text-foreground/85 flex cursor-pointer list-none items-center justify-between px-3 py-2 font-medium"
            aria-controls={doseHistoryId}
            aria-expanded={showHistory}
          >
            <span>{t("medications.glp1DoseHistory")}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${
                showHistory ? "rotate-180" : ""
              }`}
            />
          </summary>
          <div
            id={doseHistoryId}
            className="border-border/60 space-y-1.5 border-t px-3 py-2"
          >
            {doseChanges.length === 0 && (
              <p className="text-muted-foreground">
                {t("medications.glp1DoseHistoryEmpty")}
              </p>
            )}
            {doseChanges
              .slice()
              .reverse()
              .map((change) => (
                <div
                  key={change.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="font-medium tabular-nums">
                    {change.doseValue} {change.doseUnit}
                  </span>
                  <span className="text-muted-foreground">
                    {t("medications.glp1DoseSince", {
                      date: fmt.dateShort(new Date(change.effectiveFrom)),
                    })}
                  </span>
                </div>
              ))}
          </div>
        </details>

        {/* v1.4.25 W19b — per-pen / per-vial inventory disclosure.
            Lazy-loads the inventory list on open; otherwise stays
            collapsed so the card height matches generic cards. */}
        <InventorySection
          medicationId={medication.id}
          defaultDosesPerUnit={medication.dosesPerUnit ?? null}
        />

        {/* Compliance bars — identical to the generic card so the page
            grid stays harmonious. */}
        {medication.active && compliance && (
          <div className="space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("medications.compliance7d")}
                </span>
                <span className="font-medium">{rate7}%</span>
              </div>
              <Progress value={rate7} className="h-2" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("medications.compliance30d")}
                </span>
                <span className="font-medium">{rate30}%</span>
              </div>
              <Progress value={rate30} className="h-2" />
            </div>
            {streak > 0 && (
              <div className="flex items-center gap-4 text-xs">
                <span className="text-dracula-orange flex items-center gap-1 font-medium">
                  <Flame className="h-3.5 w-3.5" />
                  {streak} {t("medications.dayStreak")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Primary actions row — matches the generic card's
            min-h-11 tap-target rule. The third button opens the
            side-effect log pre-tagged with the GLP-1 drug name. */}
        {medication.active && (
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 flex-1"
              onClick={() => recordIntake(false)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "take" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              {t("medications.taken")}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => recordIntake(true)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "skip" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <SkipForward className="mr-1 h-4 w-4" />
              )}
              {t("medications.skipped")}
            </Button>
            {onLogSideEffect && (
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={() => onLogSideEffect(medication)}
              >
                <Stethoscope className="mr-1 h-4 w-4" />
                {t("medications.glp1LogSideEffect")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Map enum value → i18n suffix.  ABDOMEN_LEFT → "AbdomenLeft" so we can
 * lookup `medications.siteAbdomenLeft` etc. without a switch table.
 */
function siteSuffix(site: InjectionSiteKey): string {
  return site
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Re-export so the parent doesn't need to import describeInjectionSite. */
export { describeInjectionSite };
