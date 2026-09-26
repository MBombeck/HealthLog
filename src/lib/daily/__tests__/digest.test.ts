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
  type DailyDigestSameTime,
} from "@/lib/daily/digest";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
  COACH_CHECKIN_REVIEW_DAYS,
} from "@/lib/daily/coach-checkin-intents";
import type { Milestone } from "@/lib/daily/milestones";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
} from "@/lib/daily/priority-item";
import {
  ecgItemKey,
  milestoneItemKey,
  sameTimeBaselineItemKey,
  tensionWindowItemKey,
} from "@/lib/daily/priority-item-key";
import {
  aiUnavailable,
  DIGEST_AI_AVAILABLE,
} from "@/__tests__/helpers/ai-capability-fixtures";

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
    ai: DIGEST_AI_AVAILABLE,
    // NOW is 09:00Z on 2026-07-16; UTC profile day ends at next midnight.
    todayEndExclusive: new Date("2026-07-17T00:00:00.000Z"),
    modules: {},
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
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

  it("is final (not pending) when sleep has never been recorded", () => {
    // Someone with no tracker never has a night in the record. Waiting for one
    // means the card would tell them every single morning that last night's
    // sleep "is not in yet", about a delay that never ends.
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: null }), t);
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
  });

  it("keeps waiting through an ordinary gap, stops once the source has gone quiet", () => {
    // A flat battery or a few nights without the tracker is not a reason to
    // stop expecting tonight's sleep.
    const shortGap = buildDailyDigest(input({ sleepLastSeenDaysAgo: 7 }), t);
    expect(shortGap.phase).toBe("provisional");
    expect(shortGap.sleepPending).toBe(true);

    // A full week with nothing arriving is. Someone who has put the tracker
    // away should not keep reading about last night's missing sleep.
    const abandoned = buildDailyDigest(input({ sleepLastSeenDaysAgo: 8 }), t);
    expect(abandoned.phase).toBe("final");
    expect(abandoned.sleepPending).toBe(false);
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

  it("settles the day even when sleep never arrives (no marker, no reading)", () => {
    // Without this the day parks on `provisional` forever for every record
    // that has no sleep source, which also leaks into the push line.
    const d = buildDailyDigest(
      input({ sleepLastSeenDaysAgo: null, morningRefreshedToday: false }),
      t,
    );
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
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

  it("shows a weekly slot due later TODAY once its engine-derived availability window opens", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          dueCandidates: [
            {
              medicationId: "med-weekly",
              medicationName: "Weekly dose",
              // Later today (15:00Z, same local day as NOW).
              dueAt: new Date(NOW.getTime() + 6 * 60 * 60_000).toISOString(),
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
      // Later today (19:00Z) so only the availability boundary decides.
      dueAt: new Date(NOW.getTime() + 10 * 60 * 60_000).toISOString(),
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

  it("keeps a weekly slot due TOMORROW off the rail even when its availability window is open", () => {
    // Regression: a weekly/rolling medication with the default window opens
    // its availability ~25 h ahead of the anchor (1 day early-days + 60 min
    // grace). On Friday the Saturday slot therefore became "available" and
    // surfaced as today's pending business. A not-yet-overdue dose that is
    // due on a LATER local day is a scheduled event, not today's card.
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          dueCandidates: [
            {
              medicationId: "med-weekly",
              medicationName: "Weekly dose",
              // Tomorrow 08:00 — outside today's local day.
              dueAt: "2026-07-17T08:00:00.000Z",
              overdue: false,
              // Window already open (now minus 1 h).
              availableFrom: new Date(
                NOW.getTime() - 60 * 60_000,
              ).toISOString(),
            },
          ],
        }),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("bounds the rail on the PROFILE-tz day end, exclusive at the boundary instant", () => {
    // A Berlin (CEST, UTC+2) profile day ends at 22:00:00Z — the seam passes
    // that instant as `todayEndExclusive`, so the builder needs no tz math.
    const berlinDayEnd = new Date("2026-07-16T22:00:00.000Z");
    const candidateDue = (dueAtIso: string) =>
      meds({
        dueCandidates: [
          {
            medicationId: "med-weekly",
            medicationName: "Weekly dose",
            dueAt: dueAtIso,
            overdue: false,
            availableFrom: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
          },
        ],
      });

    // 23:30 Berlin local — still today, stays on the rail.
    const lateToday = buildDailyDigest(
      input({
        todayEndExclusive: berlinDayEnd,
        medsToday: candidateDue("2026-07-16T21:30:00.000Z"),
      }),
      t,
    );
    // 00:30 Berlin local TOMORROW (22:30Z) — off the rail.
    const earlyTomorrow = buildDailyDigest(
      input({
        todayEndExclusive: berlinDayEnd,
        medsToday: candidateDue("2026-07-16T22:30:00.000Z"),
      }),
      t,
    );
    // Exactly local midnight — the bound is exclusive, so this is tomorrow.
    const atBoundary = buildDailyDigest(
      input({
        todayEndExclusive: berlinDayEnd,
        medsToday: candidateDue(berlinDayEnd.toISOString()),
      }),
      t,
    );

    expect(lateToday.worthALook.some((i) => i.kind === "dose_window")).toBe(
      true,
    );
    expect(earlyTomorrow.worthALook.some((i) => i.kind === "dose_window")).toBe(
      false,
    );
    expect(atBoundary.worthALook.some((i) => i.kind === "dose_window")).toBe(
      false,
    );
  });

  it("always keeps an OVERDUE candidate on the rail regardless of the day bound", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          dueCandidates: [
            {
              medicationId: "med-weekly",
              medicationName: "Weekly dose",
              // Yesterday — engine says overdue; the day bound never applies.
              dueAt: "2026-07-15T08:00:00.000Z",
              overdue: true,
              availableFrom: "2026-07-14T07:00:00.000Z",
            },
          ],
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((i) => i.kind === "dose_window");
    expect(dose).toBeDefined();
    expect(dose?.status).toBe("warning");
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
          { integration: "nightscout", state: "parked" },
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
    expect(care[0].body).toBe("Due: A, B, C");
  });

  it("names the first three due check-ups and counts the rest", () => {
    const d = buildDailyDigest(
      input({
        preventiveDue: ["A", "B", "C", "D", "E"].map((label) => ({ label })),
      }),
      t,
    );
    const care = d.worthALook.find((i) => i.kind === "preventive_care");
    expect(care?.body).toBe("Due: A, B, C +2");
  });

  it("bounds the rail at three items, never padded", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "nightscout", state: "parked" },
          { integration: "fitbit", state: "error_reauth" },
        ],
        preventiveDue: [{ label: "Blood panel" }],
      }),
      t,
    );
    expect(d.worthALook.length).toBeLessThanOrEqual(MAX_WORTH_A_LOOK);
    expect(d.worthALook.length).toBe(3);
  });

  it("filters disabled kinds before the rail cap", () => {
    const d = buildDailyDigest(
      input({
        enabledHeroItemKinds: ["preventive_care"],
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "nightscout", state: "parked" },
          { integration: "fitbit", state: "error_reauth" },
        ],
        preventiveDue: [{ label: "Blood panel" }],
      }),
      t,
    );

    expect(d.worthALook.map((item) => item.kind)).toEqual(["preventive_care"]);
  });

  it("uses the existing all-clear treatment when every kind is off", () => {
    const d = buildDailyDigest(
      input({
        enabledHeroItemKinds: [],
        briefing: null,
        score: null,
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [{ integration: "withings", state: "error_reauth" }],
      }),
      t,
    );

    expect(d.worthALook).toEqual([]);
    expect(d.line).toContain("Nothing needs your attention today");
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

  it.each([
    "operator_disabled",
    "module_disabled",
    "user_disabled",
    "no_provider",
    "consent_required",
  ] as const)(
    "does NOT emit a check-in while the coach capability is %s",
    (reason) => {
      const d = buildDailyDigest(
        input({
          ai: { ...DIGEST_AI_AVAILABLE, coach: aiUnavailable(reason) },
          coachPlans: [plan()],
        }),
        t,
      );
      expect(checkin(d)).toBeUndefined();
    },
  );

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
          { integration: "nightscout", state: "parked" },
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

  it("is data: the AI analysis opt-out (insights module off) does not hide it", () => {
    const d = buildDailyDigest(
      input({ milestone: RECORD_MILESTONE, modules: { insights: false } }),
      t,
    );
    expect(milestone(d)).toBeDefined();
    expect(milestone(d)?.moduleKey).toBeUndefined();
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

  it("is data: the AI analysis opt-out (insights module off) does not hide it", () => {
    const d = buildDailyDigest(
      input({
        modules: { insights: false },
        tensionWindow: { partOfDay: "morning" },
      }),
      t,
    );
    expect(tension(d)).toBeDefined();
  });

  it("yields the bounded rail to time-sensitive actions first", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "nightscout", state: "parked" },
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

describe("buildDailyDigest — same_time_baseline item", () => {
  const sameTimeItem = (d: ReturnType<typeof buildDailyDigest>) =>
    d.worthALook.find((i) => i.kind === "same_time_baseline");

  function sameTime(
    over: Partial<DailyDigestSameTime> = {},
  ): DailyDigestSameTime {
    return {
      type: "ACTIVITY_STEPS",
      band: "below",
      asOfHour: 20,
      todayValue: 1834,
      typicalValue: 5111,
      todayLabel: "1,834",
      typicalLabel: "5,111",
      ...over,
    };
  }

  it("names both totals and the hour they are compared at", () => {
    const d = buildDailyDigest(input({ sameTime: sameTime() }), t);
    const item = sameTimeItem(d);
    expect(item).toBeDefined();
    expect(item?.status).toBe("info");
    // The comparison covers everything through the END of hour 20, which
    // reads on the clock as 21:00.
    expect(item?.body).toContain("21:00");
    expect(item?.body).toContain("1,834");
    expect(item?.body).toContain("5,111");
    expect(item?.actions[0].intent).toBe("steps.view");
    expect(item?.actions[0].href).toBe("/insights/steps");
  });

  it("says nothing about a day that is tracking its own normal", () => {
    // A rail that reports "exactly as usual" every afternoon teaches people to
    // stop reading the rail.
    const d = buildDailyDigest(
      input({ sameTime: sameTime({ band: "within" }) }),
      t,
    );
    expect(sameTimeItem(d)).toBeUndefined();
  });

  it("says nothing when the engine returned no comparison", () => {
    expect(
      sameTimeItem(buildDailyDigest(input({ sameTime: null }), t)),
    ).toBeUndefined();
    expect(sameTimeItem(buildDailyDigest(input({}), t))).toBeUndefined();
  });

  it("is data: the AI analysis opt-out (insights module off) does not hide it", () => {
    const d = buildDailyDigest(
      input({ modules: { insights: false }, sameTime: sameTime() }),
      t,
    );
    expect(sameTimeItem(d)).toBeDefined();
  });

  it("uses a different sentence when today is ahead", () => {
    const below = buildDailyDigest(input({ sameTime: sameTime() }), t);
    const above = buildDailyDigest(
      input({ sameTime: sameTime({ band: "above" }) }),
      t,
    );
    expect(sameTimeItem(above)?.title).not.toBe(sameTimeItem(below)?.title);
    expect(sameTimeItem(above)?.body).not.toBe(sameTimeItem(below)?.body);
  });

  it("keys the dismissal by day and metric, never by the hour", () => {
    // Folding the hour in would undo the dismissal every sixty minutes.
    const d = buildDailyDigest(
      input({ sameTime: sameTime(), todayLocalDate: "2026-07-16" }),
      t,
    );
    expect(sameTimeItem(d)?.itemKey).toBe(
      sameTimeBaselineItemKey("2026-07-16", "ACTIVITY_STEPS"),
    );
    // The same key whatever the clock says — that is the whole point.
    const later = buildDailyDigest(
      input({
        sameTime: sameTime({ asOfHour: 9 }),
        todayLocalDate: "2026-07-16",
      }),
      t,
    );
    expect(sameTimeItem(later)?.itemKey).toBe(sameTimeItem(d)?.itemKey);
  });

  it("is dropped once dismissed, and stays dropped as the hour moves on", () => {
    const dismissed = new Set([
      sameTimeBaselineItemKey("2026-07-16", "ACTIVITY_STEPS"),
    ]);
    for (const asOfHour of [9, 14, 20]) {
      const d = buildDailyDigest(
        input({
          sameTime: sameTime({ asOfHour }),
          todayLocalDate: "2026-07-16",
          dismissedItemKeys: dismissed,
        }),
        t,
      );
      expect(sameTimeItem(d)).toBeUndefined();
    }
  });

  it("yields the bounded rail to time-sensitive actions first", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "nightscout", state: "parked" },
        ],
        sameTime: sameTime(),
      }),
      t,
    );
    expect(d.worthALook).toHaveLength(MAX_WORTH_A_LOOK);
    expect(sameTimeItem(d)).toBeUndefined();
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
    // Device data: no module owns it.
    expect(item?.moduleKey).toBeUndefined();
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

  it("is device data: the AI analysis opt-out (insights module off) does not hide it", () => {
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
    expect(ecgItem(d)).toBeDefined();
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

describe("buildDailyDigest — AI text follows its capability", () => {
  it.each([
    "operator_disabled",
    "user_disabled",
    "no_provider",
    "consent_required",
  ] as const)(
    "drops the briefing lead and top signal while briefing is %s",
    (reason) => {
      const d = buildDailyDigest(
        input({
          ai: { ...DIGEST_AI_AVAILABLE, briefing: aiUnavailable(reason) },
        }),
        t,
      );
      expect(d.briefingLead).toBeNull();
      expect(d.topSignal).toBeNull();
      // The push line falls to the deterministic floor, never to model text.
      expect(d.line).toBe("Your health score today is 82.");
      expect(d.ai.briefing.reason).toBe(reason);
    },
  );
});

// v1.39.2 — a check-up that is due today or overdue, and a visit booked for
// today, are the two rail items a person can miss for good: the check-up
// because the reminder already went out, the visit because the day ends.
// Watched red: with the plain `slice(0, 3)` over the priority order, the
// first two cases drop the item behind an overdue dose and three sync issues.
describe("buildDailyDigest — due check-ups and today's visits hold their place", () => {
  const crowd = {
    medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
    syncIssues: [
      { integration: "withings", state: "error_reauth" },
      { integration: "nightscout", state: "parked" },
      { integration: "fitbit", state: "error_reauth" },
    ],
  };
  const visit = (over: Record<string, unknown> = {}) => ({
    id: "v1",
    kind: "ROUTINE",
    occurredAt: "2026-07-16T13:00:00.000Z",
    practitionerName: "Dr. Weiss",
    dayOffset: 0,
    ...over,
  });

  it("keeps a due check-up on a full rail", () => {
    const d = buildDailyDigest(
      input({ ...crowd, preventiveDue: [{ label: "Skin check" }] }),
      t,
    );
    expect(d.worthALook).toHaveLength(MAX_WORTH_A_LOOK);
    expect(d.worthALook.map((i) => i.kind)).toContain("preventive_care");
    // The overdue dose still leads; the pinned item takes a later slot.
    expect(d.worthALook[0].kind).toBe("dose_window");
  });

  it("keeps today's visit on a full rail", () => {
    const d = buildDailyDigest(
      input({ ...crowd, upcomingVisits: [visit()] }),
      t,
    );
    expect(d.worthALook.map((i) => i.kind)).toContain("upcoming_visit");
  });

  it("keeps both a due check-up and today's visit on a full rail", () => {
    const d = buildDailyDigest(
      input({
        ...crowd,
        preventiveDue: [{ label: "Skin check" }],
        upcomingVisits: [visit()],
      }),
      t,
    );
    expect(d.worthALook.map((i) => i.kind)).toEqual([
      "dose_window",
      "preventive_care",
      "upcoming_visit",
    ]);
  });

  it("does not pin a visit that is not today", () => {
    const d = buildDailyDigest(
      input({ ...crowd, upcomingVisits: [visit({ dayOffset: 1 })] }),
      t,
    );
    expect(d.worthALook.map((i) => i.kind)).not.toContain("upcoming_visit");
  });

  it("names every visit of the day in one item, including one already under way", () => {
    const d = buildDailyDigest(
      input({
        upcomingVisits: [
          // Started an hour before NOW: still today's, still on the rail.
          visit({ occurredAt: "2026-07-16T08:00:00.000Z" }),
          visit({ id: "v2", practitionerName: "Dentist" }),
        ],
      }),
      t,
    );
    const visits = d.worthALook.filter((i) => i.kind === "upcoming_visit");
    expect(visits).toHaveLength(1);
    expect(visits[0].body).toBe("Dr. Weiss, Dentist — today");
  });

  it("says tomorrow and the day after by calendar day", () => {
    const tomorrow = buildDailyDigest(
      input({ upcomingVisits: [visit({ dayOffset: 1 })] }),
      t,
    );
    expect(
      tomorrow.worthALook.find((i) => i.kind === "upcoming_visit")?.body,
    ).toBe("Dr. Weiss — tomorrow");
    const later = buildDailyDigest(
      input({ upcomingVisits: [visit({ dayOffset: 2 })] }),
      t,
    );
    expect(
      later.worthALook.find((i) => i.kind === "upcoming_visit")?.body,
    ).toBe("Dr. Weiss — the day after tomorrow");
  });

  it("shows today's visits and the next day's as two items", () => {
    const d = buildDailyDigest(
      input({
        upcomingVisits: [
          visit(),
          visit({ id: "v2", practitionerName: "Dentist", dayOffset: 1 }),
          visit({ id: "v3", practitionerName: "Lab", dayOffset: 2 }),
        ],
      }),
      t,
    );
    expect(
      d.worthALook
        .filter((i) => i.kind === "upcoming_visit")
        .map((i) => i.body),
    ).toEqual(["Dr. Weiss — today", "Dentist — tomorrow"]);
  });
});
