"use client";

/**
 * The morning block at the top of `/`: one true sentence about the day, the
 * health score beside it, and up to three cards (last night, what is
 * different today, what is to do today). The tiles and charts stay open
 * below it.
 *
 * Two reads feed it and it recomputes neither:
 *  - `GET /api/daily/morning` (`DailyMorning`): the sentence and the first
 *    two cards, worded on the server by fixed rules;
 *  - `GET /api/daily/digest` (`DailyDigest`): the health score, the narrative
 *    line (a reaction line or briefing sentence, already capability-checked
 *    on the server) and the rows of the third card.
 *
 * The third card holds the digest's rows as the old "Worth a look" rail held
 * them, through the same `PriorityCard` and with every action it had: a due
 * dose opens the intake sheet, a coach check-in is answered in place, an
 * observation is dismissed. The medication count and the cycle day ride
 * along as lines. Three rows show; the rest opens in place.
 *
 * The page renders this block only when both reads are there, in the server
 * render and the first client pass alike, so the sentence never changes
 * after hydration. Without a morning read it falls back to `TodayHero`.
 */
import type { ReactNode } from "react";
import { useId } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Plug, Plus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { TileHeader } from "@/components/insights/tile-header";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import { PriorityCard } from "@/components/daily/priority-card";
import { MorningCard } from "@/components/daily/morning-card";
import { useCoachCheckinAction } from "@/hooks/use-coach-checkin";
import { usePriorityItemDismiss } from "@/hooks/use-priority-item-dismiss";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { pluralKey } from "@/lib/i18n/plural";
import { pageHref } from "@/lib/links/hrefs";
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import { cn } from "@/lib/utils";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
} from "@/lib/daily/coach-checkin-intents";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning } from "@/lib/daily/morning";
import type { PriorityItem } from "@/lib/daily/priority-item";
import type { TodayFact, TodayFactKind } from "@/lib/daily/today-overview";
import type { HeroPrimaryContent } from "@/lib/dashboard-layout";

/** The morning read, on the digest's refresh cadence so both move together. */
export function useDailyMorning(enabled = true) {
  return useQuery({
    queryKey: queryKeys.dailyMorning(),
    queryFn: () => apiGet<DailyMorning>("/api/daily/morning"),
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: retryOnceOnTransientError,
  });
}

/** Rows the third card shows before "N more" opens the rest in place. */
export const MORNING_VISIBLE_ROWS = 3;

/** The dose action's intent; on the web it opens the intake sheet. */
const DOSE_LOG_INTENT = "dose.log";

/**
 * The digest's day facts that belong in "To do today", as the morning's
 * contract names them. Sleep and the vitals are the morning's own subject
 * (sentence and first card), Rest mode is the sentence itself, and a visit
 * today is the rail's `upcoming_visit` row.
 */
const TO_DO_FACT_KINDS: readonly TodayFactKind[] = ["medications", "cycle"];

/** Rail kinds that pause in the morning while Rest mode is on. */
const REST_MODE_PAUSED_KINDS: readonly PriorityItem["kind"][] = [
  "preventive_care",
  "coach_checkin",
];

export type MorningToDoRow =
  { type: "fact"; fact: TodayFact } | { type: "item"; item: PriorityItem };

/**
 * The rows of "To do today", in order: the medication count, the rail as the
 * digest delivers it, the cycle day. Rest mode pauses the
 * preventive-care and coach check-in rows here (their pushes keep running).
 * Pure, so the order and the pause can be pinned without a render.
 */
export function morningToDoRows(digest: DailyDigest): MorningToDoRow[] {
  // A digest the service worker cached before the overview existed has no
  // `today`; that reads as "no facts".
  const facts = digest.today ?? [];
  const restMode = facts.some((fact) => fact.kind === "rest_mode");
  const fact = (kind: TodayFactKind): MorningToDoRow[] =>
    facts
      .filter((f) => f.kind === kind && TO_DO_FACT_KINDS.includes(f.kind))
      .map((f) => ({ type: "fact", fact: f }));
  const items: MorningToDoRow[] = digest.worthALook
    .filter((item) => !(restMode && REST_MODE_PAUSED_KINDS.includes(item.kind)))
    .map((item) => ({ type: "item", item }));
  return [...fact("medications"), ...items, ...fact("cycle")];
}

/**
 * A due dose's action, made to open the intake sheet: its `href` is dropped
 * so the card renders a button that reports the intent. Only while the sheet
 * can open here; otherwise the link to the medication stays.
 */
export function withIntakeSheetAction(
  item: PriorityItem,
  sheetAvailable: boolean,
): PriorityItem {
  if (!sheetAvailable || item.kind !== "dose_window") return item;
  return {
    ...item,
    actions: item.actions.map((action) =>
      action.intent === DOSE_LOG_INTENT
        ? { ...action, href: undefined }
        : action,
    ),
  };
}

/** What the top of the dashboard paints. */
export type MorningSlot =
  "off" | "block" | "skeleton" | "hero" | "error" | "none";

/**
 * Which face the top of the dashboard shows, decided from the two reads.
 *
 * The block needs BOTH reads. Until it has them it is a skeleton, in the
 * server render and the first client pass alike (`mounted` is false in
 * both), so the server's markup and the hydration render agree, and the
 * block fills in one step: never a hero first and a morning after, which
 * would change the sentence after hydration. A digest without a morning
 * (the morning read failed, or an older service-worker cache) is the Today
 * hero; a failed digest is the error card. Pure, so the order of these
 * cases is pinned without a render.
 */
export function morningSlot(input: {
  visible: boolean;
  hasDigest: boolean;
  hasMorning: boolean;
  mounted: boolean;
  digestLoading: boolean;
  morningLoading: boolean;
  digestError: boolean;
}): MorningSlot {
  if (!input.visible) return "off";
  if (input.hasDigest && input.hasMorning) return "block";
  if (!input.mounted || input.digestLoading || input.morningLoading) {
    return "skeleton";
  }
  if (input.hasDigest) return "hero";
  if (input.digestError) return "error";
  return "none";
}

/** Format the server-computed score delta as a signed, muted string. */
function formatDelta(
  delta: number,
  t: ReturnType<typeof useTranslations>["t"],
) {
  const rounded = Math.round(delta);
  if (rounded === 0) return t("daily.today.deltaFlat");
  const signed = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return t("daily.today.deltaVsBaseline", { delta: signed });
}

export function MorningBlock({
  digest,
  morning,
  primaryContent = "score",
  onLogDose,
  onAddMeasurement,
}: {
  digest: DailyDigest;
  morning: DailyMorning;
  /** "reminders" puts "To do today" first (the hero setting). */
  primaryContent?: HeroPrimaryContent;
  /** Opens the intake sheet; absent where no dose may be logged. */
  onLogDose?: () => void;
  /** Opens the measurement sheet; absent where none may be added. */
  onAddMeasurement?: () => void;
}) {
  const { t } = useTranslations();
  const headingId = useId();
  const rows = morningToDoRows(digest);
  const narrative =
    digest.lead &&
    (digest.lead.source === "reaction" || digest.lead.source === "briefing")
      ? digest.lead.text
      : null;
  const empty =
    morning.lead.key === "nothing" &&
    morning.cards.length === 0 &&
    rows.length === 0;

  const toDoCard =
    rows.length > 0 ? (
      <MorningToDoCard
        key="to_do"
        title={morning.toDo.title || t(morning.toDo.titleKey)}
        rows={rows}
        onLogDose={onLogDose}
      />
    ) : null;
  const serverCards = morning.cards.map((card) => (
    <MorningCard key={card.kind} card={card} />
  ));
  const cards = (
    primaryContent === "reminders"
      ? [toDoCard, ...serverCards]
      : [...serverCards, toDoCard]
  ).filter(Boolean);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="morning-block"
      data-lead={morning.lead.key}
      data-rank={morning.lead.rank}
      data-generated-at={morning.generatedAt}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 md:gap-x-6">
        <div className="min-w-0 space-y-1.5">
          <h2
            id={headingId}
            className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
          >
            {t("daily.today.heading")}
          </h2>
          {empty ? null : (
            <p
              data-slot="morning-lead"
              lang={morning.lead.language}
              className="text-foreground text-lg leading-snug font-semibold tracking-tight text-balance sm:text-xl"
            >
              {morning.lead.text}
            </p>
          )}
          {narrative ? (
            <div
              data-slot="morning-narrative"
              data-source={digest.lead?.source}
              lang={digest.lead?.language ?? undefined}
              className="text-muted-foreground text-sm"
            >
              <ProseBlocks text={narrative} strip linkify={false} />
            </div>
          ) : null}
        </div>
        {empty ? null : <MorningScore digest={digest} />}
      </div>

      {empty ? (
        <EmptyState
          data-slot="morning-empty"
          variant="card"
          size="compact"
          title={morning.lead.text}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {onAddMeasurement ? (
                <Button size="sm" onClick={onAddMeasurement}>
                  <Plus aria-hidden="true" />
                  {t("daily.morning.addValue")}
                </Button>
              ) : null}
              <Link
                href="/settings/integrations"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Plug aria-hidden="true" />
                {t("daily.morning.connectSource")}
              </Link>
            </div>
          }
        />
      ) : cards.length > 0 ? (
        <div
          data-slot="morning-cards"
          className={cn(
            "grid gap-4",
            cards.length > 1 && "md:grid-cols-2",
            cards.length > 2 && "xl:grid-cols-3",
          )}
        >
          {cards}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The health score beside the sentence: the compact ring with its delta, how
 * long it has held, and what it rests on, as the Today hero showed it. A null
 * score is the ring's provisional face, never a zero.
 */
function MorningScore({ digest }: { digest: DailyDigest }) {
  const { t, locale } = useTranslations();
  const score = digest.score;
  const deltaShown =
    score !== null && score.delta !== null && score.deltaReason === null;
  const steadyWeeks = score?.steadyWeeks ?? null;
  const steadyLine =
    !deltaShown && steadyWeeks !== null
      ? t(
          score?.steadyAtLeast
            ? pluralKey("daily.today.steadyAtLeastWeeks", steadyWeeks, locale)
            : pluralKey("daily.today.steadyWeeks", steadyWeeks, locale),
          { count: steadyWeeks },
        )
      : null;
  const basis = score?.scoreBasis ?? null;
  const basisLine =
    basis && basis.tier !== "full"
      ? t("insights.healthScore.basis", {
          count: basis.domains,
          recommended: basis.recommended,
        })
      : null;
  const label = t("daily.today.scoreLabel");
  const meta: ReactNode[] = [];
  if (deltaShown && score?.delta != null) {
    meta.push(
      <span
        key="delta"
        data-slot="morning-score-delta"
        className="tabular-nums"
      >
        {formatDelta(score.delta, t)}
      </span>,
    );
  }
  if (steadyLine) meta.push(<span key="steady">{steadyLine}</span>);
  if (basisLine) {
    meta.push(
      <span key="basis" data-slot="morning-score-basis">
        {basisLine}
      </span>,
    );
  }
  const ring = (size: "responsive" | "sm") => (
    <ScoreRing
      score={score?.value ?? null}
      band={score ? ((score.numberBand ?? score.band) as ScoreBand) : undefined}
      size={size}
      flat
    />
  );

  return (
    <div
      data-slot="morning-score"
      className="flex w-20 shrink-0 flex-col items-center gap-1 text-center md:w-30"
    >
      {/* The ring opens the health score's home on Insights; named by what
          it shows, with the purpose for screen readers (WCAG 2.5.3). It is
          compact at every width: 80 px on a phone, 120 px from md up. The
          face not shown is `display: none`, out of the accessibility tree. */}
      <Link
        href={pageHref("insights")}
        className="focus-visible:ring-ring/50 block rounded-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="sr-only">
          {t("daily.today.ringLink", { metric: label })}
        </span>
        <span className="block md:hidden">{ring("responsive")}</span>
        <span className="hidden md:block">{ring("sm")}</span>
        {/* Named under the dial rather than inside it: "Gesundheitsscore"
            overran the 120 px dial's centre. */}
        <span className="text-foreground mt-1 block text-xs font-medium break-words hyphens-auto">
          {label}
        </span>
      </Link>
      {/* The pillar the green band leaves unsaid, worded on the server:
          content, so foreground. */}
      {score?.bandSetterLine ? (
        <p
          data-slot="morning-score-setter"
          className="text-foreground text-xs text-balance"
        >
          {score.bandSetterLine}
        </p>
      ) : null}
      {meta.length > 0 ? (
        <div className="text-muted-foreground flex flex-col gap-0.5 text-xs text-balance">
          {meta}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "To do today": the digest's rows through the rail's own `PriorityCard`,
 * with every action the rail had. The first three rows show; the rest opens
 * in place under "N more" (the browser's `<details>`, so the page search
 * finds them too).
 */
function MorningToDoCard({
  title,
  rows,
  onLogDose,
}: {
  title: string;
  rows: MorningToDoRow[];
  onLogDose?: () => void;
}) {
  const { t, locale } = useTranslations();
  const { keep, letGo } = useCoachCheckinAction();
  const dismissItem = usePriorityItemDismiss();
  // Answering a check-in and dismissing an observation write the CALLER's
  // own record, so inside a shared record neither is offered (the Today
  // hero's rule). Logging a dose follows the record's medication grant.
  const caps = useRecordCapabilities();
  const { canWriteDomain } = caps;
  // #1615 — or a managed profile's guardian, who holds the owner's rights.
  const ownRecord = holdsOwnerRights(caps);
  const sheetAvailable = Boolean(onLogDose) && canWriteDomain("medications");

  const handleAction = (intent: string) => {
    if (intent === DOSE_LOG_INTENT) {
      onLogDose?.();
      return;
    }
    const keepPrefix = `${COACH_CHECKIN_KEEP_INTENT}:`;
    const letGoPrefix = `${COACH_CHECKIN_LETGO_INTENT}:`;
    if (intent.startsWith(keepPrefix)) {
      keep.mutate(intent.slice(keepPrefix.length));
    } else if (intent.startsWith(letGoPrefix)) {
      letGo.mutate(intent.slice(letGoPrefix.length));
    }
  };

  const renderRow = (row: MorningToDoRow, i: number) =>
    row.type === "fact" ? (
      <li
        key={`fact-${row.fact.kind}`}
        data-slot="morning-row"
        data-kind={row.fact.kind}
      >
        <Link
          href={row.fact.href}
          className="focus-visible:ring-ring/50 hover:bg-muted/50 -mx-1.5 flex min-h-11 flex-col justify-center gap-0.5 rounded-md px-1.5 py-1 focus-visible:ring-2 focus-visible:outline-none md:min-h-0"
        >
          <span className="text-muted-foreground text-xs">
            {row.fact.label}
          </span>
          <span className="text-foreground text-sm font-medium">
            {row.fact.value}
          </span>
        </Link>
      </li>
    ) : (
      <li
        key={`item-${row.item.kind}-${row.item.itemKey ?? i}`}
        data-slot="morning-row"
        data-kind={row.item.kind}
      >
        <PriorityCard
          item={withIntakeSheetAction(row.item, sheetAvailable)}
          // A dose is logged where the record's medication grant allows;
          // every other button writes the caller's own record.
          onAction={
            (row.item.kind === "dose_window" ? sheetAvailable : ownRecord)
              ? handleAction
              : undefined
          }
          onDismiss={
            ownRecord ? (itemKey) => dismissItem.mutate(itemKey) : undefined
          }
          actionsPending={
            row.item.kind === "coach_checkin" &&
            (keep.isPending || letGo.isPending)
          }
        />
      </li>
    );

  const visible = rows.slice(0, MORNING_VISIBLE_ROWS);
  const rest = rows.slice(MORNING_VISIBLE_ROWS);

  return (
    <Card
      data-slot="morning-card"
      data-kind="to_do"
      density="compact"
      className="h-full"
    >
      <CardContent className="flex flex-col gap-3">
        <TileHeader icon={ListChecks} size="sm" titleAs="h3" title={title} />
        <ul className="flex flex-col gap-2">{visible.map(renderRow)}</ul>
        {rest.length > 0 ? (
          <Disclosure
            data-slot="morning-more"
            summary={t(pluralKey("daily.morning.more", rest.length, locale), {
              count: rest.length,
            })}
          >
            <ul className="flex flex-col gap-2">
              {rest.map((row, i) => renderRow(row, i + MORNING_VISIBLE_ROWS))}
            </ul>
          </Disclosure>
        ) : null}
      </CardContent>
    </Card>
  );
}
