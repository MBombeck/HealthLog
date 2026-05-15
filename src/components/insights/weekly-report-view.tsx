"use client";

import { useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  Lightbulb,
  Loader2,
  Printer,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { weekISOToRange } from "@/lib/insights/week-iso";
import type { WeeklyReport } from "@/lib/ai/schema";
import { useAuth } from "@/hooks/use-auth";

/**
 * v1.4.20 phase B4 — Newsletter-style printable weekly report.
 *
 * The page is intentionally client-side so it can read the cached AI
 * advisor payload via `useInsightsAdvisorQuery`. Each section (Summary,
 * What's going well, What's worth watching, Tips, Data-quality notes)
 * mirrors the `weeklyReportSchema` shape one-to-one so the layout is
 * deterministic — no surprise sections, no missing sections.
 *
 * Print export is `window.print()` for v1.4.20 (the artboard's "PDF"
 * button maps to the same call). The page carries a `print:` Tailwind
 * stylesheet that hides the app shell + tightens margins so an A4 /
 * Letter print lands cleanly without margin clipping.
 *
 * The `?print=1` query forces an automatic `window.print()` call once
 * the report has hydrated — used by the hero strip's banner-card
 * "Export PDF" button so the user lands on a print-ready surface
 * without a second click.
 */

export interface WeeklyReportViewProps {
  /** ISO-week identifier the route parsed (`YYYY-Www`). */
  weekISO: string;
  /** Honour `?print=1` and call `window.print()` after first paint. */
  autoPrint?: boolean;
}

export function WeeklyReportView({
  weekISO,
  autoPrint = false,
}: WeeklyReportViewProps) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  const cachedReport: WeeklyReport | null =
    (advisor.payload?.insights as { weeklyReport?: WeeklyReport | null })
      ?.weeklyReport ?? null;
  // The advisor query keys the cached payload to the freshest insight,
  // not a specific week — we only show the cached report when its
  // weekISO matches the route param. Cross-week mismatches resolve to
  // the empty state with a Generate CTA so the user understands what's
  // happening.
  const matchedReport =
    cachedReport && cachedReport.weekISO === weekISO ? cachedReport : null;

  // Auto-print when the banner card's "Export PDF" deep-link landed
  // here with `?print=1`. We fire after a short paint delay so the
  // print preview surfaces the report content, not the loading state.
  useEffect(() => {
    if (!autoPrint) return;
    if (advisor.isLoading) return;
    if (!matchedReport) return;
    const timer = window.setTimeout(() => {
      try {
        window.print();
      } catch {
        // Some embedded webviews disallow print(); fall through silently.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [autoPrint, advisor.isLoading, matchedReport]);

  if (authLoading || advisor.isLoading) {
    return (
      <div
        data-slot="weekly-report-loading"
        className="flex h-64 items-center justify-center"
      >
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return <WeeklyReportPresentation weekISO={weekISO} report={matchedReport} />;
}

/**
 * Pure presentational layer used by both the live route and the
 * vitest renderer. Decoupling it from `useInsightsAdvisorQuery` /
 * `useAuth` keeps the unit tests free of TanStack-Query setup.
 */
export interface WeeklyReportPresentationProps {
  weekISO: string;
  report: WeeklyReport | null;
}

export function WeeklyReportPresentation({
  weekISO,
  report,
}: WeeklyReportPresentationProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const range = weekISOToRange(weekISO);
  const dateRangeLabel = range
    ? `${fmt.date(range.start)} — ${fmt.date(range.end)}`
    : weekISO;

  return (
    <article
      data-slot="weekly-report"
      lang={locale}
      className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 print:max-w-none print:px-0 print:py-0"
    >
      {/* Top bar — back link + print button. Hidden in print output. */}
      <header
        data-slot="weekly-report-toolbar"
        className="flex flex-wrap items-center justify-between gap-2 print:hidden"
      >
        <Button variant="ghost" size="sm" asChild className="gap-1.5">
          <Link href="/insights">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t("insights.report.backToInsights")}
          </Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            try {
              window.print();
            } catch {
              // No-op — older webviews disallow programmatic print().
            }
          }}
          data-slot="weekly-report-print"
          className="gap-1.5"
        >
          <Printer className="h-3.5 w-3.5" aria-hidden="true" />
          {t("insights.report.printAction")}
        </Button>
      </header>

      {/* Hero — title + date range + meta. Always visible (incl. print). */}
      <section
        data-slot="weekly-report-hero"
        className="border-border/60 from-dracula-purple/10 space-y-2 rounded-xl border bg-gradient-to-b to-transparent p-5 sm:p-6 print:rounded-none print:border-0 print:bg-none print:p-0"
      >
        <span
          data-slot="weekly-report-eyebrow"
          className="bg-dracula-purple/15 text-dracula-purple print:text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium print:bg-transparent print:px-0"
        >
          <FileText className="h-3 w-3" aria-hidden="true" />
          {t("insights.report.eyebrow")}
        </span>
        <h1
          data-slot="weekly-report-title"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {t("insights.report.title", { week: weekISO })}
        </h1>
        <p
          data-slot="weekly-report-daterange"
          className="text-muted-foreground text-sm"
        >
          {dateRangeLabel}
        </p>
      </section>

      {!report ? (
        <EmptyReportState weekISO={weekISO} />
      ) : (
        <>
          {/* TL;DR — Summary */}
          <Section
            slot="weekly-report-summary"
            title={t("insights.report.sectionSummary")}
            accent="text-dracula-purple"
          >
            <p className="text-sm leading-relaxed">
              {stripChartTokens(report.summary)}
            </p>
          </Section>

          {/* Going well */}
          {report.goingWell.length > 0 && (
            <Section
              slot="weekly-report-going-well"
              title={t("insights.report.sectionGoingWell")}
              accent="text-dracula-green"
              icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              <BulletList items={report.goingWell.map(stripChartTokens)} />
            </Section>
          )}

          {/* Worth watching */}
          {report.worthWatching.length > 0 && (
            <Section
              slot="weekly-report-worth-watching"
              title={t("insights.report.sectionWorthWatching")}
              accent="text-dracula-orange"
              icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              <BulletList items={report.worthWatching.map(stripChartTokens)} />
            </Section>
          )}

          {/* Tips */}
          {report.tips.length > 0 && (
            <Section
              slot="weekly-report-tips"
              title={t("insights.report.sectionTips")}
              accent="text-dracula-cyan"
              icon={<Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              <BulletList items={report.tips.map(stripChartTokens)} />
            </Section>
          )}

          {/* Data-quality notes — surfaced ONLY when the model emitted one. */}
          {report.dataQualityNotes && (
            <Section
              slot="weekly-report-data-quality"
              title={t("insights.report.sectionDataQuality")}
              accent="text-muted-foreground"
            >
              <p className="text-muted-foreground text-sm leading-relaxed">
                {stripChartTokens(report.dataQualityNotes)}
              </p>
            </Section>
          )}

          <footer
            data-slot="weekly-report-footer"
            className="text-muted-foreground border-border/60 border-t pt-4 text-[11px] leading-relaxed"
          >
            <p>
              <Sparkles
                className="mr-1.5 inline-block h-3 w-3 align-text-bottom"
                aria-hidden="true"
              />
              {t("insights.report.footerNotMedicalAdvice")}
            </p>
          </footer>
        </>
      )}
    </article>
  );
}

interface SectionProps {
  slot: string;
  title: string;
  accent: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ slot, title, accent, icon, children }: SectionProps) {
  return (
    <section
      data-slot={slot}
      className="border-border/60 space-y-2 rounded-xl border p-4 sm:p-5 print:rounded-none print:border-0 print:p-0"
    >
      <h2
        className={`flex items-center gap-1.5 text-[11px] font-semibold tracking-wider uppercase ${accent}`}
      >
        {icon}
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
      {items.map((item, index) => (
        <li key={`${index}-${item.slice(0, 16)}`}>{item}</li>
      ))}
    </ul>
  );
}

function EmptyReportState({ weekISO }: { weekISO: string }) {
  const { t } = useTranslations();
  return (
    <section
      data-slot="weekly-report-empty"
      className="border-border/60 space-y-3 rounded-xl border border-dashed p-6 text-center"
    >
      <Sparkles
        className="text-muted-foreground mx-auto h-6 w-6"
        aria-hidden="true"
      />
      <h2 className="text-base font-medium">
        {t("insights.report.emptyTitle")}
      </h2>
      <p className="text-muted-foreground text-sm">
        {t("insights.report.emptyDescription", { week: weekISO })}
      </p>
      <div className="flex justify-center">
        <Button asChild size="sm" variant="outline">
          <Link href="/insights">{t("insights.report.emptyAction")}</Link>
        </Button>
      </div>
    </section>
  );
}
