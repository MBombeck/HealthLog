import { describe, it, expect } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyBriefing } from "@/lib/ai/schema";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import {
  buildDailyDigest,
  COACH_CHECKIN_RESURFACE_DAYS,
  DOSE_DUE_LOOKAHEAD_MS,
  MAX_WORTH_A_LOOK,
  type DailyDigestCoachPlan,
  type DailyDigestInput,
} from "@/lib/daily/digest";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
  COACH_CHECKIN_REVIEW_DAYS,
} from "@/lib/daily/coach-checkin-intents";
import type { Milestone } from "@/lib/daily/milestones";
import type { PriorityItem } from "@/lib/daily/priority-item";
import {
  ecgItemKey,
  milestoneItemKey,
  tensionWindowItemKey,
} from "@/lib/daily/priority-item-key";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");

function meds(over: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    nextDueMedicationId: null,
    ...over,
  };
}

const briefing: DailyBriefing = {
  paragraph:
    "Your blood pressure is holding steady this week. Sleep dipped slightly last night.",
  signalsOfDay: [
    {
      sourceMetric: "bp",
      tone: "good",
      headline: "Blood pressure is holding steady",
      nudge: "Keep the evening walks going.",
      delta: null,
    },
  ],
  keyFindings: [],
};

function input(over: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    now: NOW,
    modules: {},
    score: { value: 82, band: "good", delta: 3 },
    briefing,
    medsToday: meds(),
    sleepLastSeenDaysAgo: 0,
    morningRefreshedToday: false,
    syncIssues: [],
    preventiveDue: [],
    coachPlans: [],
    tensionWindow: null,
    todayLocalDate: "2026-07-16",
    dismissedItemKeys: new Set<string>(),
    ...over,
  };
}

const DAY = 86_400_000;

function plan(over: Partial<DailyDigestCoachPlan> = {}): DailyDigestCoachPlan {
  // Default: an active plan whose defaulted review (createdAt + 7d) is due.
  const createdAt = new Date(
    NOW.getTime() - (COACH_CHECKIN_REVIEW_DAYS + 1) * DAY,
  );
  return {
    id: "p1",
    status: "active",
    reviewDate: null,
    createdAt,
    updatedAt: createdAt,
    planText: "every morning → weigh in",
    ...over,
  };
}

describe("buildDailyDigest — composition", () => {
  it("lifts score, top signal, and briefing lead from cached inputs (no recompute)", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.generatedAt).toBe(NOW.toISOString());
    expect(d.score).toEqual({ value: 82, band: "good", delta: 3 });
    expect(d.topSignal?.headline).toBe("Blood pressure is holding steady");
    expect(d.briefingLead).toBe(
      "Your blood pressure is holding steady this week.",
    );
  });

  it("prefers the briefing lead for the push line", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.line).toBe("Your blood pressure is holding steady this week.");
  });

  it("falls back to the top-signal headline when there is no paragraph", () => {
    const d = buildDailyDigest(
      input({ briefing: { ...briefing, paragraph: "" } }),
      t,
    );
    expect(d.line).toBe("Blood pressure is holding steady");
  });

  it("falls back to a deterministic score floor when no briefing exists", () => {
    const d = buildDailyDigest(input({ briefing: null }), t);
    expect(d.topSignal).toBeNull();
    expect(d.briefingLead).toBeNull();
    expect(d.line).toBe("Your health score today is 82.");
  });

  it("degrades to the honest all-clear line with neither briefing nor score", () => {
    const d = buildDailyDigest(input({ briefing: null, score: null }), t);
    expect(d.line).toContain("Nothing needs your attention today");
    expect(d.score).toBeNull();
    expect(d.worthALook).toEqual([]);
  });

  it("is a synchronous pure function — repeated calls are identical", () => {
    const first = buildDailyDigest(input(), t);
    const second = buildDailyDigest(input(), t);
    expect(first).toEqual(second);
    // No provider/AI dependency: the composer never returns a promise.
    expect(first).not.toBeInstanceOf(Promise);
  });
});

describe("buildDailyDigest — freshness (provisional/final)", () => {
  it("is final when last night's sleep is in", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: 0 }), t);
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
  });

  it("is provisional when sleep is tracked but last night is not yet in", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: 2 }), t);
    expect(d.phase).toBe("provisional");
    expect(d.sleepPending).toBe(true);
  });

  it("is provisional when sleep has never been recorded", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: null }), t);
    expect(d.sleepPending).toBe(true);
  });

  it("is final (not pending) when the sleep module is off", () => {
    const d = buildDailyDigest(
      input({ modules: { sleep: false }, sleepLastSeenDaysAgo: null }),
      t,
    );
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
  });

  it("the morning-refresh marker finalises the day even while the snapshot's sleep last-seen is still stale (S4 fast path)", () => {
    // Sleep last-seen still lags at 1 day (snapshot cache not yet expired), but
    // the sleep-arrival refresh has stamped the marker for today — the digest
    // must read `final` immediately off the authoritative marker.
    const provisional = buildDailyDigest(
      input({ sleepLastSeenDaysAgo: 1, morningRefreshedToday: false }),
      t,
    );
    expect(provisional.phase).toBe("provisional");
    expect(provisional.sleepPending).toBe(true);

    const finalised = buildDailyDigest(
      input({ sleepLastSeenDaysAgo: 1, morningRefreshedToday: true }),
      t,
    );
    expect(finalised.phase).toBe("final");
    expect(finalised.sleepPending).toBe(false);
  });

  it("stays provisional when sleep never arrives (no marker, no reading)", () => {
    const d = buildDailyDigest(
      input({ sleepLastSeenDaysAgo: null, morningRefreshedToday: false }),
      t,
    );
    expect(d.phase).toBe("provisional");
    expect(d.sleepPending).toBe(true);
  });
});

describe("buildDailyDigest — worth-a-look rail item builders", () => {
  it("emits a dose-window item when a dose is overdue and medications is on", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
          nextDueMedicationId: "med-ramipril",
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((i) => i.kind === "dose_window");
    expect(dose).toBeDefined();
    expect(dose?.status).toBe("warning");
    expect(dose?.moduleKey).toBe("medications");
    expect(dose?.title).toBe("Medication overdue");
    expect(dose?.body).toBe("Ramipril is past due.");
    expect(dose?.actions).toHaveLength(1);
    expect(dose?.actions[0].intent).toBe("dose.log");
    // Deep-links straight to the overdue medication's card, not the bare
    // list — the tap should land on the right med.
    expect(dose?.actions[0].href).toBe("/medications?highlight=med-ramipril");
  });

  it("falls back to the bare medications list when no id is known (older cached block)", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
          nextDueMedicationId: null,
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((i) => i.kind === "dose_window");
    expect(dose?.actions[0].href).toBe("/medications");
  });

  it("emits one medication-specific card and link per actionable candidate", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          activeCount: 2,
          dueCandidates: [
            {
              medicationId: "med-ramipril",
              medicationName: "Ramipril",
              dueAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
              overdue: true,
              availableFrom: new Date(
                NOW.getTime() - 2 * 60 * 60_000,
              ).toISOString(),
            },
            {
              medicationId: "med-mounjaro",
              medicationName: "Mounjaro",
              dueAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
              overdue: false,
              availableFrom: new Date(
                NOW.getTime() - 24 * 60 * 60_000,
              ).toISOString(),
            },
          ],
        }),
      }),
      t,
    );

    const doses = d.worthALook.filter((item) => item.kind === "dose_window");
    expect(doses).toHaveLength(2);
    expect(doses.map((item) => item.status)).toEqual(["warning", "info"]);
    expect(doses.map((item) => item.body)).toEqual([
      t("daily.item.doseWindow.overdueBodyNamed", { name: "Ramipril" }),
      t("daily.item.doseWindow.bodyNamed", { name: "Mounjaro" }),
    ]);
    expect(doses.map((item) => item.actions[0]?.href)).toEqual([
      "/medications?highlight=med-ramipril",
      "/medications?highlight=med-mounjaro",
    ]);
  });

  it("does NOT emit a dose-window item when the medications module is off", () => {
    const d = buildDailyDigest(
      input({
        modules: { medications: false },
        medsToday: meds({
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("does NOT emit a dose-window item when nothing is due at all", () => {
    const d = buildDailyDigest(
      input({ medsToday: meds({ nextDueOverdue: false }) }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("emits a calm due item for a takeable dose that is not yet overdue", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          activeCount: 1,
          scheduledToday: 1,
          nextDueAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
          nextDueOverdue: false,
          nextDueMedicationName: "Ramipril",
          nextDueMedicationId: "med-1",
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((i) => i.kind === "dose_window");
    expect(dose).toBeDefined();
    // Reads as informational, NOT as the overdue warning.
    expect(dose?.status).toBe("info");
    expect(dose?.title).toBe(t("daily.item.doseWindow.title"));
    expect(dose?.body).toBe(
      t("daily.item.doseWindow.bodyNamed", { name: "Ramipril" }),
    );
    expect(dose?.actions[0]?.href).toBe("/medications?highlight=med-1");
  });

  it("reads an overdue dose differently from a merely due one", () => {
    const due = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
          nextDueOverdue: false,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    ).worthALook.find((i) => i.kind === "dose_window");
    const overdue = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    ).worthALook.find((i) => i.kind === "dose_window");

    expect(overdue?.status).toBe("warning");
    expect(overdue?.title).toBe(t("daily.item.doseWindow.overdueTitle"));
    expect(overdue?.body).toBe(
      t("daily.item.doseWindow.overdueBodyNamed", { name: "Ramipril" }),
    );
    // The two faces must not collapse into the same copy.
    expect(overdue?.title).not.toBe(due?.title);
    expect(overdue?.body).not.toBe(due?.body);
    expect(overdue?.status).not.toBe(due?.status);
  });

  it("does NOT manufacture a dose item on a day whose doses are all taken", () => {
    // Every scheduled dose resolved; the next display-due slot is tomorrow.
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          activeCount: 2,
          scheduledToday: 2,
          takenToday: 2,
          nextDueAt: new Date(NOW.getTime() + 22 * 60 * 60_000).toISOString(),
          nextDueOverdue: false,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("shows a weekly future slot once its engine-derived availability window opens", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          dueCandidates: [
            {
              medicationId: "med-weekly",
              medicationName: "Weekly dose",
              dueAt: new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
              overdue: false,
              availableFrom: new Date(NOW.getTime() - 60_000).toISOString(),
            },
          ],
        }),
      }),
      t,
    );

    expect(
      d.worthALook.filter((item) => item.kind === "dose_window"),
    ).toHaveLength(1);
  });

  it("respects an explicit weekly availability boundary exactly", () => {
    const candidate = {
      medicationId: "med-weekly",
      medicationName: "Weekly dose",
      dueAt: new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
      overdue: false,
      availableFrom: NOW.toISOString(),
    };

    const atBoundary = buildDailyDigest(
      input({ medsToday: meds({ dueCandidates: [candidate] }) }),
      t,
    );
    const beforeBoundary = buildDailyDigest(
      input({
        now: new Date(NOW.getTime() - 1),
        medsToday: meds({ dueCandidates: [candidate] }),
      }),
      t,
    );

    expect(
      atBoundary.worthALook.some((item) => item.kind === "dose_window"),
    ).toBe(true);
    expect(
      beforeBoundary.worthALook.some((item) => item.kind === "dose_window"),
    ).toBe(false);
  });

  it("keeps a dose beyond the takeable lead off the rail", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueAt: new Date(
            NOW.getTime() + DOSE_DUE_LOOKAHEAD_MS + 60_000,
          ).toISOString(),
          nextDueOverdue: false,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("keeps a stale cached non-overdue scalar calm instead of dropping or escalating it", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          nextDueOverdue: false,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((item) => item.kind === "dose_window");
    expect(dose?.status).toBe("info");
    expect(dose?.body).toBe(
      t("daily.item.doseWindow.bodyNamed", { name: "Ramipril" }),
    );
  });

  it("maps one sync-issue item per broken integration", () => {
    const d = buildDailyDigest(
      input({
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
        ],
      }),
      t,
    );
    const sync = d.worthALook.filter((i) => i.kind === "sync_issue");
    expect(sync).toHaveLength(2);
    expect(sync[0].status).toBe("warning");
    expect(sync[0].body).toContain("Withings");
    expect(sync[0].actions[0].href).toBe("/settings/integrations");
  });

  it("summarises a single preventive-care item with the label", () => {
    const d = buildDailyDigest(
      input({ preventiveDue: [{ label: "Blood panel" }] }),
      t,
    );
    const care = d.worthALook.find((i) => i.kind === "preventive_care");
    expect(care?.status).toBe("info");
    expect(care?.body).toBe("Blood panel is due.");
  });

  it("summarises many preventive-care items into one counted item", () => {
    const d = buildDailyDigest(
      input({
        preventiveDue: [{ label: "A" }, { label: "B" }, { label: "C" }],
      }),
      t,
    );
    const care = d.worthALook.filter((i) => i.kind === "preventive_care");
    expect(care).toHaveLength(1);
    expect(care[0].body).toBe("3 check-ups are due.");
  });

  it("bounds the rail at three items, never padded", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
          { integration: "fitbit", state: "error_reauth" },
        ],
        preventiveDue: [{ label: "Blood panel" }],
      }),
      t,
    );
    expect(d.worthALook.length).toBeLessThanOrEqual(MAX_WORTH_A_LOOK);
    expect(d.worthALook.length).toBe(3);
  });

  it("returns an empty rail when nothing needs attention", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.worthALook).toEqual([]);
  });
});

describe("buildDailyDigest — coach check-in (S3)", () => {
  function checkin(d: ReturnType<typeof buildDailyDigest>) {
    return d.worthALook.find((i) => i.kind === "coach_checkin");
  }

  it("emits a check-in when an active plan's defaulted review has come due", () => {
    const d = buildDailyDigest(input({ coachPlans: [plan()] }), t);
    const item = checkin(d);
    expect(item).toBeDefined();
    expect(item?.status).toBe("info");
    expect(item?.moduleKey).toBe("coach");
    expect(item?.actions).toHaveLength(3);
    // The plan's own words are echoed in the body.
    expect(item?.body).toContain("every morning → weigh in");
    // Keep / let-go carry the plan id; adjust is a plain navigation href.
    expect(item?.actions[0].intent).toBe(`${COACH_CHECKIN_KEEP_INTENT}:p1`);
    // 2026-07-17 UX-flows audit F1-2 — adjust used to be a bare `/coach` link
    // dropping all plan context; it now carries `?ask=` seeding the coach
    // composer with the plan's own words, so the target is the coach route
    // with the plan text echoed in the query, not a blank chat.
    expect(item?.actions[1].href).toContain("/coach?ask=");
    expect(item?.actions[1].href).toContain(
      encodeURIComponent("every morning → weigh in"),
    );
    expect(item?.actions[2].intent).toBe(`${COACH_CHECKIN_LETGO_INTENT}:p1`);
  });

  it("emits a review-due check-in from a plan's pinned reviewDate", () => {
    const reviewDate = new Date(NOW.getTime() - DAY);
    const d = buildDailyDigest(
      input({ coachPlans: [plan({ reviewDate })] }),
      t,
    );
    expect(checkin(d)).toBeDefined();
  });

  it("emits a check-in for a reviewed plan (post-sweep read-back state)", () => {
    const d = buildDailyDigest(
      input({
        coachPlans: [
          plan({
            status: "reviewed",
            reviewDate: null,
            updatedAt: new Date(NOW.getTime() - DAY),
          }),
        ],
      }),
      t,
    );
    expect(checkin(d)).toBeDefined();
  });

  it("falls back to a generic body when the plan text is undecryptable", () => {
    const d = buildDailyDigest(
      input({ coachPlans: [plan({ planText: null })] }),
      t,
    );
    expect(checkin(d)?.body).toBe(
      "It's been about a week since you set this plan — keep it, adjust it, or let it go. No pressure either way.",
    );
  });

  it("does NOT emit a check-in before the review is due", () => {
    const d = buildDailyDigest(
      input({
        coachPlans: [plan({ reviewDate: new Date(NOW.getTime() + DAY) })],
      }),
      t,
    );
    expect(checkin(d)).toBeUndefined();
  });

  it("does NOT emit a check-in when the coach module is off", () => {
    const d = buildDailyDigest(
      input({ modules: { coach: false }, coachPlans: [plan()] }),
      t,
    );
    expect(checkin(d)).toBeUndefined();
  });

  it("emits none when there are no standing plans", () => {
    const d = buildDailyDigest(input({ coachPlans: [] }), t);
    expect(checkin(d)).toBeUndefined();
  });

  it("stops resurfacing after the resurface window (quiet retirement)", () => {
    const stale = new Date(
      NOW.getTime() - (COACH_CHECKIN_RESURFACE_DAYS + 2) * DAY,
    );
    const d = buildDailyDigest(
      input({ coachPlans: [plan({ reviewDate: stale })] }),
      t,
    );
    expect(checkin(d)).toBeUndefined();
  });

  it("caps at ONE check-in per day, surfacing the earliest-due plan", () => {
    const older = new Date(NOW.getTime() - 5 * DAY);
    const newer = new Date(NOW.getTime() - 1 * DAY);
    const d = buildDailyDigest(
      input({
        coachPlans: [
          plan({ id: "recent", reviewDate: newer }),
          plan({ id: "oldest", reviewDate: older }),
        ],
      }),
      t,
    );
    const items = d.worthALook.filter((i) => i.kind === "coach_checkin");
    expect(items).toHaveLength(1);
    expect(items[0].actions[0].intent).toBe(
      `${COACH_CHECKIN_KEEP_INTENT}:oldest`,
    );
  });

  it("does not displace an overdue dose from the bounded rail", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
        ],
        coachPlans: [plan()],
      }),
      t,
    );
    // dose + 2 sync fill the cap; the check-in waits for a following day.
    expect(d.worthALook).toHaveLength(MAX_WORTH_A_LOOK);
    expect(checkin(d)).toBeUndefined();
    expect(d.worthALook[0].kind).toBe("dose_window");
  });
});

const milestone = (
  d: ReturnType<typeof buildDailyDigest>,
): PriorityItem | undefined => d.worthALook.find((i) => i.kind === "milestone");

const RECORD_MILESTONE: Milestone = {
  kind: "record_first",
  metricType: "RESTING_HEART_RATE",
  sinceDate: "2026-07-16",
  copyKey: "daily.milestone.record",
};

describe("S12 — the milestone reward card", () => {
  it("emits ONE calm success card when a milestone was freshly reached", () => {
    const d = buildDailyDigest(input({ milestone: RECORD_MILESTONE }), t);
    const item = milestone(d);
    expect(item).toBeDefined();
    expect(item?.status).toBe("success");
    expect(item?.title.length).toBeGreaterThan(0);
    expect(item?.body?.length).toBeGreaterThan(0);
    // Single calm action deep-linking into the metric's insight.
    expect(item?.actions).toHaveLength(1);
    expect(item?.actions[0].intent).toBe("milestone.view");
    expect(item?.actions[0].href).toBe("/insights/resting-pulse");
    // One per day — never two milestone cards.
    expect(d.worthALook.filter((i) => i.kind === "milestone")).toHaveLength(1);
  });

  it("shows nothing when no milestone was reached today (data-gated)", () => {
    expect(
      milestone(buildDailyDigest(input({ milestone: null }), t)),
    ).toBeUndefined();
    expect(milestone(buildDailyDigest(input(), t))).toBeUndefined();
  });

  it("is suppressed when the insights module is off (module-gated)", () => {
    const d = buildDailyDigest(
      input({ milestone: RECORD_MILESTONE, modules: { insights: false } }),
      t,
    );
    expect(milestone(d)).toBeUndefined();
  });

  it("sits just below an overdue dose and above ambient items", () => {
    const d = buildDailyDigest(
      input({
        milestone: RECORD_MILESTONE,
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [{ integration: "withings", state: "error_reauth" }],
      }),
      t,
    );
    expect(d.worthALook[0].kind).toBe("dose_window");
    expect(d.worthALook[1].kind).toBe("milestone");
    expect(d.worthALook[2].kind).toBe("sync_issue");
  });

  it("carries no streak / loss vocabulary in its copy", () => {
    const item = milestone(
      buildDailyDigest(input({ milestone: RECORD_MILESTONE }), t),
    );
    const forbidden = /streak|flame|broke|broken|lost|missed|fail/i;
    expect(item?.title).not.toMatch(forbidden);
    expect(item?.body ?? "").not.toMatch(forbidden);
  });

  it("stamps a deterministic dismiss key namespaced by kind", () => {
    const item = milestone(
      buildDailyDigest(input({ milestone: RECORD_MILESTONE }), t),
    );
    expect(item?.itemKey).toBe(milestoneItemKey(RECORD_MILESTONE));
    expect(item?.itemKey).toMatch(/^milestone:/);
  });

  it("is dropped from the rail once its dismiss key is in the dismissed set", () => {
    const d = buildDailyDigest(
      input({
        milestone: RECORD_MILESTONE,
        dismissedItemKeys: new Set([milestoneItemKey(RECORD_MILESTONE)]),
      }),
      t,
    );
    expect(milestone(d)).toBeUndefined();
  });
});

describe("buildDailyDigest — S11 tension_window item", () => {
  function tension(d: ReturnType<typeof buildDailyDigest>) {
    return d.worthALook.find((i) => i.kind === "tension_window");
  }

  it("emits a calm, non-diagnostic tension card when a window is present", () => {
    const d = buildDailyDigest(
      input({ tensionWindow: { partOfDay: "afternoon" } }),
      t,
    );
    const item = tension(d);
    expect(item).toBeDefined();
    expect(item?.status).toBe("info");
    expect(item?.actions[0].intent).toBe("pulse.view");
    expect(item?.actions[0].href).toBe("/insights/pulse");
    expect(item?.body).toContain("afternoon");
  });

  it("emits nothing when there is no window (honest-absent)", () => {
    const d = buildDailyDigest(input({ tensionWindow: null }), t);
    expect(tension(d)).toBeUndefined();
  });

  it("stays silent when the insights module is off", () => {
    const d = buildDailyDigest(
      input({
        modules: { insights: false },
        tensionWindow: { partOfDay: "morning" },
      }),
      t,
    );
    expect(tension(d)).toBeUndefined();
  });

  it("yields the bounded rail to time-sensitive actions first", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
        ],
        tensionWindow: { partOfDay: "evening" },
      }),
      t,
    );
    // dose + 2 sync fill the cap; the calm tension marker waits.
    expect(d.worthALook).toHaveLength(MAX_WORTH_A_LOOK);
    expect(tension(d)).toBeUndefined();
  });

  it("stamps a dismiss key namespaced by kind, folding in the local day + part of day", () => {
    const d = buildDailyDigest(
      input({
        tensionWindow: { partOfDay: "afternoon" },
        todayLocalDate: "2026-07-16",
      }),
      t,
    );
    const item = tension(d);
    expect(item?.itemKey).toBe(tensionWindowItemKey("2026-07-16", "afternoon"));
    expect(item?.itemKey).toMatch(/^tension_window:/);
  });

  it("is dropped from the rail once its dismiss key is in the dismissed set", () => {
    const d = buildDailyDigest(
      input({
        tensionWindow: { partOfDay: "afternoon" },
        todayLocalDate: "2026-07-16",
        dismissedItemKeys: new Set([
          tensionWindowItemKey("2026-07-16", "afternoon"),
        ]),
      }),
      t,
    );
    expect(tension(d)).toBeUndefined();
  });
});

describe("buildDailyDigest — ecg_new_recording (S10)", () => {
  const ecgItem = (d: ReturnType<typeof buildDailyDigest>) =>
    d.worthALook.find((i) => i.kind === "ecg_new_recording");

  it("emits ONE calm item for a recording within the last day", () => {
    const d = buildDailyDigest(
      input({
        latestEcg: {
          recordedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
          deviceVerdict: "NOT_DETECTED",
        },
      }),
      t,
    );
    const item = ecgItem(d);
    expect(item).toBeDefined();
    expect(item?.status).toBe("info");
    expect(item?.moduleKey).toBe("insights");
    // Single action, deep-linking the ECG viewer.
    expect(item?.actions).toHaveLength(1);
    expect(item?.actions[0].intent).toBe("ecg.view");
    expect(item?.actions[0].href).toBe("/insights#ecg");
  });

  it("attributes the verdict to the DEVICE (never a HealthLog reading)", () => {
    const d = buildDailyDigest(
      input({
        latestEcg: {
          recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
          deviceVerdict: "IRREGULAR",
        },
      }),
      t,
    );
    const item = ecgItem(d);
    // Copy leads with the device as the actor, echoes only its verdict, and
    // never claims HealthLog interpreted the trace.
    expect(item?.body).toContain("Your device recorded");
    expect(item?.body).toContain("possible irregular rhythm");
    expect(item?.body).not.toMatch(/we (detected|found|think)|HealthLog/i);
  });

  it("does not emit for an OLD recording (outside the last-day window)", () => {
    const d = buildDailyDigest(
      input({
        latestEcg: {
          recordedAt: new Date(NOW.getTime() - 2 * DAY),
          deviceVerdict: "IRREGULAR",
        },
      }),
      t,
    );
    expect(ecgItem(d)).toBeUndefined();
  });

  it("does not emit a future-dated recording (clock-skew guard)", () => {
    const d = buildDailyDigest(
      input({
        latestEcg: {
          recordedAt: new Date(NOW.getTime() + 60 * 60 * 1000),
          deviceVerdict: "NOT_DETECTED",
        },
      }),
      t,
    );
    expect(ecgItem(d)).toBeUndefined();
  });

  it("does not emit when the insights module is off", () => {
    const d = buildDailyDigest(
      input({
        modules: { insights: false },
        latestEcg: {
          recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
          deviceVerdict: "IRREGULAR",
        },
      }),
      t,
    );
    expect(ecgItem(d)).toBeUndefined();
  });

  it("emits nothing when there is no recent recording", () => {
    const d = buildDailyDigest(input({ latestEcg: null }), t);
    expect(ecgItem(d)).toBeUndefined();
  });

  it("uses the calm, verdict-less body when the device gave no verdict", () => {
    const d = buildDailyDigest(
      input({
        latestEcg: {
          recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
          deviceVerdict: null,
        },
      }),
      t,
    );
    const item = ecgItem(d);
    expect(item?.body).toBe(
      "Your device recorded a new ECG — it's ready to view.",
    );
  });

  it("carries no waveform / sample data on the item or its input DTO", () => {
    const latestEcg = {
      recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      deviceVerdict: "NOT_DETECTED" as const,
    };
    // The input DTO is verdict + recordedAt only — no waveform channel exists.
    expect(Object.keys(latestEcg).sort()).toEqual([
      "deviceVerdict",
      "recordedAt",
    ]);
    const d = buildDailyDigest(input({ latestEcg }), t);
    const serialised = JSON.stringify(ecgItem(d));
    expect(serialised).not.toMatch(/waveform|sample|signal|voltage|microvolt/i);
  });

  it("stamps a dismiss key namespaced by kind, folding in the recording's own timestamp", () => {
    const recordedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const d = buildDailyDigest(
      input({ latestEcg: { recordedAt, deviceVerdict: "IRREGULAR" } }),
      t,
    );
    const item = ecgItem(d);
    expect(item?.itemKey).toBe(ecgItemKey(recordedAt));
    expect(item?.itemKey).toMatch(/^ecg_new_recording:/);
  });

  it("is dropped from the rail once its dismiss key is in the dismissed set", () => {
    const recordedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const d = buildDailyDigest(
      input({
        latestEcg: { recordedAt, deviceVerdict: "IRREGULAR" },
        dismissedItemKeys: new Set([ecgItemKey(recordedAt)]),
      }),
      t,
    );
    expect(ecgItem(d)).toBeUndefined();
  });
});

describe("buildDailyDigest — dismiss filtering never touches actionable kinds", () => {
  it("ignores a dismissed key that happens to collide with an actionable item's shape (they never carry one)", () => {
    // Actionable items never stamp an `itemKey`, so filtering can never match
    // them regardless of what the dismissed set contains — a dose-window item
    // stays on the rail even with an arbitrary set of dismissed keys.
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        dismissedItemKeys: new Set(["dose_window:anything", "sync_issue:x"]),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(true);
    expect(
      d.worthALook.find((i) => i.kind === "dose_window")?.itemKey,
    ).toBeUndefined();
  });
});
