"use client";

/**
 * v1.39.4 — the tables under an assistant reply. A live turn hands its
 * tables in from the `result` frames; a persisted message lists only their
 * metadata, and the values are fetched when the message scrolls into view
 * (`useCoachMessageResults`). Every table the message lists is accounted
 * for: a withheld one (its module is off, or the stored tables could not be
 * read) leaves a meta line saying so, a failed read leaves an error row with
 * a retry, and the section header counts exactly what it goes on to list.
 * A table copied from an earlier answer says so, with that answer's date,
 * under its title.
 *
 * The bubble renders this twice: the tables the answer referenced
 * (`section="displayed"`) expanded under the prose, and the rest
 * (`section="dataUsed"`) under "Data used (n)" inside the evidence
 * disclosure. Both instances share one cached read.
 *
 * A table with a chart gets a chart/table toggle. The chart is the first
 * view for a referenced table; a table under "Data used" opens as a table.
 * The choice is local to this render and never stored. The chart sits in a
 * figure; its plot is one `role="img"` whose name points at the table view
 * for every value.
 */
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { ChartLine, Table2 } from "lucide-react";

import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ViewToggle } from "@/components/ui/view-toggle";
import { useCoachMessageResults } from "@/hooks/use-coach-message-results";
import {
  COACH_RESULT_UI_KEYS,
  COACH_RESULT_WITHHELD_KEYS,
} from "@/lib/ai/coach/dialog-keys";
import type {
  CoachResultEntry,
  CoachResultMeta,
  CoachResultTable as CoachResultTableData,
} from "@/lib/ai/coach/types";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { importWithRetry } from "@/lib/retry-import";

import { CoachResultTable } from "./result-table";

const CoachResultChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.CoachResultChart }),
    ),
  {
    ssr: false,
    loading: () => (
      <ChartSkeleton mini className="border-0 bg-transparent p-0" />
    ),
  },
);

export type CoachResultsSection = "displayed" | "dataUsed";

export interface CoachResultsProps {
  conversationId: string | null;
  /** The persisted message, once it has an id. */
  messageId: string | null;
  /** `metricSource.results` of the message. */
  metas: CoachResultMeta[];
  /** The tables a live turn streamed; absent on a persisted message. */
  live?: CoachResultTableData[];
  /** Which of the message's tables this instance shows. */
  section: CoachResultsSection;
}

/**
 * When each message of the thread was written, by id, so a table copied
 * from an earlier answer can name that answer's date. The thread provides
 * it; without a provider the line simply goes undated.
 */
const CoachMessageDates = createContext<ReadonlyMap<string, string> | null>(
  null,
);

export function CoachMessageDatesProvider({
  dates,
  children,
}: {
  dates: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  return (
    <CoachMessageDates.Provider value={dates}>
      {children}
    </CoachMessageDates.Provider>
  );
}

/** "From an earlier answer (date)" for a copied table, else null. */
function useReusedLine(result: CoachResultMeta): string | null {
  const { t } = useTranslations();
  const formatters = useFormatters();
  const dates = useContext(CoachMessageDates);
  if (!result.reusedFrom) return null;
  const iso = dates?.get(result.reusedFrom.messageId);
  return iso
    ? t(COACH_RESULT_UI_KEYS.reusedFrom, {
        date: formatters.dateShortSmart(iso),
      })
    : t(COACH_RESULT_UI_KEYS.reusedFromUndated);
}

/** `displayed` per ref, from a message's result metadata. */
function displayedByRef(
  metas: ReadonlyArray<Pick<CoachResultMeta, "ref" | "displayed">>,
): Map<string, boolean> {
  return new Map(metas.map((meta) => [meta.ref, meta.displayed]));
}

/**
 * The live tables with `displayed` taken from the provenance where it names
 * them: a table read while the turn ran is sent before the answer decides.
 */
export function liveWithProvenance<
  T extends Pick<CoachResultMeta, "ref" | "displayed">,
>(
  live: readonly T[],
  metas: ReadonlyArray<Pick<CoachResultMeta, "ref" | "displayed">>,
): T[] {
  const displayed = displayedByRef(metas);
  return live.map((table) => {
    const flag = displayed.get(table.ref);
    return flag === undefined || flag === table.displayed
      ? table
      : { ...table, displayed: flag };
  });
}

/** How many tables sit in a section, from the metadata alone. */
export function countResultsInSection(
  metas: ReadonlyArray<Pick<CoachResultMeta, "displayed">>,
  section: CoachResultsSection,
): number {
  return metas.filter((meta) =>
    section === "displayed" ? meta.displayed : !meta.displayed,
  ).length;
}

type Withheld = Extract<CoachResultEntry, { withheld: string }>["withheld"];

/** One slot of a section: a table to show, or why it is not shown. */
type SectionItem =
  | { ref: string; table: CoachResultTableData }
  | { ref: string; withheld: Withheld };

/**
 * The section's slots, in the order the message lists its tables. A live
 * turn has its tables in hand. A persisted message lists them in its
 * metadata; each is the fetched table, the reason the server gave for not
 * serving it, or `unavailable` when the read came back without it.
 */
function sectionItems(args: {
  metas: CoachResultMeta[];
  live: CoachResultTableData[] | undefined;
  fetched: CoachResultEntry[] | undefined;
  section: CoachResultsSection;
}): SectionItem[] {
  const inSection = (displayed: boolean) =>
    args.section === "displayed" ? displayed : !displayed;
  if (args.live && args.live.length > 0) {
    // v1.41 — a table that arrived while the turn still ran learns whether
    // the answer points at it from the provenance, which comes later.
    const displayed = displayedByRef(args.metas);
    return args.live
      .filter((table) => inSection(displayed.get(table.ref) ?? table.displayed))
      .map((table) => ({ ref: table.ref, table }));
  }
  if (!args.fetched) return [];
  const byRef = new Map(args.fetched.map((entry) => [entry.ref, entry]));
  return args.metas
    .filter((meta) => inSection(meta.displayed))
    .map((meta): SectionItem => {
      const entry = byRef.get(meta.ref);
      if (!entry) return { ref: meta.ref, withheld: "unavailable" };
      if ("withheld" in entry)
        return { ref: meta.ref, withheld: entry.withheld };
      return { ref: meta.ref, table: entry };
    });
}

export function CoachResults({
  conversationId,
  messageId,
  metas,
  live,
  section,
}: CoachResultsProps) {
  const { t } = useTranslations();
  const hasLive = (live?.length ?? 0) > 0;
  const expected = hasLive
    ? countResultsInSection(liveWithProvenance(live ?? [], metas), section)
    : countResultsInSection(metas, section);
  const { ref, results, isError, refetch } = useCoachMessageResults({
    conversationId,
    messageId,
    enabled: !hasLive && expected > 0,
  });
  if (expected === 0) return null;
  const items = sectionItems({ metas, live, fetched: results, section });

  const list = (
    <div
      ref={section === "displayed" ? ref : undefined}
      data-slot="coach-results"
      data-section={section}
      className="flex w-full min-w-0 flex-col gap-3"
    >
      {!hasLive && isError ? (
        <QueryErrorRow
          slot="coach-results-error"
          retrySlot="coach-results-retry"
          message={t(COACH_RESULT_UI_KEYS.loadFailed)}
          onRetry={() => void refetch()}
        />
      ) : null}
      {items.map((item) =>
        "table" in item ? (
          <CoachResultView
            key={item.ref}
            result={item.table}
            chartFirst={section === "displayed"}
          />
        ) : (
          <p
            key={item.ref}
            data-slot="coach-result-withheld"
            data-ref={item.ref}
            className="text-muted-foreground text-xs"
          >
            {t(COACH_RESULT_WITHHELD_KEYS[item.withheld])}
          </p>
        ),
      )}
    </div>
  );
  if (section === "displayed") return list;
  return (
    <div
      ref={ref}
      data-slot="coach-data-used"
      className="flex w-full min-w-0 flex-col gap-2"
    >
      <p className="text-muted-foreground text-xs font-medium">
        {t(COACH_RESULT_UI_KEYS.dataUsed, { count: expected })}
      </p>
      {list}
    </div>
  );
}

type ResultView = "chart" | "table";

function CoachResultView({
  result,
  chartFirst,
}: {
  result: CoachResultTableData;
  chartFirst: boolean;
}) {
  const { t } = useTranslations();
  const titleId = useId();
  const reusedLine = useReusedLine(result);
  const hasChart = result.chart !== null;
  // "As a table" keeps the chart for the toggle but shows the table first.
  const [view, setView] = useState<ResultView>(
    hasChart && chartFirst && result.view !== "table" ? "chart" : "table",
  );
  if (!hasChart) {
    return <CoachResultTable result={result} method={reusedLine} />;
  }

  const toggle = (
    <ViewToggle<ResultView>
      view={view}
      onChange={setView}
      groupLabel={t(COACH_RESULT_UI_KEYS.viewLabel)}
      dataSlotPrefix="coach-result-view"
      segments={[
        {
          value: "chart",
          label: t(COACH_RESULT_UI_KEYS.viewChart),
          icon: ChartLine,
        },
        {
          value: "table",
          label: t(COACH_RESULT_UI_KEYS.viewTable),
          icon: Table2,
        },
      ]}
    />
  );
  if (view === "table") {
    return (
      <CoachResultTable result={result} method={reusedLine} toolbar={toggle} />
    );
  }
  return (
    <figure
      data-slot="coach-result-chart"
      data-ref={result.ref}
      data-chart-kind={result.chart?.kind}
      aria-labelledby={titleId}
      className="bg-card m-0 flex w-full min-w-0 flex-col gap-2 rounded-lg border px-3 pt-2 pb-3"
    >
      <figcaption className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1 pt-1.5 text-sm">
          <span id={titleId} className="text-foreground block font-medium">
            {result.title}
          </span>
          {reusedLine ? (
            <span className="text-muted-foreground block text-xs">
              {reusedLine}
            </span>
          ) : null}
        </span>
        <span className="shrink-0">{toggle}</span>
      </figcaption>
      <ChartErrorBoundary>
        <CoachResultChartLazy
          result={result}
          otherLabel={t(COACH_RESULT_UI_KEYS.other)}
          label={t(COACH_RESULT_UI_KEYS.chartSummary, {
            title: result.title,
          })}
        />
      </ChartErrorBoundary>
    </figure>
  );
}
