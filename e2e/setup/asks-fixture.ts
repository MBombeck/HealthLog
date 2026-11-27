/**
 * Asks as the server words them, for the ask card's browser checks: built
 * by the digest builder itself (`buildDailyDigest` → `asksFromDigest`) in a
 * given language, so the strings the card lays out are the production ones,
 * not copies. The page then gets them through a mocked digest read.
 *
 * One card with every kind but the relay (an admin sees the setup or the
 * relay, never both): a dose past its time, the server setup, a coach
 * check-in, a check-up, a visit tomorrow and a broken source. That puts the
 * widest button labels of the language in one card, the narrowest text
 * column the card can have.
 */
import type { DailyAsk } from "@/lib/daily/asks";
import { buildDailyDigest, type DailyDigestInput } from "@/lib/daily/digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { makeFormatters } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const NOW = new Date("2026-11-27T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function serverAsks(
  locale: Locale,
  {
    practitionerName = "Family practice",
    timeFormat = "AUTO",
  }: { practitionerName?: string; timeFormat?: "AUTO" | "H12" } = {},
): DailyAsk[] {
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
  };
  return buildDailyDigest(input, getServerTranslator(locale).t).asks;
}
