/**
 * Asks as the server words them, for the ask card's browser checks: the
 * policy and the wording are the server's own (`asksFromDigest`), in a
 * given language, so the strings the card lays out are the production ones,
 * not copies. Only the rail items are written here, as the digest builder
 * writes them: the builder itself reaches the database client, which the
 * browser test runner cannot load. `asks.test.ts` holds these asks equal to
 * what `buildDailyDigest` returns for the same input. The page gets them
 * through a mocked digest read.
 *
 * One card with every kind but the relay (an admin sees the setup or the
 * relay, never both): a dose past its time, the server setup, a coach
 * check-in, a check-up, a visit tomorrow, a broken source and one that went
 * quiet twelve days ago (two digits, the widest count a phone usually sees). That puts the
 * widest button labels of the language in one card, the narrowest text
 * column the card can have.
 */
import { asksFromDigest, type DailyAsk } from "@/lib/daily/asks";
import type { DailyDigestInput } from "@/lib/daily/digest";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
} from "@/lib/daily/priority-item";
import {
  coachCheckinItemKey,
  doseWindowItemKey,
  preventiveCareItemKey,
  syncIssueItemKey,
  upcomingVisitItemKey,
} from "@/lib/daily/priority-item-key";
import { makeFormatters } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const NOW = new Date("2026-11-27T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function asksFixtureInput(
  locale: Locale,
  {
    practitionerName = "Family practice",
    timeFormat = "AUTO",
  }: { practitionerName?: string; timeFormat?: "AUTO" | "H12" } = {},
): DailyDigestInput {
  const localTime = makeFormatters(
    locale,
    "Europe/Berlin",
    timeFormat,
    "AUTO",
  ).time;
  const input: DailyDigestInput = {
    now: NOW,
    ai: DIGEST_AI_AVAILABLE,
    todayEndExclusive: new Date("2026-11-28T00:00:00.000Z"),
    modules: {},
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
    score: null,
    briefing: null,
    medsToday: {
      activeCount: 1,
      scheduledToday: 1,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
      nextDueMedicationId: null,
      dueCandidates: [
        {
          medicationId: "e2e-med",
          medicationName: "Ramipril",
          // 08:00 in Berlin; under H12 it is the widest the clock prints.
          dueAt: "2026-11-27T07:00:00.000Z",
          overdue: true,
          availableFrom: "2026-11-27T06:00:00.000Z",
        },
      ],
    },
    lastNight: { sleep: null, sleepPending: false },
    syncIssues: [
      {
        integration: "withings",
        state: "error_reauth",
        lastSuccessAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      },
    ],
    quietSources: [
      {
        source: "google-health",
        provider: "Google Health",
        sinceYesterday: false,
        date: "15 Nov",
        days: 12,
        href: "/settings/integrations#google-health",
      },
    ],
    preventiveDue: [{ label: "Zahnvorsorge", longCycle: true }],
    upcomingVisits: [
      {
        id: "e2e-visit",
        kind: "ROUTINE",
        occurredAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
        practitionerName,
        dayOffset: 1,
        timeLabel: localTime(new Date(NOW.getTime() + 24 * HOUR)),
      },
    ],
    coachPlans: [
      {
        id: "e2e-plan",
        status: "active",
        reviewDate: null,
        createdAt: new Date(NOW.getTime() - 10 * DAY),
        updatedAt: new Date(NOW.getTime() - 10 * DAY),
        planText: "Walk after lunch",
      },
    ],
    tensionWindow: null,
    todayLocalDate: "2026-11-27",
    dismissedItemKeys: new Set<string>(),
    adminAsk: "server_setup",
    localTime,
    locale,
  };
  return input;
}

/** The rail items the digest builds from that input, as it builds them. */
function railItems(input: DailyDigestInput): PriorityItem[] {
  const dose = input.medsToday.dueCandidates![0];
  const visit = input.upcomingVisits![0];
  const plan = input.coachPlans[0];
  const issue = input.syncIssues[0];
  const item = (
    over: Pick<PriorityItem, "kind" | "itemKey" | "actions"> &
      Partial<PriorityItem>,
  ): PriorityItem => ({ title: "", body: "", status: "info", ...over });
  return [
    item({
      kind: "dose_window",
      itemKey: doseWindowItemKey(dose.medicationId, dose.dueAt),
      actions: [
        {
          labelKey: "daily.action.logDose",
          intent: "dose.log",
          href: `/medications?highlight=${dose.medicationId}`,
        },
      ],
    }),
    item({
      kind: "coach_checkin",
      itemKey: coachCheckinItemKey(plan.id),
      actions: [
        {
          labelKey: "daily.action.checkinAdjust",
          intent: "coach.checkin.adjust",
          href: "/coach?ask=e2e",
        },
      ],
    }),
    item({
      kind: "sync_issue",
      itemKey: syncIssueItemKey(issue.integration),
      status: "warning",
      actions: [
        {
          labelKey: "daily.action.reconnect",
          intent: "sync.reconnect",
          href: "/settings/integrations",
        },
      ],
    }),
    item({
      kind: "preventive_care",
      itemKey: preventiveCareItemKey(input.todayLocalDate),
      actions: [
        {
          labelKey: "daily.action.viewCheckups",
          intent: "checkup.view",
          href: "/checkups",
        },
      ],
    }),
    item({
      kind: "upcoming_visit",
      itemKey: upcomingVisitItemKey(visit.dayOffset, visit.id),
      actions: [
        {
          labelKey: "daily.action.viewCheckups",
          intent: "checkup.view",
          href: "/visits",
        },
      ],
    }),
  ];
}

export function serverAsks(
  locale: Locale,
  options: Parameters<typeof asksFixtureInput>[1] = {},
): DailyAsk[] {
  const input = asksFixtureInput(locale, options);
  return asksFromDigest(input, railItems(input), getServerTranslator(locale).t);
}
