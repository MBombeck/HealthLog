/**
 * v0.5.4 ios-coord — mood-reminder dispatcher unit tests.
 *
 * Pins the contract that motivated the v0.5.4 server-side patch:
 *   - Opt-in gating: `moodReminderEnabled = false` ⇒ never dispatch.
 *   - Window gating: only fires inside the 22:00 local-time hour.
 *   - Logged-today skip: a `MoodEntry` row for the local date short-
 *     circuits the dispatch.
 *   - Idempotency: a `MoodReminderDispatch` row blocks a second push
 *     for the same (user, date) — even when the cron re-ticks inside
 *     the same 22:00 window.
 *   - Locale: title + body come from `messages/{de,en}.json` and fall
 *     back to the app default when the user's locale is null/unknown.
 *
 * The tests stub the Prisma surface manually to keep this file free of
 * a testcontainer boot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  buildMoodReminderPayload,
  evaluateMoodReminderWindow,
  runMoodReminderTick,
  MOOD_REMINDER_LOCAL_HOUR,
} from "../mood-reminder";
import type { NotificationPayload } from "@/lib/notifications/types";

type DispatchFn = (payload: NotificationPayload) => Promise<void>;

interface FakePrismaState {
  candidates: Array<{
    id: string;
    timezone: string;
    locale: string | null;
    moodReminderEnabled: boolean;
  }>;
  moodEntries: Array<{ userId: string; date: string }>;
  dispatches: Array<{ userId: string; date: string }>;
  /** Force the next `moodReminderDispatch.create` to throw P2002. */
  raceUserIds: Set<string>;
}

function makePrisma(state: FakePrismaState) {
  return {
    user: {
      findMany: vi.fn(
        async ({ where }: { where: { moodReminderEnabled: boolean } }) => {
          return state.candidates.filter(
            (c) => c.moodReminderEnabled === where.moodReminderEnabled,
          );
        },
      ),
    },
    moodEntry: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; date: string } }) => {
          return (
            state.moodEntries.find(
              (m) => m.userId === where.userId && m.date === where.date,
            ) ?? null
          );
        },
      ),
    },
    moodReminderDispatch: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { userId_date: { userId: string; date: string } };
        }) => {
          return (
            state.dispatches.find(
              (d) =>
                d.userId === where.userId_date.userId &&
                d.date === where.userId_date.date,
            ) ?? null
          );
        },
      ),
      create: vi.fn(
        async ({ data }: { data: { userId: string; date: string } }) => {
          if (state.raceUserIds.has(data.userId)) {
            // Mirrors the Prisma `P2002` shape closely enough that the
            // handler's substring match (`includes("P2002")`) catches it.
            throw new Error(
              "Invalid `prisma.moodReminderDispatch.create()` invocation: " +
                "Unique constraint failed on the fields: (`user_id`,`date`). " +
                "code: P2002",
            );
          }
          state.dispatches.push(data);
          return { id: `dispatch-${state.dispatches.length}`, ...data };
        },
      ),
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("evaluateMoodReminderWindow", () => {
  it("returns fire=false when the user is opted out", () => {
    const at22 = new Date("2026-05-17T20:00:00Z"); // 22:00 Europe/Berlin
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: false },
      at22,
    );
    expect(r.fire).toBe(false);
    expect(r.localDate).toBeNull();
  });

  it("fires inside the 22:00 hour and returns the local date string", () => {
    const at22 = new Date("2026-05-17T20:00:00Z"); // 22:00 Europe/Berlin (CEST)
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at22,
    );
    expect(r.fire).toBe(true);
    expect(r.localDate).toBe("2026-05-17");
    expect(r.localHour).toBe(MOOD_REMINDER_LOCAL_HOUR);
  });

  it("does NOT fire at 21:59 local time (off-by-one guard)", () => {
    const at2159 = new Date("2026-05-17T19:59:00Z"); // 21:59 Europe/Berlin
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at2159,
    );
    expect(r.fire).toBe(false);
    expect(r.localHour).toBe(21);
  });

  it("does NOT fire at 23:00 local time (window end)", () => {
    const at23 = new Date("2026-05-17T21:00:00Z"); // 23:00 Europe/Berlin
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at23,
    );
    expect(r.fire).toBe(false);
    expect(r.localHour).toBe(23);
  });

  it("respects a non-Berlin timezone (America/New_York is 6h behind in DST)", () => {
    // 02:00 UTC on 2026-05-18 = 22:00 EDT on 2026-05-17 (UTC-4 during DST).
    const utc = new Date("2026-05-18T02:00:00Z");
    const r = evaluateMoodReminderWindow(
      { timezone: "America/New_York", moodReminderEnabled: true },
      utc,
    );
    expect(r.fire).toBe(true);
    expect(r.localDate).toBe("2026-05-17");
  });
});

describe("buildMoodReminderPayload", () => {
  it("returns German strings for locale=de", () => {
    const p = buildMoodReminderPayload("de");
    expect(p.title).toBe("Stimmung erfassen");
    expect(p.body).toBe("Wie geht es dir heute?");
  });

  it("returns English strings for locale=en", () => {
    const p = buildMoodReminderPayload("en");
    expect(p.title).toBe("Log your mood");
    expect(p.body).toBe("How are you feeling today?");
  });

  it("falls back to the app default for null / unknown locales", () => {
    const p1 = buildMoodReminderPayload(null);
    const p2 = buildMoodReminderPayload("zz-ZZ");
    // Both should resolve to the same content (the app default).
    expect(p1.title).toBe(p2.title);
    expect(p1.title.length).toBeGreaterThan(0);
  });
});

describe("runMoodReminderTick", () => {
  // 22:00 Europe/Berlin (CEST) ⇒ 20:00 UTC.
  const inWindow = new Date("2026-05-17T20:00:00Z");
  // 21:00 Europe/Berlin (CEST) ⇒ 19:00 UTC.
  const outOfWindow = new Date("2026-05-17T19:00:00Z");

  it("dispatches MOOD_REMINDER for opted-in users in the 22:00 window", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-1",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.inWindow).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const firstCall = dispatch.mock.calls[0];
    if (!firstCall) throw new Error("dispatch was not called");
    const call = firstCall[0];
    expect(call.eventType).toBe("MOOD_REMINDER");
    expect(call.userId).toBe("u-1");
    expect(call.title).toBe("Stimmung erfassen");
    expect(call.message).toBe("Wie geht es dir heute?");
    expect(call.metadata?.localDate).toBe("2026-05-17");
    expect(typeof call.metadata?.scheduledAt).toBe("string");
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toEqual({ userId: "u-1", date: "2026-05-17" });
  });

  it("does NOT dispatch for users outside the 22:00 window", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-1",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, outOfWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedOutsideWindow).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never reads moodReminderEnabled=false users (opt-in gating)", async () => {
    const state: FakePrismaState = {
      candidates: [], // Prisma `where` already filters; we assert the call shape
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    await runMoodReminderTick(prisma as never, inWindow, { dispatch });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { moodReminderEnabled: true } }),
    );
  });

  it("skips users who already logged a mood for the local date", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-1",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [{ userId: "u-1", date: "2026-05-17" }],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedAlreadyLogged).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.dispatches).toHaveLength(0);
  });

  it("idempotency: a second tick inside the same window does not re-send", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-1",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [],
      // Existing dispatch row blocks the push.
      dispatches: [{ userId: "u-1", date: "2026-05-17" }],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedAlreadyDispatched).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("idempotency: lost P2002 race is swallowed as 'already dispatched'", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-1",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(["u-1"]),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedAlreadyDispatched).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches per-user with their own locale (DE + EN mix)", async () => {
    const state: FakePrismaState = {
      candidates: [
        {
          id: "u-de",
          timezone: "Europe/Berlin",
          locale: "de",
          moodReminderEnabled: true,
        },
        {
          id: "u-en",
          timezone: "Europe/Berlin",
          locale: "en",
          moodReminderEnabled: true,
        },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => {});

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const titles = dispatch.mock.calls.map((c) => {
      const [payload] = c;
      return payload?.title ?? "";
    });
    expect(titles).toContain("Stimmung erfassen");
    expect(titles).toContain("Log your mood");
  });
});
