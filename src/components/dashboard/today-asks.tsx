"use client";

/**
 * The ask card at the top of the start page: what today asks of the person,
 * and no card at all when nothing does.
 *
 * It renders `DailyDigest.asks` as delivered and decides nothing. Which rows
 * there are, in which order, and when a "later" holds is the server's policy
 * (`src/lib/daily/asks.ts`), so the app shows the same rows, all of them:
 * the rules keep the list short, so nothing folds away.
 *
 * One list, a line between rows, the same anatomy at every width: the
 * kind's icon, the title (the thing: a medication, a check-up, a visit) over
 * one meta line (its state: "Overdue 8:00 AM", "Visit tomorrow"), and the
 * two buttons at the right end of the row (`AskActions`). Title and meta are
 * one line each. The server words them to fit a phone (`asks-text-budget`
 * test); a name the person typed can still be longer, and only the title
 * then ends in an ellipsis, its full text still the heading's accessible
 * name and its tooltip. A row past its time (`safety`) sets its meta in the
 * warning colour; the word carries the meaning, the colour repeats it.
 *
 * The card is a grid whose rows share its columns (`subgrid`): the buttons'
 * column is as wide as the widest pair in the card, so every row's buttons
 * stand in one column and the text takes all the room that is left.
 *
 * Every row has two actions. A dose opens the intake sheet (or its
 * medication) and "Later" snoozes it the way the medication card does; a
 * coach check-in is answered in the Coach; a check-up, a visit and a broken
 * connection open where they live; an admin answers the relay question (No,
 * Yes) or sets the setup notice aside; any other "Later" sets the ask aside
 * until tomorrow.
 */
import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { AskActions, type AskAction } from "@/components/dashboard/ask-actions";
import { Card } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { ASK_INTENT } from "@/lib/daily/ask-intents";
import type { DailyAsk, DailyAskKind } from "@/lib/daily/asks";
import { apiPost } from "@/lib/api/api-fetch";
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
      <Card
        className="@container gap-0 overflow-hidden py-0 md:py-0"
        data-ask-count={asks.length}
      >
        <ul
          data-slot="today-ask-list"
          className="divide-border/70 grid grid-cols-[auto_minmax(0,1fr)_max-content] divide-y"
        >
          {asks.map((ask) => (
            <AskRow key={ask.itemKey} ask={ask} onLogDose={onLogDose} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function AskRow({ ask, onLogDose }: { ask: DailyAsk; onLogDose?: () => void }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const titleId = useId();
  const caps = useRecordCapabilities();
  const { canWriteDomain } = caps;
  // #1615 — or a managed profile's guardian, who holds the owner's rights.
  const ownRecord = holdsOwnerRights(caps);
  const refreshAsks = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
  // "Later" on a reminder without a snooze of its own: the ask set aside for
  // the rest of the local day, through the dismiss ledger (`ask-later:` key).
  const later = useMutation({
    mutationFn: (itemKey: string) =>
      apiPost("/api/daily/digest/dismiss", { itemKey }),
    onSuccess: refreshAsks,
  });
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
    later.isPending || dismissNotice.isPending || relay.pending || snooze.busy;

  const resolve = (action: DailyAsk["actions"][number]): AskAction | null => {
    const label = t(action.labelKey);
    const key = action.intent;
    if (action.intent === DOSE_LOG_INTENT && sheetAvailable) {
      return { key, label, onClick: () => onLogDose?.() };
    }
    if (action.href) return { key, label, href: action.href };
    // Everything below writes the caller's own record or the server.
    if (!ownRecord) return null;
    if (action.intent.startsWith(`${ASK_INTENT.later}:`)) {
      const itemKey = action.intent.slice(ASK_INTENT.later.length + 1);
      return { key, label, onClick: () => later.mutate(itemKey) };
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
    .filter((a): a is AskAction => a !== null);
  const Icon = KIND_ICON[ask.kind];

  if (relay.answered) return null;

  return (
    <li
      data-slot="today-ask"
      data-kind={ask.kind}
      data-tier={ask.tier}
      className="col-span-3 grid grid-cols-subgrid items-center gap-x-2 px-3 py-3 md:gap-x-3 md:px-6"
    >
      <Icon
        aria-hidden="true"
        className="text-foreground size-4 @min-[44.25rem]:size-5"
      />
      <div className="min-w-0">
        <h3
          id={titleId}
          // One line. A name the person typed may run long: it ends in an
          // ellipsis, and the full text stays the heading's accessible name
          // and its tooltip. The card's one heading is the section's (screen
          // readers only).
          data-slot="today-ask-title"
          title={ask.title}
          className="text-foreground truncate text-sm leading-5 font-semibold"
        >
          {ask.title}
        </h3>
        {ask.body ? (
          // One line, worded on the server to fit it at 360 px in every
          // language (`ASK_TEXT_BUDGET`).
          <p
            data-slot="today-ask-meta"
            className={cn(
              "flex min-w-0 gap-1 text-xs leading-4 whitespace-nowrap",
              ask.tier === "safety"
                ? "text-warning font-medium"
                : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 truncate">{ask.body}</span>
            {ask.learnMore ? (
              <InlineAction asChild tone="muted" size="xs" className="shrink-0">
                <a href={ask.learnMore.href} target="_blank" rel="noreferrer">
                  {t(ask.learnMore.labelKey)}
                </a>
              </InlineAction>
            ) : null}
          </p>
        ) : null}
        {ask.kind === "push_relay" && relay.refusalNote ? (
          <div className="mt-1 whitespace-normal">{relay.refusalNote}</div>
        ) : null}
      </div>
      <AskActions actions={actions} pending={pending} describedBy={titleId} />
      {ask.kind === "push_relay" ? relay.dialog : null}
    </li>
  );
}
