/**
 * The notice state machine: once per state change per signal, a recovery
 * notice once, a reminder at most once a day while failing, nothing else.
 *
 * Two layers. `decideNotice` is pure and pinned case by case.
 * `notifyReadinessChanges` runs against an in-memory stand-in for its one
 * table that honours the compare-and-set exactly as Postgres would (a row
 * moves only from the values the caller read), so the hourly sequence and the
 * two-workers race are proven on the real claim logic rather than assumed.
 *
 * Mutation check: drop the `last !== current` comparison and the "same state
 * twice" case sends twice; drop the CAS `where` on `notifiedState` and the
 * race sends two notices.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  notices: new Map<
    string,
    {
      signal: string;
      notifiedState: string | null;
      notifiedAt: Date | null;
      watchedSince: Date | null;
    }
  >(),
  admins: [] as Array<{ id: string }>,
}));

const same = (a: Date | null, b: Date | null | undefined) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => store.admins) },
    recoveryReadinessNotice: {
      createMany: vi.fn(
        async ({ data }: { data: Array<{ signal: string }> }) => {
          for (const { signal } of data) {
            if (!store.notices.has(signal)) {
              store.notices.set(signal, {
                signal,
                notifiedState: null,
                notifiedAt: null,
                watchedSince: null,
              });
            }
          }
          return { count: data.length };
        },
      ),
      findMany: vi.fn(async () =>
        [...store.notices.values()].map((row) => ({ ...row })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            signal: string;
            notifiedState?: string | null;
            notifiedAt?: Date | null;
            watchedSince?: Date | null;
          };
          data: Record<string, unknown>;
        }) => {
          const row = store.notices.get(where.signal);
          if (!row) return { count: 0 };
          if (
            "notifiedState" in where &&
            row.notifiedState !== where.notifiedState
          )
            return { count: 0 };
          if ("notifiedAt" in where && !same(row.notifiedAt, where.notifiedAt))
            return { count: 0 };
          if (
            "watchedSince" in where &&
            !same(row.watchedSince, where.watchedSince)
          )
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
  },
}));

const dispatch = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => {
    void opts;
  }),
);
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: dispatch,
}));

import {
  decideNotice,
  FAILING_REMINDER_HOURS,
  notifyReadinessChanges,
} from "@/lib/recovery/readiness-notify";
import {
  READINESS_FIX_PATHS,
  READINESS_SIGNALS,
  type ReadinessSignal,
  type ReadinessState,
  type RecoveryReadiness,
} from "@/lib/recovery/readiness-model";

const T0 = new Date("2026-10-25T12:00:00Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

describe("decideNotice", () => {
  it("announces a change to attention or failing once", () => {
    expect(decideNotice(null, "attention", T0)).toEqual({
      send: "problem",
      next: { notifiedState: "attention", notifiedAt: T0 },
    });
    const told = { notifiedState: "attention" as const, notifiedAt: T0 };
    expect(decideNotice(told, "attention", at(30)).send).toBeNull();
    expect(decideNotice(told, "failing", at(1)).send).toBe("problem");
  });

  it("reminds a failing signal once a day, not sooner", () => {
    const told = { notifiedState: "failing" as const, notifiedAt: T0 };
    expect(
      decideNotice(told, "failing", at(FAILING_REMINDER_HOURS - 1)).send,
    ).toBeNull();
    expect(decideNotice(told, "failing", at(FAILING_REMINDER_HOURS))).toEqual({
      send: "reminder",
      next: {
        notifiedState: "failing",
        notifiedAt: at(FAILING_REMINDER_HOURS),
      },
    });
  });

  it("announces a recovery once, and says nothing about an ok that was never broken", () => {
    const told = { notifiedState: "failing" as const, notifiedAt: T0 };
    expect(decideNotice(told, "ok", at(2)).send).toBe("recovered");
    expect(
      decideNotice({ notifiedState: "ok", notifiedAt: at(2) }, "ok", at(3)),
    ).toEqual({
      send: null,
      next: null,
    });
    expect(decideNotice(null, "ok", T0)).toEqual({ send: null, next: null });
  });

  it("forgets silently when a signal stops applying", () => {
    expect(
      decideNotice(
        { notifiedState: "failing", notifiedAt: T0 },
        "inactive",
        at(1),
      ),
    ).toEqual({ send: null, next: { notifiedState: null, notifiedAt: null } });
    expect(decideNotice(null, "inactive", T0)).toEqual({
      send: null,
      next: null,
    });
  });
});

function readiness(
  states: Partial<Record<ReadinessSignal["id"], [ReadinessState, string]>>,
  now: Date,
): RecoveryReadiness {
  return {
    state: "ok",
    evaluatedAt: now.toISOString(),
    signals: READINESS_SIGNALS.map((id) => {
      const [state, reason] = states[id] ?? ["ok", "fresh"];
      return {
        id,
        state,
        reason,
        at: null,
        params: { days: 12, accounts: 1 },
        detail: null,
        fixPath: READINESS_FIX_PATHS[id],
      };
    }),
  };
}

const sent = () =>
  dispatch.mock.calls.map(([opts]) => {
    const o = opts as unknown as {
      userId: string;
      titleKey: string;
      messageKey: string;
    };
    return `${o.userId} ${o.titleKey.split(".").at(-1)} ${o.messageKey}`;
  });

describe("notifyReadinessChanges", () => {
  beforeEach(() => {
    store.notices.clear();
    store.admins = [{ id: "admin-a" }, { id: "admin-b" }];
    dispatch.mockClear();
  });

  it("sends each notice to every admin, through the backup event", async () => {
    await notifyReadinessChanges(
      readiness({ weekly_copy: ["attention", "stale"] }, T0),
    );
    expect(sent()).toEqual([
      "admin-a titleAttention admin.recoveryReadiness.reason.weekly_copy.stale",
      "admin-b titleAttention admin.recoveryReadiness.reason.weekly_copy.stale",
    ]);
    const first = dispatch.mock.calls[0][0] as unknown as {
      eventType: string;
      params: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    expect(first.eventType).toBe("BACKUP_HEALTH");
    expect(first.params).toEqual({ days: 12, accounts: 1 });
    expect(first.metadata).toMatchObject({
      url: "/admin/backups",
      signal: "weekly_copy",
    });
  });

  it("runs an hourly sequence without nagging: change, silence, escalation, daily reminder, recovery", async () => {
    store.admins = [{ id: "admin-a" }];
    const run = (h: number, state: ReadinessState, reason: string) =>
      notifyReadinessChanges(
        readiness({ restore_drill: [state, reason] }, at(h)),
      );

    await run(0, "attention", "failed");
    for (let h = 1; h < 5; h++) await run(h, "attention", "failed");
    expect(sent()).toHaveLength(1);

    await run(5, "failing", "failed");
    for (let h = 6; h < 5 + FAILING_REMINDER_HOURS; h++)
      await run(h, "failing", "failed");
    expect(sent()).toHaveLength(2);

    await run(5 + FAILING_REMINDER_HOURS, "failing", "failed");
    await run(6 + FAILING_REMINDER_HOURS, "failing", "failed");
    expect(sent()).toHaveLength(3);
    expect(sent()[2]).toContain("titleReminder");

    await run(40, "ok", "passed");
    await run(41, "ok", "passed");
    expect(sent()).toHaveLength(4);
    expect(sent()[3]).toBe(
      "admin-a titleRecovered admin.recoveryReadiness.recovered.restore_drill",
    );
  });

  it("sends one notice when two evaluations race on the same row", async () => {
    const r = readiness({ recovery_kit: ["attention", "out_of_date"] }, T0);
    await Promise.all([notifyReadinessChanges(r), notifyReadinessChanges(r)]);
    expect(sent()).toHaveLength(2); // one notice, two admins
  });

  it("claims nothing while there is no admin to tell", async () => {
    store.admins = [];
    const r = readiness({ offhost_setup: ["attention", "not_configured"] }, T0);
    await notifyReadinessChanges(r);
    expect(store.notices.get("offhost_setup")?.notifiedState).toBeNull();
    store.admins = [{ id: "admin-a" }];
    await notifyReadinessChanges(r);
    expect(sent()).toHaveLength(1);
  });

  it("remembers since when a signal applies, and forgets it when it stops", async () => {
    await notifyReadinessChanges(
      readiness({ database_dump: ["ok", "fresh"] }, T0),
    );
    expect(store.notices.get("database_dump")?.watchedSince).toEqual(T0);
    await notifyReadinessChanges(
      readiness({ database_dump: ["ok", "fresh"] }, at(5)),
    );
    expect(store.notices.get("database_dump")?.watchedSince).toEqual(T0);
    await notifyReadinessChanges(
      readiness({ database_dump: ["inactive", "disabled"] }, at(6)),
    );
    expect(store.notices.get("database_dump")?.watchedSince).toBeNull();
  });
});
