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
 * Each row: the kind's icon, one title line and one body line at the same
 * size (the title semibold, both foreground; "Learn more" at the end of the
 * sentence where there is one), and the row's buttons (`AskActions`). Rows
 * are spaced, never ruled. In a wide card the buttons stand beside the
 * text; in a narrow one under it.
 *
 * Every row has two actions. A dose opens the intake sheet (or its
 * medication) and "Later" snoozes it the way the medication card does; a
 * coach check-in is answered in the Coach; a check-up, a visit and a broken
 * connection open where they live; an admin answers the relay question (No,
 * Yes); any other "Later", the server setup's included, sets the ask aside
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
import { queryKeys } from "@/lib/query-keys";

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
      <Card className="@container" data-ask-count={asks.length}>
        <ul className="flex flex-col gap-4 md:gap-6">
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
  const pending = later.isPending || relay.pending || snooze.busy;

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
      className="flex flex-col gap-3 px-4 md:px-6 @min-[44.25rem]:flex-row @min-[44.25rem]:items-center @min-[44.25rem]:gap-6"
    >
      <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Icon aria-hidden="true" className="text-foreground size-5" />
        <h3
          // The title carries the row, at the body's size so the two lines
          // weigh alike; the card's one heading is the section's (screen
          // readers only).
          data-slot="today-ask-title"
          className="text-foreground text-sm leading-5 font-semibold"
        >
          {ask.title}
        </h3>
        {ask.body ? (
          // One line in a wide card: the sentence takes the width the
          // buttons leave, and "More" stays at its end; copy is written to
          // fit. In a narrow card, two lines at most.
          <p
            data-slot="today-ask-body"
            title={ask.body}
            className="text-foreground col-start-2 line-clamp-2 min-w-0 text-sm leading-5 @min-[44.25rem]:line-clamp-none @min-[44.25rem]:flex @min-[44.25rem]:gap-1"
          >
            <span className="@min-[44.25rem]:min-w-0 @min-[44.25rem]:truncate">
              {ask.body}
            </span>
            {ask.learnMore ? (
              <>
                {" "}
                <InlineAction
                  asChild
                  tone="muted"
                  size="sm"
                  className="@min-[44.25rem]:shrink-0"
                >
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
      <div className="pl-8 @min-[44.25rem]:pl-0">
        <AskActions actions={actions} pending={pending} />
      </div>
      {ask.kind === "push_relay" ? relay.dialog : null}
    </li>
  );
}
