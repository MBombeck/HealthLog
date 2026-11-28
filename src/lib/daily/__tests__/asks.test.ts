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
  CONSENT_ASK_KINDS,
  doseMeta,
  isMandatoryAsk,
  OPTIONAL_ASK_KINDS,
  DAILY_ASK_KINDS,
  resolveDailyAsks,
  sourceStalledAsks,
  type AskCandidate,
  type DailyAsk,
} from "@/lib/daily/asks";
import {
  asksFixtureInput,
  serverAsks,
} from "../../../../e2e/setup/asks-fixture";
import { buildDailyDigest, type DailyDigestInput } from "@/lib/daily/digest";
import {
  isDismissibleItemKey,
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
} from "@/lib/daily/priority-item";
import { askLaterKey } from "@/lib/daily/ask-intents";
import { doseWindowItemKey } from "@/lib/daily/priority-item-key";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyDigestQuietSource } from "@/lib/daily/quiet-source-items";
import {
  aiUnavailable,
  DIGEST_AI_AVAILABLE,
} from "@/__tests__/helpers/ai-capability-fixtures";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The actions the digest builds for each kind, as it builds them. */
const RAIL_ACTIONS: Partial<Record<string, PriorityItem["actions"]>> = {
  preventive_care: [
    {
      labelKey: "daily.action.viewCheckups",
      intent: "checkup.view",
      href: "/checkups",
    },
  ],
  upcoming_visit: [
    {
      labelKey: "daily.action.viewCheckups",
      intent: "checkup.view",
      href: "/visits/v1",
    },
  ],
  sync_issue: [
    {
      labelKey: "daily.action.reconnect",
      intent: "sync.reconnect",
      href: "/settings/integrations",
    },
  ],
  coach_checkin: [
    { labelKey: "daily.action.checkinKeep", intent: "coach.checkin.keep:p1" },
    {
      labelKey: "daily.action.checkinAdjust",
      intent: "coach.checkin.adjust",
      href: "/coach?ask=x",
    },
    { labelKey: "daily.action.checkinLetGo", intent: "coach.checkin.letGo:p1" },
  ],
};

function item(over: Partial<PriorityItem> & Pick<PriorityItem, "kind">) {
  return {
    itemKey: `${over.kind}:x`,
    title: over.kind,
    actions: RAIL_ACTIONS[over.kind] ?? [
      { labelKey: "daily.action.viewMilestone", intent: "x" },
    ],
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
const visitAt = (offsetMs: number, dayOffset = 0): AskCandidate => ({
  item: item({ kind: "upcoming_visit" }),
  startsAt: [new Date(NOW.getTime() + offsetMs).toISOString()],
  dayOffset,
});
/** A source whose sign-in expired a day ago: the one sync that asks. */
const broken: AskCandidate = {
  item: item({ kind: "sync_issue", status: "warning" }),
  needsPerson: true,
};

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
    today: "2026-07-16",
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

  it("asks every row that passes, without a cap or a fold", () => {
    const asks = resolve([checkups, checkin, dose(false), visitAt(HOUR)], {
      adminAsk: buildAdminAsk("server_setup", t, "2026-07-16"),
    });
    expect(asks).toHaveLength(5);
  });

  it("ranks safety, then decision, then due, whatever the digest order", () => {
    const admin = buildAdminAsk("push_relay", t, "2026-07-16");
    const asks = resolve([checkups, checkin, dose(true)], { adminAsk: admin });
    expect(asks.map((a) => [a.kind, a.tier])).toEqual([
      ["dose_window", "safety"],
      ["push_relay", "decision"],
      ["coach_checkin", "decision"],
      ["preventive_care", "due"],
    ]);
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
    const reconnect = broken;
    const quiet = { item: item({ kind: "sync_issue", status: "info" }) };
    expect(resolve([quiet])).toEqual([]);
    expect(resolve([reconnect]).map((a) => [a.kind, a.tier])).toEqual([
      ["sync_issue", "due"],
    ]);
  });

  it("asks about a visit only today or tomorrow", () => {
    expect(resolve([visitAt(3 * HOUR)])).toHaveLength(1);
    expect(resolve([visitAt(23 * HOUR, 1)])).toHaveLength(1);
    expect(resolve([visitAt(30 * HOUR, 2)])).toEqual([]);
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
    // A dose without a medication id is set aside for the day instead.
    const [anon] = resolve([
      {
        ...dose(true),
        item: { ...dose(true).item, itemKey: doseWindowItemKey(null, null) },
      },
    ]);
    expect(anon.actions.map((a) => a.intent)).toEqual([
      "dose.log",
      `${ASK_INTENT.later}:ask-later:2026-07-16:dose_window:-:-`,
    ]);
  });
});

describe("the person's switches", () => {
  it("drops a category the person switched off", () => {
    const asks = resolve([checkups, visitAt(HOUR), dose(false)], {
      enabledKinds: ["upcoming_visit"],
    });
    expect(asks.map((a) => a.kind)).toEqual(["upcoming_visit"]);
  });

  it("mandatory categories ignore the opt-out: an overdue dose and the admin questions", () => {
    const off = { enabledKinds: [] as string[] };
    expect(
      resolve([dose(true), dose(false, "b"), checkups], {
        ...off,
        adminAsk: buildAdminAsk("push_relay", t, "2026-07-16"),
      }).map((a) => [a.kind, a.tier]),
    ).toEqual([
      ["dose_window", "safety"],
      ["push_relay", "decision"],
    ]);
    expect(
      resolve([], {
        ...off,
        adminAsk: buildAdminAsk("server_setup", t, "2026-07-16"),
      }).map((a) => a.kind),
    ).toEqual(["server_setup"]);
  });

  it("offers a switch only for optional categories", () => {
    for (const kind of OPTIONAL_ASK_KINDS) {
      expect(isMandatoryAsk({ kind, tier: "due" })).toBe(false);
    }
    expect(isMandatoryAsk({ kind: "dose_window", tier: "safety" })).toBe(true);
    for (const kind of ["push_relay", "server_setup"] as const) {
      expect(isMandatoryAsk({ kind, tier: "decision" })).toBe(true);
    }
  });
});

describe("buildAdminAsk", () => {
  it("asks the relay question with yes and no only, and no link on the row", () => {
    const ask = buildAdminAsk("push_relay", t, "2026-07-16");
    expect(ask.title).toBe("Push relay?");
    expect(ask.body).toBe("Encrypted");
    expect(ask.actions.map((a) => a.intent)).toEqual([
      ASK_INTENT.relayYes,
      ASK_INTENT.relayNo,
    ]);
    // The relay dialog behind "Yes" links the terms; the row has no room.
    expect(ask.learnMore).toBeNull();
  });

  it("offers the unfinished setup with Set up and Later", () => {
    const ask = buildAdminAsk("server_setup", t, "2026-07-16");
    expect(ask.actions[0]).toMatchObject({
      labelKey: "daily.action.setUp",
      intent: ASK_INTENT.setupOpen,
      href: "/onboarding/server",
    });
    expect(ask.actions[1]).toMatchObject({
      labelKey: "daily.action.later",
      intent: `${ASK_INTENT.later}:${askLaterKey("2026-07-16", "server_setup:notice")}`,
    });
  });

  it("Later on the setup holds it for the day, like every other ask", () => {
    const ask = buildAdminAsk("server_setup", t, "2026-07-16");
    const held = new Set([ask.itemKey]);
    // Set aside today: not asked.
    expect(resolve([], { adminAsk: ask, snoozedItemKeys: held })).toEqual([]);
    // The next day's ledger key no longer matches: asked again.
    expect(
      resolve([], {
        adminAsk: buildAdminAsk("server_setup", t, "2026-07-17"),
      }).map((a) => a.kind),
    ).toEqual(["server_setup"]);
    // And it is a dismiss-ledger key the dismiss route accepts.
    const key = ask.actions[1].intent.slice(ASK_INTENT.later.length + 1);
    expect(isDismissibleItemKey(key)).toBe(true);
  });

  it("a consent ask always exposes an explicit no, and never a later", () => {
    // Every consent kind the policy knows, built the way it reaches a page.
    const consents = DAILY_ASK_KINDS.filter((k) =>
      CONSENT_ASK_KINDS.includes(k),
    );
    expect(consents.length).toBeGreaterThan(0);
    for (const kind of consents) {
      const ask = buildAdminAsk(kind as "push_relay", t, "2026-07-16");
      const intents = ask.actions.map((a) => a.intent);
      expect(intents).toContain(ASK_INTENT.relayNo);
      expect(intents.some((i) => i.startsWith(ASK_INTENT.later))).toBe(false);
      expect(intents.some((i) => i.startsWith(ASK_INTENT.doseSnooze))).toBe(
        false,
      );
      // And through the resolver, among other rows.
      const [first] = resolve([dose(false)], { adminAsk: ask });
      expect(first.actions.map((a) => a.labelKey)).toEqual([
        "admin.pushRelay.question.yes",
        "admin.pushRelay.question.no",
      ]);
    }
  });

  it("labels every action with a short verb", () => {
    const asks = resolve([
      dose(true),
      checkups,
      checkin,
      visitAt(HOUR),
      broken,
    ]);
    expect(asks.map((a) => [a.kind, a.actions.map((x) => x.labelKey)])).toEqual(
      [
        ["dose_window", ["daily.action.logDose", "daily.action.later"]],
        ["coach_checkin", ["daily.action.answer", "daily.action.later"]],
        ["preventive_care", ["daily.action.open", "daily.action.later"]],
        ["upcoming_visit", ["daily.action.open", "daily.action.later"]],
        ["sync_issue", ["daily.action.reconnectShort", "daily.action.later"]],
      ],
    );
  });
});

describe("what does not ask, kind by kind", () => {
  it("a dose: never one that opens later today", () => {
    const digest = buildDailyDigest(
      input({
        medsToday: meds({
          dueCandidates: [
            {
              medicationId: "med-1",
              medicationName: "Magnesium",
              dueAt: "2026-07-16T18:00:00.000Z",
              overdue: false,
              availableFrom: "2026-07-16T17:00:00.000Z",
            },
          ],
        }),
      }),
      t,
    );
    expect(digest.asks).toEqual([]);
  });

  it("a check-up: never one that is not due yet", () => {
    // The loader keeps only check-ups due now (`isCheckupDueNow`); an empty
    // list is what a check-up due next week leaves the builder.
    expect(buildDailyDigest(input({ preventiveDue: [] }), t).asks).toEqual([]);
  });

  it("a visit: never two days out, never long past, never after a later", () => {
    expect(resolve([visitAt(40 * HOUR, 2)])).toEqual([]);
    expect(resolve([visitAt(-3 * HOUR, 0)])).toEqual([]);
    const later = visitAt(20 * HOUR, 1);
    expect(
      resolve([later], { snoozedItemKeys: new Set([later.item.itemKey!]) }),
    ).toEqual([]);
  });

  it("a sync: never a quiet source, a retried one, or one that broke hours ago", () => {
    const issue = (over: Partial<DailyDigestInput["syncIssues"][number]>) =>
      buildDailyDigest(
        input({
          syncIssues: [
            {
              integration: "withings",
              state: "error_reauth",
              lastSuccessAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
              ...over,
            },
          ],
        }),
        t,
      ).asks.map((a) => a.kind);
    // Broken, needs the person, nothing for two days: asks.
    expect(issue({})).toEqual(["sync_issue"]);
    // Broken only hours ago: not yet.
    expect(
      issue({
        lastSuccessAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
      }),
    ).toEqual([]);
    // A state the server works on by itself.
    expect(issue({ state: "parked" })).toEqual([]);
    // A source that only went quiet is information.
    expect(
      resolve([
        {
          item: item({ kind: "sync_issue", status: "info" }),
          needsPerson: true,
        },
      ]),
    ).toEqual([]);
  });

  it("a coach check-in: never without the Coach, never without a plan due", () => {
    const plan = {
      id: "p1",
      status: "active" as const,
      reviewDate: null,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      updatedAt: new Date(NOW.getTime() - 10 * DAY),
      planText: "walk after lunch",
    };
    expect(
      buildDailyDigest(input({ coachPlans: [plan] }), t).asks.map(
        (a) => a.kind,
      ),
    ).toEqual(["coach_checkin"]);
    expect(
      buildDailyDigest(
        input({
          coachPlans: [plan],
          ai: {
            ...DIGEST_AI_AVAILABLE,
            coach: aiUnavailable("module_disabled"),
          },
        }),
        t,
      ).asks,
    ).toEqual([]);
    expect(
      buildDailyDigest(
        input({ coachPlans: [{ ...plan, createdAt: NOW, updatedAt: NOW }] }),
        t,
      ).asks,
    ).toEqual([]);
  });

  it("setup and relay: never without an open admin question", () => {
    // The loader passes one only for an admin, while it is undecided and
    // not set aside; without it nothing asks.
    expect(buildDailyDigest(input({ adminAsk: null }), t).asks).toEqual([]);
  });
});

describe("every ask exposes exactly two actions", () => {
  it("for every kind, admin questions included", () => {
    const asks = resolve(
      [dose(true), dose(false, "b"), checkups, checkin, visitAt(HOUR), broken],
      { adminAsk: buildAdminAsk("server_setup", t, "2026-07-16") },
    );
    const kinds = new Set<string>(asks.map((a) => a.kind));
    // The fixture reaches every kind the digest can ask about.
    for (const kind of [
      "dose_window",
      "preventive_care",
      "coach_checkin",
      "upcoming_visit",
      "sync_issue",
      "server_setup",
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    for (const ask of [...asks, buildAdminAsk("push_relay", t, "2026-07-16")]) {
      expect(ask.actions, ask.kind).toHaveLength(2);
    }
  });

  it("a later on a reminder names its day, so it lasts until tomorrow", () => {
    const [ask] = resolve([checkups]);
    expect(ask.actions[1].intent).toBe(
      `${ASK_INTENT.later}:ask-later:2026-07-16:preventive_care:x`,
    );
  });

  it("an item without its action asks nothing rather than a dead button", () => {
    expect(
      resolve([{ item: item({ kind: "preventive_care", actions: [] }) }]),
    ).toEqual([]);
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

  it("asks the overdue dose first, then the decision, then what is due", () => {
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
      ["preventive_care", "due"],
      ["upcoming_visit", "due"],
    ]);
    // The visit and the check-up open where they live, under one verb.
    expect(digest.asks[3].actions[0].labelKey).toBe("daily.action.open");
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

  it("follows the person's hidden item kinds, except for a dose past its time", () => {
    const digest = buildDailyDigest(
      input({
        medsToday: overdueMeds,
        preventiveDue: [{ label: "Dental check-up", longCycle: true }],
        enabledHeroItemKinds: PRIORITY_ITEM_KINDS.filter(
          (k) => k !== "dose_window" && k !== "preventive_care",
        ),
      }),
      t,
    );
    // The overdue dose is the safety tier and stays; the check-up goes.
    expect(digest.asks.map((a) => a.kind)).toEqual(["dose_window"]);
    // The rail still follows the switch for both.
    expect(digest.worthALook.map((i) => i.kind)).toEqual([]);
  });

  it("asks the admin question only when the loader passed one", () => {
    expect(buildDailyDigest(input({ adminAsk: null }), t).asks).toEqual([]);
    expect(
      buildDailyDigest(input({ adminAsk: "server_setup" }), t).asks[0].kind,
    ).toBe("server_setup");
  });
});

describe("an ask says the thing in its title and its state in the body", () => {
  /** The reader's clock: a fixed UTC rendering, enough to see it is used. */
  const localTime = (d: Date) => d.toISOString().slice(11, 16);
  const de = getServerTranslator("de").t;

  it("a dose: its name, then overdue with the time it was due", () => {
    const [ask] = buildDailyDigest(
      input({ medsToday: overdueMeds, localTime }),
      t,
    ).asks;
    expect([ask.title, ask.body]).toEqual(["Ramipril", "Overdue 06:00"]);
    const [deAsk] = buildDailyDigest(
      input({ medsToday: overdueMeds, localTime }),
      de,
    ).asks;
    expect([deAsk.title, deAsk.body]).toEqual(["Ramipril", "Überfällig 06:00"]);
  });

  it("a dose without the reader's clock says the state alone", () => {
    const [ask] = buildDailyDigest(input({ medsToday: overdueMeds }), t).asks;
    expect(ask.body).toBe("Overdue");
  });

  it("check-ups: the first by name, the rest counted", () => {
    const one = buildDailyDigest(
      input({ preventiveDue: [{ label: "Dental check-up", longCycle: true }] }),
      t,
    ).asks[0];
    expect([one.title, one.body]).toEqual(["Dental check-up", "Check-up due"]);
    const three = buildDailyDigest(
      input({
        preventiveDue: [
          { label: "Dental check-up", longCycle: true },
          { label: "Skin check", longCycle: true },
          { label: "Eye exam", longCycle: true },
        ],
      }),
      t,
    ).asks[0];
    expect(three.title).toBe("Dental check-up +2");
  });

  it("a visit: who it is with, then the day", () => {
    const visit = (dayOffset: number, hours: number) =>
      buildDailyDigest(
        input({
          upcomingVisits: [
            {
              id: "v1",
              kind: "ROUTINE",
              occurredAt: new Date(NOW.getTime() + hours * HOUR).toISOString(),
              practitionerName: "Family practice",
              dayOffset,
              timeLabel: "11:00",
            },
          ],
        }),
        t,
      ).asks[0];
    expect([visit(0, 2).title, visit(0, 2).body]).toEqual([
      "Family practice",
      "Visit today",
    ]);
    expect(visit(1, 20).body).toBe("Visit tomorrow");
  });

  it("a broken source: its name, then disconnected", () => {
    const [ask] = buildDailyDigest(
      input({
        syncIssues: [
          {
            integration: "google-health",
            state: "error_reauth",
            lastSuccessAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
          },
        ],
      }),
      t,
    ).asks;
    expect([ask.title, ask.body]).toEqual(["Google Health", "Disconnected"]);
  });

  it("a coach check-in: the plan itself, then the check-in", () => {
    const plan = {
      id: "p1",
      status: "active" as const,
      reviewDate: null,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      updatedAt: new Date(NOW.getTime() - 10 * DAY),
      planText: "After lunch → walk ten minutes",
    };
    const [ask] = buildDailyDigest(input({ coachPlans: [plan] }), t).asks;
    // The action alone: the "cue → action" arrow never reaches the title.
    expect([ask.title, ask.body]).toEqual(["Walk ten minutes", "Check-in due"]);
    const [unnamed] = buildDailyDigest(
      input({ coachPlans: [{ ...plan, planText: null }] }),
      t,
    ).asks;
    expect(unnamed.title).toBe("Your plan");
  });

  it("never repeats the title's thing as a sentence in the body", () => {
    const asks = buildDailyDigest(
      input({ medsToday: overdueMeds, localTime, adminAsk: "server_setup" }),
      t,
    ).asks;
    for (const ask of asks) {
      expect(ask.body).not.toMatch(/\.$/);
      expect(ask.body).not.toContain(ask.title);
    }
  });
});

describe("the browser test's asks are the builder's", () => {
  it("serverAsks equals buildDailyDigest for the same input, every language", () => {
    const pick = (asks: DailyAsk[]) =>
      asks.map((a) => [
        a.kind,
        a.tier,
        a.title,
        a.body,
        a.actions.map((x) => x.labelKey),
      ]);
    for (const locale of ["de", "en", "ru"] as const) {
      const input = asksFixtureInput(locale);
      const built = buildDailyDigest(input, getServerTranslator(locale).t).asks;
      expect(pick(serverAsks(locale))).toEqual(pick(built));
      expect(built).toHaveLength(7);
    }
  });
});

describe("a source that went quiet (source_stalled)", () => {
  /** A source the stall rule holds quiet, as the digest loader words it. */
  const quiet = (
    source: string,
    provider: string,
    days = 3,
  ): DailyDigestQuietSource => ({
    source,
    provider,
    sinceYesterday: days <= 1,
    date: "13 Jul",
    days,
    href: `/settings/integrations#${source}`,
  });
  const stalled = (over: Partial<DailyDigestInput> = {}) =>
    buildDailyDigest(
      input({ quietSources: [quiet("oura", "Oura")], ...over }),
      t,
    ).asks.filter((a) => a.kind === "source_stalled");

  it("asks about a source the stall rule holds quiet", () => {
    const [ask] = stalled();
    expect(ask).toMatchObject({
      kind: "source_stalled",
      tier: "due",
      itemKey: "source_stalled:oura",
      title: "Oura",
      body: "3 days quiet",
      learnMore: null,
    });
    expect(ask.actions).toEqual([
      {
        labelKey: "daily.action.open",
        intent: "sync.reconnect",
        href: "/settings/integrations#oura",
      },
      {
        labelKey: "daily.action.later",
        intent: `${ASK_INTENT.later}:ask-later:2026-07-16:source_stalled:oura`,
      },
    ]);
  });

  it("asks nothing without a quiet source: the rule decides, not the ask", () => {
    expect(stalled({ quietSources: [] })).toEqual([]);
    expect(stalled({ quietSources: undefined })).toEqual([]);
  });

  it("not for a source whose sign-in is asked for already", () => {
    const digest = buildDailyDigest(
      input({
        quietSources: [quiet("oura", "Oura")],
        syncIssues: [
          {
            integration: "oura",
            state: "error_reauth",
            lastSuccessAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
          },
        ],
      }),
      t,
    );
    expect(digest.asks.map((a) => [a.kind, a.itemKey])).toEqual([
      ["sync_issue", "sync_issue:oura"],
    ]);
  });

  it("not while it is set aside for the day", () => {
    expect(
      stalled({
        snoozedDoseItemKeys: new Set(["source_stalled:oura"]),
      }),
    ).toEqual([]);
  });

  it("not when the sync category is switched off", () => {
    expect(
      stalled({
        enabledHeroItemKinds: PRIORITY_ITEM_KINDS.filter(
          (k) => k !== "sync_issue",
        ),
      }),
    ).toEqual([]);
  });

  it("asks once per source, each under its own key", () => {
    const asks = sourceStalledAsks(
      {
        quietSources: [
          quiet("oura", "Oura"),
          quiet("oura", "Oura", 5),
          quiet("whoop", "WHOOP"),
        ],
        syncIssues: [],
        todayLocalDate: "2026-07-16",
        locale: "en",
      },
      t,
    );
    expect(asks.map((a) => a.itemKey)).toEqual([
      "source_stalled:oura",
      "source_stalled:whoop",
    ]);
  });

  it("comes after a reconnect of another source, in the due tier", () => {
    const digest = buildDailyDigest(
      input({
        quietSources: [quiet("oura", "Oura")],
        syncIssues: [
          {
            integration: "withings",
            state: "error_reauth",
            lastSuccessAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
          },
        ],
      }),
      t,
    );
    expect(digest.asks.map((a) => a.itemKey)).toEqual([
      "sync_issue:withings",
      "source_stalled:oura",
    ]);
  });

  it("counts the days in the reader's language", () => {
    const de = getServerTranslator("de").t;
    const ru = getServerTranslator("ru").t;
    const one = (locale: "de" | "ru" | "en", tr: typeof t, days: number) =>
      sourceStalledAsks(
        {
          quietSources: [quiet("oura", "Oura", days)],
          syncIssues: [],
          todayLocalDate: "2026-07-16",
          locale,
        },
        tr,
      )[0].body;
    expect(one("en", t, 1)).toBe("1 day quiet");
    expect(one("de", de, 2)).toBe("2 T. verstummt");
    expect(one("ru", ru, 2)).toBe("Молчит 2 дня");
    expect(one("ru", ru, 5)).toBe("Молчит 5 дней");
  });
});

describe("a forced hour cycle", () => {
  it("drops the time when it is longer than the language's own clock", () => {
    const de = getServerTranslator("de").t;
    expect(doseMeta(true, "8:00 AM", de, "08:00")).toBe("Überfällig");
    expect(doseMeta(true, "08:00", de, "08:00")).toBe("Überfällig 08:00");
    expect(doseMeta(true, "8:00 AM", t, "8:00 AM")).toBe("Overdue 8:00 AM");
  });
});
