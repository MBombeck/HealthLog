"use client";

/**
 * The ask card at the top of the start page: what today asks of the person,
 * at most two rows, and no card at all when nothing does.
 *
 * It renders `DailyDigest.asks` as delivered and decides nothing. Which rows
 * there are, in which order, and when a "later" holds is the server's policy
 * (`src/lib/daily/asks.ts`), so the app shows the same rows.
 *
 * Each row: the kind's icon, a title, one sentence (with "Learn more" set at
 * its end where there is one), and the row's actions in one place, the
 * primary one last (UI standards §12); only the first row's is filled, so the
 * card has one primary. Rows are spaced, never ruled. In a
 * wide card the actions stand beside the text; in a narrow one under it.
 *
 * Every action the old Today card had stays: a dose opens the intake sheet
 * (or its medication), "Later" snoozes it the way the medication card does,
 * a coach check-in is answered in place, a check-up, a visit and a broken
 * connection open where they live, and an admin answers the relay question or sets the notice
 * aside, as on the admin start page.
 */
import { useId, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarCheck,
  CalendarClock,
  Compass,
  MessageCircle,
  Pill,
  RefreshCw,
  Send,
  type LucideIcon,
} from "lucide-react";

import { usePushRelayAnswer } from "@/components/admin/push-relay-question";
import { useDoseSnooze } from "@/components/medications/card-parts/use-dose-snooze";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { useCoachCheckinAction } from "@/hooks/use-coach-checkin";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
} from "@/lib/daily/coach-checkin-intents";
import { ASK_INTENT } from "@/lib/daily/ask-intents";
import type { DailyAsk, DailyAskKind } from "@/lib/daily/asks";
import { VISITS_PATH } from "@/lib/encounters/visit-links";
import { useTranslations } from "@/lib/i18n/context";
import { useDismissServerSetupNotice } from "@/lib/queries/use-server-setup";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<DailyAskKind, LucideIcon> = {
  dose_window: Pill,
  coach_checkin: MessageCircle,
  preventive_care: CalendarClock,
  upcoming_visit: CalendarCheck,
  sync_issue: RefreshCw,
  push_relay: Send,
  server_setup: Compass,
};

/**
 * The label a row's action shows: the server's key, except on a visit,
 * whose wire label is still the check-up one (the shipped app routes that
 * intent); its `href` already opens the visit, so the web names the visit.
 */
export function actionLabelKeyFor(
  kind: DailyAskKind,
  action: Pick<DailyAsk["actions"][number], "labelKey" | "href">,
): string {
  if (kind !== "upcoming_visit" || !action.href) return action.labelKey;
  return action.href === VISITS_PATH
    ? "daily.action.viewAppointments"
    : "daily.action.viewAppointment";
}

/** The dose action's intent; on the web it opens the intake sheet. */
const DOSE_LOG_INTENT = "dose.log";

export function TodayAsks({
  asks,
  onLogDose,
}: {
  asks: DailyAsk[];
  /** Opens the intake sheet; absent where no dose may be logged here. */
  onLogDose?: () => void;
}) {
  const { t } = useTranslations();
  const headingId = useId();
  if (asks.length === 0) return null;
  return (
    <section aria-labelledby={headingId} data-slot="today-asks">
      <h2 id={headingId} className="sr-only">
        {t("daily.morningCard.title.toDo")}
      </h2>
      <Card className="@container" data-ask-count={asks.length}>
        <ul className="flex flex-col gap-4 md:gap-6">
          {asks.map((ask, index) => (
            <AskRow
              key={ask.itemKey}
              ask={ask}
              lead={index === 0}
              onLogDose={onLogDose}
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** One resolved action: a link, or a button with its handler. */
type RowAction =
  | { key: string; label: string; href: string }
  | { key: string; label: string; onClick: () => void };

function AskRow({
  ask,
  lead,
  onLogDose,
}: {
  ask: DailyAsk;
  /**
   * The first row: only its primary action is filled. One primary per card
   * (UI standards §12); the second row's actions are all secondary.
   */
  lead: boolean;
  onLogDose?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { inSharedRecord, canWriteDomain } = useRecordCapabilities();
  const ownRecord = !inSharedRecord;
  const { keep, letGo } = useCoachCheckinAction();
  const refreshAsks = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
  const dismissNotice = useDismissServerSetupNotice();
  const relay = usePushRelayAnswer(refreshAsks);

  // The dose's own snooze, as the medication card offers it: only while a
  // dose of it is open, in the person's own record.
  const snoozeIntent = ask.actions.find((a) =>
    a.intent.startsWith(`${ASK_INTENT.doseSnooze}:`),
  )?.intent;
  const snoozeMedicationId = snoozeIntent?.slice(
    ASK_INTENT.doseSnooze.length + 1,
  );
  const snooze = useDoseSnooze({
    medicationId: snoozeMedicationId ?? "",
    medicationName: ask.subject ?? ask.title,
    enabled: ownRecord && Boolean(snoozeMedicationId),
  });

  const sheetAvailable = Boolean(onLogDose) && canWriteDomain("medications");
  const pending =
    keep.isPending ||
    letGo.isPending ||
    dismissNotice.isPending ||
    relay.pending ||
    snooze.busy;

  const resolve = (action: DailyAsk["actions"][number]): RowAction | null => {
    const label = t(actionLabelKeyFor(ask.kind, action));
    const key = action.intent;
    if (action.intent === DOSE_LOG_INTENT && sheetAvailable) {
      return { key, label, onClick: () => onLogDose?.() };
    }
    if (action.href) return { key, label, href: action.href };
    // Everything below writes the caller's own record or the server.
    if (!ownRecord) return null;
    if (action.intent.startsWith(`${COACH_CHECKIN_KEEP_INTENT}:`)) {
      const planId = action.intent.slice(COACH_CHECKIN_KEEP_INTENT.length + 1);
      return { key, label, onClick: () => keep.mutate(planId) };
    }
    if (action.intent.startsWith(`${COACH_CHECKIN_LETGO_INTENT}:`)) {
      const planId = action.intent.slice(COACH_CHECKIN_LETGO_INTENT.length + 1);
      return { key, label, onClick: () => letGo.mutate(planId) };
    }
    if (action.intent === snoozeIntent) {
      return snooze.canSnooze
        ? {
            key,
            label,
            onClick: () => void snooze.snooze().then(refreshAsks),
          }
        : null;
    }
    if (action.intent === ASK_INTENT.relayYes) {
      return { key, label, onClick: relay.yes };
    }
    if (action.intent === ASK_INTENT.relayNo) {
      return { key, label, onClick: relay.no };
    }
    if (action.intent === ASK_INTENT.noticeLater) {
      return {
        key,
        label,
        onClick: () =>
          dismissNotice.mutate(undefined, { onSuccess: refreshAsks }),
      };
    }
    return null;
  };

  const actions = ask.actions
    .map(resolve)
    .filter((a): a is RowAction => a !== null);
  // The server lists the primary action first; the row shows it last, on
  // the right (UI standards §12), with the others as secondary before it.
  const ordered = [...actions].reverse();
  const primaryKey = lead ? actions[0]?.key : undefined;
  const Icon = KIND_ICON[ask.kind];

  if (relay.answered) return null;

  return (
    <li
      data-slot="today-ask"
      data-kind={ask.kind}
      data-tier={ask.tier}
      className="flex flex-col gap-3 px-4 md:px-6 @min-[44.25rem]:flex-row @min-[44.25rem]:items-center @min-[44.25rem]:gap-6"
    >
      <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Icon aria-hidden="true" className="text-foreground mt-px size-5" />
        <CardTitle
          // The title carries the row; the card's one heading is the
          // section's (screen readers only).
          className="text-base leading-tight"
        >
          {ask.title}
        </CardTitle>
        {ask.body ? (
          <p className="text-foreground col-start-2 text-sm">
            {ask.body}
            {ask.learnMore ? (
              <>
                {" "}
                <InlineAction asChild tone="muted" size="sm">
                  <a href={ask.learnMore.href} target="_blank" rel="noreferrer">
                    {t(ask.learnMore.labelKey)}
                  </a>
                </InlineAction>
              </>
            ) : null}
          </p>
        ) : null}
        {ask.kind === "push_relay" && relay.refusalNote ? (
          <div className="col-start-2">{relay.refusalNote}</div>
        ) : null}
      </div>
      {ordered.length > 0 ? (
        <div
          data-slot="today-ask-actions"
          className="flex shrink-0 flex-wrap items-center gap-2 pl-8 @min-[44.25rem]:pl-0"
        >
          {ordered.map((action) =>
            renderAction(action, action.key === primaryKey, pending),
          )}
        </div>
      ) : null}
      {ask.kind === "push_relay" ? relay.dialog : null}
    </li>
  );
}

function renderAction(
  action: RowAction,
  primary: boolean,
  pending: boolean,
): ReactNode {
  const variant = primary ? "default" : "outline";
  if ("href" in action) {
    return (
      <Link
        key={action.key}
        href={action.href}
        data-slot="today-ask-action"
        className={cn(
          buttonVariants({ variant, size: "sm" }),
          "min-h-11 sm:min-h-9",
        )}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      key={action.key}
      type="button"
      variant={variant}
      size="sm"
      data-slot="today-ask-action"
      className="min-h-11 sm:min-h-9"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}
