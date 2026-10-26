/**
 * v1.15 — cycle-reminder dispatcher unit tests.
 *
 * Pins the windowing + suppression contract:
 *   - Window gating: only fires inside the 09:00 local-time hour.
 *   - PERIOD_SOON fires exactly `PERIOD_SOON_LEAD_DAYS` before the
 *     predicted next-period start.
 *   - PERIOD_CONFIRM fires on/after the predicted start, inside the grace
 *     window, while no observed period is logged — and goes quiet once a
 *     period IS logged near the prediction.
 *   - Gate: a cycle-disabled account never receives a push.
 *   - predictionEnabled=false suppresses everything.
 *   - clientManaged suppression: skips the server push (iOS owns it).
 *   - discreetNotifications: swaps the body to the generic "HealthLog
 *     reminder" so no cycle event is named on the lock screen.
 *   - Idempotency: an existing `ok` push_attempt for the event today
 *     blocks a second push.
 *   - Locale: title + body resolve from the user's locale.
 *   - Per-user try-wrapper: one bad row never aborts the tick.
 *
 * The tests stub the Prisma surface manually (no testcontainer boot).
 */
import { describe, it, expect, vi } from "vitest";

import {
  buildCycleReminderPayload,
  cycleReminderLocalDate,
  evaluateCycleReminder,
  evaluateFertileReminder,
  runCycleReminderTick,
  CYCLE_REMINDER_LOCAL_HOUR,
  PERIOD_SOON_LEAD_DAYS,
  PERIOD_CONFIRM_GRACE_DAYS,
  FERTILE_SOON_LEAD_DAYS,
} from "../cycle-reminder";
import { isCycleEnabled } from "@/lib/cycle/enabled";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { DispatchOutcome } from "@/lib/notifications/dispatcher";

type DispatchFn = (payload: NotificationPayload) => Promise<DispatchOutcome>;

const OK: DispatchOutcome = {
  dispatched: true,
  channelsAttempted: 1,
  channelsSucceeded: 1,
};
const NO_CHANNEL: DispatchOutcome = {
  dispatched: false,
  channelsAttempted: 0,
  channelsSucceeded: 0,
};

interface FakeUser {
  id: string;
  gender: string | null;
  timezone: string;
  locale: string | null;
  notificationPrefs?: unknown;
  cycleProfile: {
    cycleTrackingEnabled: boolean | null;
    predictionEnabled: boolean;
    discreetNotifications: boolean;
    goal?: string;
  } | null;
}

interface FakeState {
  predictions: Array<{
    userId: string;
    nextPeriodStart: string;
    fertileWindowStart?: string | null;
    user: FakeUser;
  }>;
  /** Observed (non-predicted) cycle start dates per userId. */
  observedStarts: Record<string, string[]>;
  /** Existing `ok` push attempts: `${userId}:${eventType}` already sent today. */
  alreadyOk: Set<string>;
}

function makePrisma(state: FakeState) {
  return {
    cyclePrediction: {
      findMany: vi.fn(async () => state.predictions),
    },
    pushAttempt: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; eventType: string } }) => {
          const key = `${where.userId}:${where.eventType}`;
          return state.alreadyOk.has(key) ? { id: "pa-1" } : null;
        },
      ),
    },
    menstrualCycle: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const starts = state.observedStarts[where.userId] ?? [];
        return starts.map((startDate) => ({ startDate }));
      }),
    },
  };
}

/** 09:00 Europe/Berlin (CEST in May → 07:00Z). */
const AT_0900_BERLIN = new Date("2026-05-17T07:00:00Z");

function baseUser(over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: "u1",
    gender: "FEMALE",
    timezone: "Europe/Berlin",
    locale: "en",
    notificationPrefs: null,
    cycleProfile: {
      cycleTrackingEnabled: null,
      predictionEnabled: true,
      discreetNotifications: false,
      goal: "GENERAL_HEALTH",
    },
    ...over,
  };
}

describe("cycleReminderLocalDate", () => {
  it("returns the local date inside the 09:00 hour", () => {
    expect(cycleReminderLocalDate(AT_0900_BERLIN, "Europe/Berlin")).toBe(
      "2026-05-17",
    );
    expect(CYCLE_REMINDER_LOCAL_HOUR).toBe(9);
  });

  it("returns null at 08:59 and 10:00 local time", () => {
    expect(
      cycleReminderLocalDate(new Date("2026-05-17T06:59:00Z"), "Europe/Berlin"),
    ).toBeNull();
    expect(
      cycleReminderLocalDate(new Date("2026-05-17T08:00:00Z"), "Europe/Berlin"),
    ).toBeNull();
  });

  it("respects a non-Berlin timezone", () => {
    // 09:00 America/New_York (EDT) = 13:00Z
    expect(
      cycleReminderLocalDate(
        new Date("2026-05-17T13:00:00Z"),
        "America/New_York",
      ),
    ).toBe("2026-05-17");
  });
});

describe("evaluateCycleReminder", () => {
  it("fires PERIOD_SOON exactly lead-days before the predicted start", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-18",
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: false,
      }),
    ).toBe("CYCLE_PERIOD_SOON");
    expect(PERIOD_SOON_LEAD_DAYS).toBe(2);
  });

  it("does not fire PERIOD_SOON one day off the lead", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-19",
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: false,
      }),
    ).toBe(null); // 1 day before → neither soon (lead=2) nor confirm (not yet due)
  });

  it("fires PERIOD_CONFIRM on the predicted day when no period logged", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-20",
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: false,
      }),
    ).toBe("CYCLE_PERIOD_CONFIRM");
  });

  it("fires PERIOD_CONFIRM within the grace window after the predicted day", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-23", // +3 days, grace=3
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: false,
      }),
    ).toBe("CYCLE_PERIOD_CONFIRM");
    expect(PERIOD_CONFIRM_GRACE_DAYS).toBe(3);
  });

  it("stops PERIOD_CONFIRM past the grace window", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-24", // +4 days, grace=3
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: false,
      }),
    ).toBe(null);
  });

  it("suppresses PERIOD_CONFIRM once a period is logged", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-20",
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: true,
      }),
    ).toBe(null);
  });

  it("suppresses PERIOD_SOON once a period is logged (early period)", () => {
    expect(
      evaluateCycleReminder({
        today: "2026-05-18",
        nextPeriodStart: "2026-05-20",
        periodAlreadyLogged: true,
      }),
    ).toBe(null);
  });
});

describe("evaluateFertileReminder", () => {
  it("fires exactly lead-days before the fertile-window start", () => {
    expect(
      evaluateFertileReminder({
        today: "2026-05-18",
        fertileWindowStart: "2026-05-20",
      }),
    ).toBe(true);
    expect(FERTILE_SOON_LEAD_DAYS).toBe(2);
  });

  it("does not fire one day off the lead", () => {
    expect(
      evaluateFertileReminder({
        today: "2026-05-19",
        fertileWindowStart: "2026-05-20",
      }),
    ).toBe(false);
    expect(
      evaluateFertileReminder({
        today: "2026-05-17",
        fertileWindowStart: "2026-05-20",
      }),
    ).toBe(false);
  });
});

describe("buildCycleReminderPayload", () => {
  it("carries non-contraceptive fertile framing when not discreet", () => {
    const fertile = buildCycleReminderPayload(
      "CYCLE_FERTILE_SOON",
      "en",
      false,
    );
    expect(fertile.title.toLowerCase()).toContain("fertile");
    // Honesty boundary: never a contraceptive / safe-day claim.
    expect(fertile.body.toLowerCase()).toContain("not");
    expect(fertile.body.toLowerCase()).not.toContain("safe day");
  });

  it("collapses the fertile event to the generic body when discreet", () => {
    const fertile = buildCycleReminderPayload("CYCLE_FERTILE_SOON", "en", true);
    expect(fertile.title.toLowerCase()).not.toContain("fertile");
    expect(fertile.title).toContain("HealthLog");
  });

  it("names the event when not discreet", () => {
    const soon = buildCycleReminderPayload("CYCLE_PERIOD_SOON", "en", false);
    expect(soon.title.length).toBeGreaterThan(0);
    expect(soon.title.toLowerCase()).toContain("period");
    const confirm = buildCycleReminderPayload(
      "CYCLE_PERIOD_CONFIRM",
      "en",
      false,
    );
    expect(confirm.title).not.toBe(soon.title);
  });

  it("collapses to the generic HealthLog body when discreet", () => {
    const soon = buildCycleReminderPayload("CYCLE_PERIOD_SOON", "en", true);
    const confirm = buildCycleReminderPayload(
      "CYCLE_PERIOD_CONFIRM",
      "en",
      true,
    );
    expect(soon).toEqual(confirm); // identical generic copy regardless of event
    expect(soon.title.toLowerCase()).not.toContain("period");
    expect(soon.title).toContain("HealthLog");
  });

  it("resolves a non-default locale", () => {
    const de = buildCycleReminderPayload("CYCLE_PERIOD_SOON", "de", false);
    const en = buildCycleReminderPayload("CYCLE_PERIOD_SOON", "en", false);
    expect(de.title).not.toBe(en.title);
  });
});

describe("runCycleReminderTick", () => {
  function run(
    state: FakeState,
    dispatch: DispatchFn,
    now = AT_0900_BERLIN,
    overrides: {
      /**
       * v1.18.0 — inject the module gate. Default resolves the per-user
       * cycle toggle off the FakeState user (the same `isCycleEnabled`
       * derivation the cron used to apply inline), so the gender-derivation
       * cases stay faithful. Pass `operatorOff: true` to assert the operator
       * server-wide kill-switch suppresses every push regardless of the
       * per-user toggle.
       */
      operatorOff?: boolean;
    } = {},
  ) {
    const prisma = makePrisma(state);
    const isModuleEnabled = vi.fn(async (userId: string) => {
      if (overrides.operatorOff) return false;
      const pred = state.predictions.find((p) => p.userId === userId);
      const u = pred?.user;
      return isCycleEnabled(u?.gender ?? null, u?.cycleProfile ?? null);
    });
    return runCycleReminderTick(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      now,
      {
        dispatch:
          dispatch as typeof import("@/lib/notifications/dispatcher").dispatchNotification,
        isModuleEnabled:
          isModuleEnabled as unknown as typeof import("@/lib/modules/gate").isModuleEnabled,
      },
    );
  }

  it("dispatches PERIOD_SOON two days before the predicted start", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-19", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedPeriodSoon).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].eventType).toBe("CYCLE_PERIOD_SOON");
  });

  it("dispatches FERTILE_SOON two days before the fertile window for the TTC goal", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          // Period start far out so only the fertile window is in-window.
          nextPeriodStart: "2026-06-02",
          fertileWindowStart: "2026-05-19",
          user: baseUser({
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: true,
              discreetNotifications: false,
              goal: "TRYING_TO_CONCEIVE",
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedFertileSoon).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].eventType).toBe("CYCLE_FERTILE_SOON");
  });

  it("never dispatches FERTILE_SOON for a non-TTC goal (inclusive framing)", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-06-02",
          fertileWindowStart: "2026-05-19",
          user: baseUser({
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: true,
              discreetNotifications: false,
              goal: "AVOID_PREGNANCY",
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedFertileSoon).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never dispatches FERTILE_SOON when fertileWindowStart is null", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-06-02",
          fertileWindowStart: null,
          user: baseUser({
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: true,
              discreetNotifications: false,
              goal: "TRYING_TO_CONCEIVE",
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedFertileSoon).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches PERIOD_CONFIRM on the predicted day with no logged period", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-17", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedPeriodConfirm).toBe(1);
    expect(dispatch.mock.calls[0][0].eventType).toBe("CYCLE_PERIOD_CONFIRM");
  });

  it("suppresses PERIOD_CONFIRM once a period is logged near the prediction", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-17", user: baseUser() },
      ],
      observedStarts: { u1: ["2026-05-17"] },
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedPeriodConfirm).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.skippedAlreadyLogged).toBe(1);
  });

  it("gates entirely on cycle tracking — a MALE account never gets a push", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-05-19",
          user: baseUser({
            gender: "MALE",
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: true,
              discreetNotifications: false,
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.dispatchedPeriodSoon).toBe(0);
    expect(summary.skippedModuleDisabled).toBe(1);
  });

  it("operator server-wide kill-switch suppresses every cycle push (v1.18.0)", async () => {
    // A fully cycle-enabled FEMALE account with an in-window prediction:
    // the only thing stopping the push is the operator-level module gate.
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-19", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch, AT_0900_BERLIN, {
      operatorOff: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.dispatchedPeriodSoon).toBe(0);
    expect(summary.skippedModuleDisabled).toBe(1);
  });

  it("opts a non-FEMALE account in via the explicit cycleTrackingEnabled flag", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-05-19",
          user: baseUser({
            gender: "MALE",
            cycleProfile: {
              cycleTrackingEnabled: true,
              predictionEnabled: true,
              discreetNotifications: false,
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedPeriodSoon).toBe(1);
  });

  it("suppresses everything when predictionEnabled is false", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-05-19",
          user: baseUser({
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: false,
              discreetNotifications: false,
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.skippedPredictionDisabled).toBe(1);
  });

  it("suppresses the server push when clientManaged is true", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-05-19",
          user: baseUser({
            notificationPrefs: { cycle: { clientManaged: true } },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.suppressedClientManaged).toBe(1);
  });

  it("swaps to the generic body when discreetNotifications is true", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "u1",
          nextPeriodStart: "2026-05-19",
          user: baseUser({
            cycleProfile: {
              cycleTrackingEnabled: null,
              predictionEnabled: true,
              discreetNotifications: true,
            },
          }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.dispatchedPeriodSoon).toBe(1);
    expect(summary.suppressedDiscreet).toBe(1);
    const payload = dispatch.mock.calls[0][0];
    // Generic body — no cycle event named on the lock screen.
    expect(payload.title.toLowerCase()).not.toContain("period");
    expect(payload.title).toContain("HealthLog");
    // The eventType is still the real one (so prefs gating + ledger work).
    expect(payload.eventType).toBe("CYCLE_PERIOD_SOON");
  });

  it("does not double-fire when an ok attempt already landed today", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-19", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(["u1:CYCLE_PERIOD_SOON"]),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.skippedAlreadyNotified).toBe(1);
  });

  it("counts a no-channel dispatch as skipped (free to retry)", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-19", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => NO_CHANNEL);
    const summary = await run(state, dispatch);
    expect(summary.skippedNoChannel).toBe(1);
    expect(summary.dispatchedPeriodSoon).toBe(0);
  });

  it("skips outside the 09:00 window", async () => {
    const state: FakeState = {
      predictions: [
        { userId: "u1", nextPeriodStart: "2026-05-19", user: baseUser() },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(
      state,
      dispatch,
      new Date("2026-05-17T20:00:00Z"),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.skippedOutsideWindow).toBe(1);
  });

  it("isolates a per-user failure from the rest of the tick", async () => {
    const state: FakeState = {
      predictions: [
        {
          userId: "bad",
          nextPeriodStart: "not-a-date",
          user: baseUser({ id: "bad" }),
        },
        {
          userId: "u2",
          nextPeriodStart: "2026-05-19",
          user: baseUser({ id: "u2" }),
        },
      ],
      observedStarts: {},
      alreadyOk: new Set(),
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await run(state, dispatch);
    expect(summary.failed).toBe(1);
    expect(summary.dispatchedPeriodSoon).toBe(1); // u2 still processed
  });
});

describe("runCycleReminderTick — windowing query", () => {
  it("pushes the cohort gate into the findMany where-clause", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      cyclePrediction: { findMany },
      pushAttempt: { findFirst: vi.fn(async () => null) },
      menstrualCycle: { findMany: vi.fn(async () => []) },
    };
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    await runCycleReminderTick(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      AT_0900_BERLIN,
      {
        dispatch:
          dispatch as typeof import("@/lib/notifications/dispatcher").dispatchNotification,
      },
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0] as unknown as {
      where: {
        OR: Array<{
          nextPeriodStart?: { gte: string; lte: string };
          fertileWindowStart?: { gte: string; lte: string };
        }>;
        user: {
          cycleProfile: {
            cycleTrackingEnabled: boolean;
            NOT: { predictionEnabled: boolean };
          };
        };
      };
    };
    // Tracking + prediction gate is in the query, not JS.
    expect(arg.where.user.cycleProfile.cycleTrackingEnabled).toBe(true);
    expect(arg.where.user.cycleProfile.NOT.predictionEnabled).toBe(false);
    // The query ORs a period-start window with a fertile-window window
    // (the fertile window sits ~2 weeks ahead of the period start, so it
    // needs its own date range). The period window is a YYYY-MM-DD string
    // range straddling "now"; at 2026-05-17 it spans
    // [today-grace-1 .. today+lead+1] in UTC.
    const periodRange = arg.where.OR.find(
      (c) => c.nextPeriodStart != null,
    )?.nextPeriodStart;
    const fertileRange = arg.where.OR.find(
      (c) => c.fertileWindowStart != null,
    )?.fertileWindowStart;
    expect(periodRange?.gte).toBe("2026-05-13");
    expect(periodRange?.lte).toBe("2026-05-20");
    expect((periodRange?.gte ?? "") < (periodRange?.lte ?? "")).toBe(true);
    // Fertile window: [today-1 .. today+lead+1] in UTC.
    expect(fertileRange?.gte).toBe("2026-05-16");
    expect(fertileRange?.lte).toBe("2026-05-20");
  });
});
