/**
 * Golden comparison for the set-based insert in `POST /api/measurements/batch`.
 *
 * Fresh samples are inserted with one `INSERT … ON CONFLICT DO NOTHING` per
 * chunk; whatever that skips goes through the per-entry reconciler. The claim
 * is that this changes nothing a client can observe. The same batch is posted
 * for two accounts holding the same stored rows: once as the route runs, and
 * once with the set-based insert forced to fail, which sends every entry
 * through the reconciler (the route's own fallback). Per-entry outcomes and
 * the stored rows must be identical, across fresh samples, an exact stored
 * duplicate, a tombstoned sample, a `stats:` overwrite, an external id twice
 * in one batch, and a natural-key collision under a new external id.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const SET_USER = "golden-set-based";
const RECONCILER_USER = "golden-reconciler";

interface Entry {
  hkIdentifier: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  externalId: string;
}

function weight(externalId: string, at: string, value: number): Entry {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
    value,
    unit: "kg",
    startDate: at,
    endDate: at,
    externalId,
  };
}

function pulse(externalId: string, at: string, value: number): Entry {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: at,
    endDate: at,
    externalId,
  };
}

function steps(day: string, value: number): Entry {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value,
    unit: "count",
    startDate: `${day}T00:00:00.000Z`,
    endDate: `${day}T18:00:00.000Z`,
    externalId: `stats:HKQuantityTypeIdentifierStepCount:${day}`,
  };
}

/** What both accounts hold before the batch. */
const SEED: Entry[] = [
  weight("uuid-live", "2026-07-10T07:00:00.000Z", 80.1),
  weight("uuid-tomb", "2026-07-11T07:00:00.000Z", 80.4),
  weight("uuid-natural", "2026-07-12T07:00:00.000Z", 80.2),
  steps("2026-07-12", 5_000),
];

/** The batch under comparison. */
const BATCH: Entry[] = [
  weight("uuid-fresh-1", "2026-07-13T07:00:00.000Z", 79.9),
  pulse("uuid-fresh-2", "2026-07-13T08:00:00.000Z", 61),
  // Exactly what is stored.
  weight("uuid-live", "2026-07-10T07:00:00.000Z", 80.1),
  // A sample its owner deleted, sent again.
  weight("uuid-tomb", "2026-07-11T07:00:00.000Z", 80.4),
  // A day total HealthKit recomputed.
  steps("2026-07-12", 6_200),
  // One external id twice in the batch.
  pulse("uuid-twice", "2026-07-14T08:00:00.000Z", 63),
  pulse("uuid-twice", "2026-07-14T08:00:00.000Z", 63),
  // A new id on the instant and source of a stored reading.
  weight("uuid-natural-new", "2026-07-12T07:00:00.000Z", 80.3),
  weight("uuid-fresh-3", "2026-07-15T07:00:00.000Z", 79.7),
];

function request(entries: Entry[]): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

async function signIn(userId: string) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id: userId, username: userId, email: `${userId}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

type Outcome = { index: number; status: string; reason?: string };

async function post(entries: Entry[]): Promise<Outcome[]> {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(request(entries));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { entries: Outcome[] } };
  return body.data.entries.map(({ index, status, reason }) => ({
    index,
    status,
    ...(reason ? { reason } : {}),
  }));
}

async function seed(userId: string) {
  await signIn(userId);
  const outcomes = await post(SEED);
  expect(outcomes.every((o) => o.status === "inserted")).toBe(true);
  await getPrismaClient().measurement.updateMany({
    where: { userId, externalId: "uuid-tomb" },
    data: { deletedAt: new Date("2026-07-12T00:00:00Z") },
  });
}

async function storedRows(userId: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId },
    select: {
      type: true,
      source: true,
      value: true,
      unit: true,
      measuredAt: true,
      externalId: true,
      deletedAt: true,
    },
    orderBy: [{ externalId: "asc" }, { measuredAt: "asc" }],
  });
  return rows.map((r) => ({ ...r, deletedAt: r.deletedAt !== null }));
}

/**
 * Make the route's set-based insert fail, so every entry it buffered goes
 * through the reconciler instead. Only `createManyAndReturn` inside an
 * interactive transaction is refused; the reconciler never calls it.
 */
async function forceReconcilerPath() {
  const { prisma } = await import("@/lib/db");
  const original = prisma.$transaction.bind(prisma);
  let refused = 0;
  vi.spyOn(prisma, "$transaction").mockImplementation(((
    arg: unknown,
    options?: unknown,
  ) => {
    if (typeof arg !== "function") {
      return (original as (a: unknown, o?: unknown) => unknown)(arg, options);
    }
    return (original as (a: unknown, o?: unknown) => unknown)(
      (tx: Record<string, unknown>) =>
        (arg as (t: unknown) => unknown)(
          new Proxy(tx, {
            get(target, key) {
              const value = Reflect.get(target, key);
              if (key !== "measurement") return value;
              return new Proxy(value as object, {
                get(model, method) {
                  if (method === "createManyAndReturn") {
                    return async () => {
                      refused++;
                      throw new Error("set-based insert switched off");
                    };
                  }
                  return Reflect.get(model, method);
                },
              });
            },
          }),
        ),
      options,
    );
  }) as never);
  return () => refused;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("batch set-based insert matches the reconciler entry for entry", () => {
  it("answers and stores the same for both paths", async () => {
    await seed(SET_USER);
    const viaSet = await post(BATCH);

    cookieJar.clear();
    await seed(RECONCILER_USER);
    const refusals = await forceReconcilerPath();
    const viaReconciler = await post(BATCH);
    // The comparison only means something if the fallback really ran.
    expect(refusals()).toBeGreaterThan(0);

    expect(viaSet).toEqual(viaReconciler);
    expect(await storedRows(SET_USER)).toEqual(
      await storedRows(RECONCILER_USER),
    );

    // And the shared answer is the documented one for each case.
    const byIndex = new Map(viaSet.map((o) => [o.index, o.status]));
    expect(byIndex.get(0)).toBe("inserted");
    expect(byIndex.get(1)).toBe("inserted");
    expect(byIndex.get(2)).toBe("duplicate");
    expect(byIndex.get(4)).toBe("updated");
    expect([byIndex.get(5), byIndex.get(6)].sort()).toEqual([
      "duplicate",
      "inserted",
    ]);
    expect(byIndex.get(8)).toBe("inserted");
  });
});
