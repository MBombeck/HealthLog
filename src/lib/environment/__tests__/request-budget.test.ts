/**
 * v1.42 (#615) — the instance-wide Open-Meteo request budget.
 *
 * The weight rule (the hosted pricing formula), the three windows checked
 * together, a window that expired starting over, and the transaction that
 * charges all three windows or none.
 */
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(
  () => new Map<string, { count: number; resetAt: Date }>(),
);
vi.mock("@/lib/db", () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    rateLimit: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
        args.where.key.in
          .filter((key) => store.has(key))
          .map((key) => ({ key, ...store.get(key)! })),
      ),
      upsert: vi.fn(
        async (args: {
          where: { key: string };
          create: { count: number; resetAt: Date };
        }) => {
          store.set(args.where.key, {
            count: args.create.count,
            resetAt: args.create.resetAt,
          });
        },
      ),
    },
  };
  return {
    prisma: {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import {
  OPEN_METEO_BUDGET_WINDOWS,
  admitWeight,
  openMeteoCallWeight,
  reserveOpenMeteoCalls,
  type BudgetBucket,
} from "../request-budget";

const NOW = new Date("2026-10-08T02:10:00Z");

describe("call weight", () => {
  it("follows the hosted rule: more than 10 variables or 14 days weighs more", () => {
    expect(openMeteoCallWeight(3, 1)).toBe(1);
    expect(openMeteoCallWeight(10, 14)).toBe(1);
    expect(openMeteoCallWeight(15, 14)).toBe(1.5);
    expect(openMeteoCallWeight(17, 90)).toBeCloseTo(10.93, 2);
    expect(openMeteoCallWeight(12, 730)).toBeCloseTo(62.57, 2);
  });
});

describe("admitWeight", () => {
  it("admits into empty windows and stamps each window's reset", () => {
    const decision = admitWeight(new Map(), 150, NOW);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    for (const w of OPEN_METEO_BUDGET_WINDOWS) {
      expect(decision.next.get(w.name)).toEqual({
        count: 150,
        resetAt: new Date(NOW.getTime() + w.windowMs),
      });
    }
  });

  it("refuses when the day is full even though the minute and hour are not", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    const buckets = new Map<"minute" | "hour" | "day", BudgetBucket>([
      ["day", { count: 8_000 * 100 - 50, resetAt: later }],
    ]);
    expect(admitWeight(buckets, 49, NOW).admitted).toBe(true);
    expect(admitWeight(buckets, 51, NOW)).toEqual({
      admitted: false,
      window: "day",
    });
  });

  it("starts a window over once it has expired", () => {
    const expired = new Date(NOW.getTime() - 1);
    const buckets = new Map<"minute" | "hour" | "day", BudgetBucket>([
      ["minute", { count: 500 * 100, resetAt: expired }],
    ]);
    const decision = admitWeight(buckets, 100, NOW);
    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.next.get("minute")!.count).toBe(100);
    }
  });
});

describe("reserveOpenMeteoCalls", () => {
  it("charges every window, and charges nothing once one is full", async () => {
    store.clear();
    expect(await reserveOpenMeteoCalls(1.7)).toBe(true);
    expect(store.get("open-meteo-budget:day")!.count).toBe(170);
    expect(store.get("open-meteo-budget:minute")!.count).toBe(170);

    // Fill the minute to the brim: the next call is refused and the hour
    // and the day are not charged for it.
    const minute = store.get("open-meteo-budget:minute")!;
    store.set("open-meteo-budget:minute", { ...minute, count: 500 * 100 });
    const dayBefore = store.get("open-meteo-budget:day")!.count;
    expect(await reserveOpenMeteoCalls(1)).toBe(false);
    expect(store.get("open-meteo-budget:day")!.count).toBe(dayBefore);
  });
});
