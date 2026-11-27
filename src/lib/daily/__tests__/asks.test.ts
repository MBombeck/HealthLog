/**
 * The ask policy (`asks.ts`): only what needs an action today, at most two,
 * safety before decisions before what is due, a "later" holds, and nothing
 * at all on a quiet day. Pinned on the pure resolver and through the digest
 * builder, which is where the candidates come from.
 */
import { describe, expect, it } from "vitest";

import {
  ASK_INTENT,
  buildAdminAsk,
  MAX_DAILY_ASKS,
  resolveDailyAsks,
  type AskCandidate,
} from "@/lib/daily/asks";
import { buildDailyDigest, type DailyDigestInput } from "@/lib/daily/digest";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
} from "@/lib/daily/priority-item";
import { doseWindowItemKey } from "@/lib/daily/priority-item-key";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");
const HOUR = 3_600_000;

function item(over: Partial<PriorityItem> & Pick<PriorityItem, "kind">) {
  return {
    itemKey: `${over.kind}:x`,
    title: over.kind,
    actions: [{ labelKey: "daily.action.viewCheckups", intent: "x" }],
    ...over,
  } as PriorityItem;
}

const dose = (overdue: boolean, id = "med-1"): AskCandidate => ({
  item: item({
    kind: "dose_window",
    itemKey: doseWindowItemKey(id, "2026-07-16T08:00:00.000Z"),
    actions: [{ labelKey: "daily.action.logDose", intent: "dose.log" }],
  }),
  overdue,
  subject: "Ramipril",
});
const checkin: AskCandidate = { item: item({ kind: "coach_checkin" }) };
const checkups: AskCandidate = { item: item({ kind: "preventive_care" }) };
const visitAt = (offsetMs: number): AskCandidate => ({
  item: item({ kind: "upcoming_visit" }),
  startsAt: [new Date(NOW.getTime() + offsetMs).toISOString()],
});

function resolve(
  candidates: AskCandidate[],
  over: Partial<Parameters<typeof resolveDailyAsks>[0]> = {},
) {
  return resolveDailyAsks({
    candidates,
    adminAsk: null,
    snoozedItemKeys: new Set(),
    restMode: false,
    now: NOW,
    ...over,
  });
}

describe("resolveDailyAsks", () => {
  it("asks nothing on a day with nothing to do", () => {
    expect(resolve([])).toEqual([]);
  });

  it("never asks an observation", () => {
    const observations = (
      [
        "milestone",
        "ecg_new_recording",
        "tension_window",
        "same_time_baseline",
        "sync_issue",
      ] as const
    ).map((kind) => ({ item: item({ kind }) }));
    expect(resolve(observations)).toEqual([]);
  });

  it("shows at most two, and the rest waits", () => {
    const asks = resolve([checkups, checkin, dose(false)]);
    expect(asks).toHaveLength(MAX_DAILY_ASKS);
  });

  it("ranks safety, then decision, then due, whatever the digest order", () => {
    const admin = buildAdminAsk("push_relay", t);
    const asks = resolve([checkups, checkin, dose(true)], { adminAsk: admin });
    expect(asks.map((a) => [a.kind, a.tier])).toEqual([
      ["dose_window", "safety"],
      ["push_relay", "decision"],
    ]);
    // Without the overdue dose, the two decisions lead; the admin's first.
    expect(
      resolve([checkups, checkin], { adminAsk: admin }).map((a) => a.kind),
    ).toEqual(["push_relay", "coach_checkin"]);
  });

  it("keeps the digest's order inside a tier", () => {
    const asks = resolve([dose(false, "a"), checkups]);
    expect(asks.map((a) => a.kind)).toEqual(["dose_window", "preventive_care"]);
  });

  it("holds a snoozed dose back and lets the next one up", () => {
    const snoozed = dose(true);
    const asks = resolve([snoozed, checkups], {
      snoozedItemKeys: new Set([snoozed.item.itemKey!]),
    });
    expect(asks.map((a) => a.kind)).toEqual(["preventive_care"]);
  });

  it("pauses check-ups and the coach check-in in Rest mode, not a dose", () => {
    const asks = resolve([checkups, checkin, dose(false)], { restMode: true });
    expect(asks.map((a) => a.kind)).toEqual(["dose_window"]);
  });

  it("asks a reconnect, never a source that only went quiet", () => {
    const reconnect = { item: item({ kind: "sync_issue", status: "warning" }) };
    const quiet = { item: item({ kind: "sync_issue", status: "info" }) };
    expect(resolve([quiet])).toEqual([]);
    expect(resolve([reconnect]).map((a) => [a.kind, a.tier])).toEqual([
      ["sync_issue", "due"],
    ]);
  });

  it("asks about a visit only within the next 24 hours", () => {
    expect(resolve([visitAt(3 * HOUR)])).toHaveLength(1);
    expect(resolve([visitAt(23 * HOUR)])).toHaveLength(1);
    expect(resolve([visitAt(30 * HOUR)])).toEqual([]);
    // Running a little late still counts; long past does not.
    expect(resolve([visitAt(-30 * 60_000)])).toHaveLength(1);
    expect(resolve([visitAt(-3 * HOUR)])).toEqual([]);
  });

  it("gives a dose its own snooze as the secondary action", () => {
    const [ask] = resolve([dose(true)]);
    expect(ask.subject).toBe("Ramipril");
    expect(ask.actions.map((a) => a.intent)).toEqual([
      "dose.log",
      `${ASK_INTENT.doseSnooze}:med-1`,
    ]);
    // A dose without a medication id has nothing to snooze.
    const [anon] = resolve([
      {
        ...dose(true),
        item: { ...dose(true).item, itemKey: doseWindowItemKey(null, null) },
      },
    ]);
    expect(anon.actions.map((a) => a.intent)).toEqual(["dose.log"]);
  });
});

describe("buildAdminAsk", () => {
  it("asks the relay question with yes, no and not now, and learn more", () => {
    const ask = buildAdminAsk("push_relay", t);
    expect(ask.title).toBe("Use the HealthLog push relay?");
    expect(ask.actions.map((a) => a.intent)).toEqual([
      ASK_INTENT.relayYes,
      ASK_INTENT.relayNo,
      ASK_INTENT.noticeLater,
    ]);
    expect(ask.learnMore?.href).toMatch(/push-relay/);
  });

  it("offers the unfinished setup with not now", () => {
    const ask = buildAdminAsk("server_setup", t);
    expect(ask.actions[0]).toMatchObject({
      intent: ASK_INTENT.setupOpen,
      href: "/onboarding/server",
    });
    expect(ask.actions[1].intent).toBe(ASK_INTENT.noticeLater);
  });
});

function meds(over: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 1,
    scheduledToday: 1,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    nextDueMedicationId: null,
    ...over,
  };
}

function input(over: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    now: NOW,
    ai: DIGEST_AI_AVAILABLE,
    todayEndExclusive: new Date("2026-07-17T00:00:00.000Z"),
    modules: {},
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
    score: null,
    briefing: null,
    medsToday: meds(),
    lastNight: { sleep: null, sleepPending: false },
    syncIssues: [],
    preventiveDue: [],
    coachPlans: [],
    tensionWindow: null,
    todayLocalDate: "2026-07-16",
    dismissedItemKeys: new Set<string>(),
    ...over,
  };
}

const overdueMeds = meds({
  dueCandidates: [
    {
      medicationId: "med-1",
      medicationName: "Ramipril",
      dueAt: "2026-07-16T06:00:00.000Z",
      overdue: true,
      availableFrom: "2026-07-16T05:00:00.000Z",
    },
  ],
});

describe("buildDailyDigest publishes the asks", () => {
  it("is empty on a quiet day", () => {
    expect(buildDailyDigest(input(), t).asks).toEqual([]);
  });

  it("asks the overdue dose first, then what is due, and two at most", () => {
    const digest = buildDailyDigest(
      input({
        medsToday: overdueMeds,
        preventiveDue: [{ label: "Dental check-up", longCycle: true }],
        upcomingVisits: [
          {
            id: "v1",
            kind: "ROUTINE",
            occurredAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
            practitionerName: "Practice",
            dayOffset: 0,
            timeLabel: "11:00",
          },
        ],
        adminAsk: "push_relay",
      }),
      t,
    );
    expect(digest.asks.map((a) => [a.kind, a.tier])).toEqual([
      ["dose_window", "safety"],
      ["push_relay", "decision"],
    ]);
    // The rail is untouched: its own cap and order.
    expect(digest.worthALook.length).toBeGreaterThanOrEqual(2);
  });

  it("holds a snoozed dose back", () => {
    const digest = buildDailyDigest(
      input({
        medsToday: overdueMeds,
        snoozedDoseItemKeys: new Set([
          doseWindowItemKey("med-1", "2026-07-16T06:00:00.000Z"),
        ]),
      }),
      t,
    );
    expect(digest.asks).toEqual([]);
  });

  it("follows the person's hidden item kinds", () => {
    const digest = buildDailyDigest(
      input({
        medsToday: overdueMeds,
        enabledHeroItemKinds: PRIORITY_ITEM_KINDS.filter(
          (k) => k !== "dose_window",
        ),
      }),
      t,
    );
    expect(digest.asks).toEqual([]);
  });

  it("asks the admin question only when the loader passed one", () => {
    expect(buildDailyDigest(input({ adminAsk: null }), t).asks).toEqual([]);
    expect(
      buildDailyDigest(input({ adminAsk: "server_setup" }), t).asks[0].kind,
    ).toBe("server_setup");
  });
});
