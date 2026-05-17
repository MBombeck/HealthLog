/**
 * v0.5.4 ios-coord — mood-reminder dispatcher unit tests.
 *
 * Pins the contract that motivated the v0.5.4 server-side patch and
 * the v1.4.38.2 hotfix bundle:
 *   - Opt-in gating: `moodReminderEnabled = false` ⇒ never dispatch.
 *   - Window gating: only fires inside the 22:00 local-time hour.
 *   - Logged-today skip: a `MoodEntry` row for the local date short-
 *     circuits the dispatch.
 *   - Idempotency: a `MoodReminderDispatch` row blocks a second push
 *     for the same (user, date).
 *   - Locale: title + body come from the user's locale across all six
 *     supported locales (de/en/es/fr/it/pl) and fall back to the app
 *     default for null / unknown locales.
 *   - Ledger-after-delivery: a dispatcher that reports `dispatched =
 *     false` (no channel succeeded) does NOT write a ledger row, so
 *     the next tick is free to retry.
 *   - Per-user try-wrapper: an exception in one user's processing
 *     does not abort the tick for the rest of the candidates.
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

interface FakePrismaState {
  candidates: Array<{
    id: string;
    timezone: string;
    locale: string | null;
  }>;
  moodEntries: Array<{ userId: string; date: string }>;
  dispatches: Array<{ userId: string; date: string }>;
  /** Force the next `moodReminderDispatch.create` to throw P2002. */
  raceUserIds: Set<string>;
}

function makePrisma(state: FakePrismaState) {
  return {
    user: {
      findMany: vi.fn(async () => state.candidates),
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
    const at22 = new Date("2026-05-17T20:00:00Z");
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: false },
      at22,
    );
    expect(r.fire).toBe(false);
    expect(r.localDate).toBeNull();
  });

  it("fires inside the 22:00 hour and returns the local date string", () => {
    const at22 = new Date("2026-05-17T20:00:00Z");
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at22,
    );
    expect(r.fire).toBe(true);
    expect(r.localDate).toBe("2026-05-17");
    expect(r.localHour).toBe(MOOD_REMINDER_LOCAL_HOUR);
  });

  it("does NOT fire at 21:59 local time", () => {
    const at2159 = new Date("2026-05-17T19:59:00Z");
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at2159,
    );
    expect(r.fire).toBe(false);
    expect(r.localHour).toBe(21);
  });

  it("does NOT fire at 23:00 local time", () => {
    const at23 = new Date("2026-05-17T21:00:00Z");
    const r = evaluateMoodReminderWindow(
      { timezone: "Europe/Berlin", moodReminderEnabled: true },
      at23,
    );
    expect(r.fire).toBe(false);
    expect(r.localHour).toBe(23);
  });

  it("respects a non-Berlin timezone", () => {
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

  it.each(["es", "fr", "it", "pl"] as const)(
    "returns native (non-EN) strings for locale=%s",
    (locale) => {
      const p = buildMoodReminderPayload(locale);
      const enTitle = buildMoodReminderPayload("en").title;
      const enBody = buildMoodReminderPayload("en").body;
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.body.length).toBeGreaterThan(0);
      expect(p.title).not.toBe(enTitle);
      expect(p.body).not.toBe(enBody);
    },
  );

  it("falls back to the app default for null / unknown locales", () => {
    const p1 = buildMoodReminderPayload(null);
    const p2 = buildMoodReminderPayload("zz-ZZ");
    expect(p1.title).toBe(p2.title);
    expect(p1.title.length).toBeGreaterThan(0);
  });

  it("FR body carries the apostrophe (regression: v0.5.4 shipped 'aujourdhui')", () => {
    const p = buildMoodReminderPayload("fr");
    expect(p.body).toContain("aujourd’hui");
    expect(p.body).not.toContain("aujourdhui ");
  });
});

describe("runMoodReminderTick", () => {
  const inWindow = new Date("2026-05-17T20:00:00Z");
  const outOfWindow = new Date("2026-05-17T19:00:00Z");

  it("dispatches MOOD_REMINDER for opted-in users in the 22:00 window", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

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
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMoodReminderTick(prisma as never, outOfWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedOutsideWindow).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("Prisma query filters to moodReminderEnabled=true users only", async () => {
    const state: FakePrismaState = {
      candidates: [],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMoodReminderTick(prisma as never, inWindow, { dispatch });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { moodReminderEnabled: true } }),
    );
  });

  it("skips users who already logged a mood for the local date", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [{ userId: "u-1", date: "2026-05-17" }],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

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
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [],
      dispatches: [{ userId: "u-1", date: "2026-05-17" }],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedAlreadyDispatched).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ledger-after-delivery: dispatcher reporting dispatched=false leaves the slot free", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => NO_CHANNEL);

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.skippedNoChannel).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Ledger MUST stay empty so the next tick (or next request after the
    // user adds a channel) is free to retry.
    expect(state.dispatches).toHaveLength(0);
    expect(prisma.moodReminderDispatch.create).not.toHaveBeenCalled();
  });

  it("P2002 race: counts as dispatched (both workers pushed, one ledger row survives)", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-1", timezone: "Europe/Berlin", locale: "de" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(["u-1"]),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    // The dispatcher delivered (OK), the ledger insert hit P2002. The
    // user already received the push from this worker; we count it as
    // dispatched and move on.
    expect(summary.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("per-user try-wrapper: one bad user does not abort the rest of the tick", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-bad", timezone: "Europe/Berlin", locale: "de" },
        { id: "u-ok", timezone: "Europe/Berlin", locale: "en" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async (payload) => {
      if (payload.userId === "u-bad") {
        throw new Error("simulated dispatcher throw");
      }
      return OK;
    });

    const summary = await runMoodReminderTick(prisma as never, inWindow, {
      dispatch,
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(1);
    expect(state.dispatches.map((d) => d.userId)).toEqual(["u-ok"]);
  });

  it("dispatches per-user with their own locale (DE + EN mix)", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-de", timezone: "Europe/Berlin", locale: "de" },
        { id: "u-en", timezone: "Europe/Berlin", locale: "en" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

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

  it("dispatches per-user locale for fr/es/it/pl (regression: resolver dropped 4/6)", async () => {
    const state: FakePrismaState = {
      candidates: [
        { id: "u-fr", timezone: "Europe/Berlin", locale: "fr" },
        { id: "u-es", timezone: "Europe/Berlin", locale: "es" },
        { id: "u-it", timezone: "Europe/Berlin", locale: "it" },
        { id: "u-pl", timezone: "Europe/Berlin", locale: "pl" },
      ],
      moodEntries: [],
      dispatches: [],
      raceUserIds: new Set(),
    };
    const prisma = makePrisma(state);
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMoodReminderTick(prisma as never, inWindow, { dispatch });

    const titles = dispatch.mock.calls.map((c) => c[0].title);
    const enTitle = buildMoodReminderPayload("en").title;
    // Each non-EN user must get a title that is NOT the English string.
    expect(titles).toHaveLength(4);
    for (const t of titles) {
      expect(t).not.toBe(enTitle);
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
