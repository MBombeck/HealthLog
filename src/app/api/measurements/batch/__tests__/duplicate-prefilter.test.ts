/**
 * v1.42 — the exact-duplicate prefilter, the `folded_window` guard, and what
 * a batch of duplicates only no longer sets off.
 *
 * The route runs against an in-memory `measurements` table and a reconciler
 * stand-in that answers from it the way `reconcileExternalMeasurement` does
 * for samples (external and natural identity, live or tombstoned). The golden
 * comparison runs every batch twice: once as shipped, once with the
 * prefilter's read answering nothing, which is the pre-v1.42 path where every
 * row went through the reconciler. Statuses, reasons and counters must match
 * exactly; only the transaction count may differ.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

interface StoredRow {
  id: string;
  userId: string;
  type: string;
  source: string;
  externalId: string | null;
  measuredAt: Date;
  sleepStage: string | null;
  value: number;
  deletedAt: Date | null;
}

const store = vi.hoisted(() => ({
  rows: [] as StoredRow[],
  /** Golden mode: the prefilter's read answers nothing. */
  prefilterBlind: false,
  nextId: 1,
}));

function sameInstant(a: Date, b: Date) {
  return a.getTime() === b.getTime();
}

vi.mock("@/lib/db", () => {
  const prisma = {
    user: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }),
    },
    measurement: {
      findMany: vi.fn(
        async (args: {
          where: {
            userId: string;
            OR?: unknown;
            deletedAt?: null;
            type?: { in: string[] };
            source?: string;
            externalId?: { in: string[] };
          };
        }) => {
          const where = args.where;
          // Cross-source merge probe: these suites post no MANUAL twins.
          if (where.OR) return [];
          const ids = where.externalId?.in ?? [];
          // The `folded_window` lookup: live `stats:` rows by id.
          if (where.deletedAt === null) {
            return store.rows.filter(
              (r) =>
                r.userId === where.userId &&
                r.deletedAt === null &&
                r.source === where.source &&
                (where.type?.in ?? []).includes(r.type) &&
                r.externalId !== null &&
                ids.includes(r.externalId),
            );
          }
          // The prefilter: every row, live or not, carrying a posted id.
          if (store.prefilterBlind) return [];
          return store.rows.filter(
            (r) =>
              r.userId === where.userId &&
              r.externalId !== null &&
              ids.includes(r.externalId),
          );
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  return { prisma };
});

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: async (
    _tx: unknown,
    desired: {
      userId: string;
      type: string;
      source: string;
      externalId: string;
      measuredAt: Date;
      sleepStage?: string | null;
      value: number;
    },
    options: { exactExternalMatch?: "update" | "duplicate" } = {},
  ) => {
    const scope = store.rows.filter(
      (r) =>
        r.userId === desired.userId &&
        r.type === desired.type &&
        r.source === desired.source,
    );
    const externalHit = scope.find((r) => r.externalId === desired.externalId);
    const naturalHit = scope.find(
      (r) =>
        sameInstant(r.measuredAt, desired.measuredAt) &&
        r.sleepStage === (desired.sleepStage ?? null),
    );
    if (!externalHit && !naturalHit) {
      const row: StoredRow = {
        id: `m${store.nextId++}`,
        userId: desired.userId,
        type: desired.type,
        source: desired.source,
        externalId: desired.externalId,
        measuredAt: desired.measuredAt,
        sleepStage: desired.sleepStage ?? null,
        value: desired.value,
        deletedAt: null,
      };
      store.rows.push(row);
      return { status: "inserted", row };
    }
    const canonical = (externalHit ?? naturalHit)!;
    const redundant =
      externalHit && naturalHit && externalHit !== naturalHit
        ? naturalHit
        : undefined;
    if (
      options.exactExternalMatch === "duplicate" &&
      externalHit === naturalHit
    ) {
      return { status: "duplicate", row: canonical };
    }
    if (redundant) {
      redundant.deletedAt = new Date();
      redundant.measuredAt = new Date(0);
    }
    const wasDeleted = canonical.deletedAt !== null;
    canonical.externalId = desired.externalId;
    canonical.measuredAt = desired.measuredAt;
    canonical.sleepStage = desired.sleepStage ?? null;
    canonical.value = desired.value;
    canonical.deletedAt = null;
    return {
      status: wasDeleted ? "resurrected" : "updated",
      row: canonical,
      dirtyIdentities: [],
    };
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

const USER = "user-1";
const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Entry {
  hkIdentifier: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  externalId: string;
  sleepStage?: number;
  source?: "APPLE_HEALTH" | "MANUAL";
}

function weight(externalId: string, at: Date, value = 80): Entry {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
    value,
    unit: "kg",
    startDate: at.toISOString(),
    endDate: at.toISOString(),
    externalId,
  };
}

function pulse(externalId: string, at: Date, value = 60): Entry {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: at.toISOString(),
    endDate: at.toISOString(),
    externalId,
  };
}

function seed(row: Partial<StoredRow> & { externalId: string; type: string }) {
  store.rows.push({
    id: `seed${store.nextId++}`,
    userId: USER,
    source: "APPLE_HEALTH",
    measuredAt: new Date(NOW - DAY),
    sleepStage: null,
    value: 80,
    deletedAt: null,
    ...row,
  });
}

function request(entries: Entry[], syncTrigger?: string) {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries, ...(syncTrigger ? { syncTrigger } : {}) }),
  });
}

type Body = {
  data: {
    processed: number;
    inserted: number;
    updated: number;
    duplicates: number;
    failed: number;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
};

async function post(entries: Entry[], syncTrigger?: string) {
  const res = await POST(request(entries, syncTrigger));
  expect(res.status).toBe(200);
  return ((await res.json()) as Body).data;
}

/** Run a batch on a copy of the store as shipped and on a copy without the prefilter. */
async function golden(setup: () => void, entries: Entry[]) {
  store.rows = [];
  store.nextId = 1;
  setup();
  store.prefilterBlind = true;
  vi.mocked(prisma.$transaction).mockClear();
  const old = await post(entries);
  const oldTransactions = vi.mocked(prisma.$transaction).mock.calls.length;
  const oldRows = JSON.stringify(store.rows);

  store.rows = [];
  store.nextId = 1;
  setup();
  store.prefilterBlind = false;
  vi.mocked(prisma.$transaction).mockClear();
  const next = await post(entries);
  const transactions = vi.mocked(prisma.$transaction).mock.calls.length;
  expect(next).toEqual(old);
  expect(JSON.stringify(store.rows)).toBe(oldRows);
  return { old, next, oldTransactions, transactions };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.prefilterBlind = false;
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "s", expiresAt: new Date(NOW + HOUR) },
    user: { id: USER, username: "u", role: "USER" as const },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 60,
    resetAt: NOW + 60_000,
  });
});

describe("exact-duplicate prefilter (v1.42)", () => {
  it("1: 500 exact live duplicates open no transaction and answer as before", async () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      weight(`uuid-${i}`, new Date(NOW - DAY - i * 60_000)),
    );
    const setup = () =>
      entries.forEach((e) =>
        seed({
          type: "WEIGHT",
          externalId: e.externalId,
          measuredAt: new Date(e.endDate),
        }),
      );
    const { next, oldTransactions, transactions } = await golden(
      setup,
      entries,
    );
    expect(next.duplicates).toBe(500);
    expect(oldTransactions).toBe(500);
    expect(transactions).toBe(0);
  });

  it("2: an exact hit on a tombstone stays a duplicate and the row stays deleted", async () => {
    const at = new Date(NOW - DAY);
    const setup = () =>
      seed({
        type: "WEIGHT",
        externalId: "uuid-gone",
        measuredAt: at,
        deletedAt: new Date(NOW - HOUR),
      });
    const { next, transactions } = await golden(setup, [
      weight("uuid-gone", at),
    ]);
    expect(next.entries[0]).toEqual({ index: 0, status: "duplicate" });
    expect(transactions).toBe(0);
    expect(store.rows[0].deletedAt).not.toBeNull();
  });

  it("3: the same id at another instant still reconciles to `updated`", async () => {
    const setup = () =>
      seed({
        type: "WEIGHT",
        externalId: "uuid-move",
        measuredAt: new Date(NOW - 2 * DAY),
      });
    const { next, transactions } = await golden(setup, [
      weight("uuid-move", new Date(NOW - DAY)),
    ]);
    expect(next.entries[0].status).toBe("updated");
    expect(transactions).toBe(1);
  });

  it("4: the same id with another sleep stage still reconciles", async () => {
    const at = new Date(NOW - DAY);
    const setup = () =>
      seed({
        type: "SLEEP_DURATION",
        externalId: "uuid-sleep",
        measuredAt: at,
        sleepStage: "DEEP",
        value: 30,
      });
    const entry: Entry = {
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 30,
      unit: "min",
      startDate: new Date(at.getTime() - 30 * 60_000).toISOString(),
      endDate: at.toISOString(),
      externalId: "uuid-sleep",
      sleepStage: 3,
    };
    const { transactions } = await golden(setup, [entry]);
    expect(transactions).toBe(1);
  });

  it("5: `stats:` rows are never prefiltered; a second snapshot is superseded", async () => {
    const day = new Date(NOW - DAY).toISOString().slice(0, 10);
    const id = `stats:HKQuantityTypeIdentifierStepCount:${day}`;
    const steps = (value: number): Entry => ({
      hkIdentifier: "HKQuantityTypeIdentifierStepCount",
      value,
      unit: "count",
      startDate: `${day}T00:00:00.000Z`,
      endDate: `${day}T18:00:00.000Z`,
      externalId: id,
    });
    const setup = () =>
      seed({
        type: "ACTIVITY_STEPS",
        externalId: id,
        measuredAt: new Date(`${day}T18:00:00.000Z`),
        value: 1000,
      });
    const { next, transactions } = await golden(setup, [
      steps(2000),
      steps(3000),
    ]);
    expect(next.entries).toEqual([
      { index: 0, status: "duplicate", reason: "superseded_in_batch" },
      { index: 1, status: "updated" },
    ]);
    expect(transactions).toBe(1);
  });

  it("6: an id twice in the batch and not stored inserts once, then duplicates", async () => {
    const at = new Date(NOW - DAY);
    const { next } = await golden(() => {}, [
      weight("uuid-twice", at),
      weight("uuid-twice", at),
    ]);
    expect(next.entries.map((e) => e.status)).toEqual([
      "inserted",
      "duplicate",
    ]);
  });

  it("6b: a stored id posted twice is left to the reconciler", async () => {
    const at = new Date(NOW - DAY);
    const setup = () =>
      seed({ type: "WEIGHT", externalId: "uuid-twice", measuredAt: at });
    const { transactions } = await golden(setup, [
      weight("uuid-twice", at),
      weight("uuid-twice", at),
    ]);
    expect(transactions).toBe(2);
  });

  it("9: the same id held by another account is not a duplicate", async () => {
    const at = new Date(NOW - DAY);
    const setup = () =>
      seed({
        type: "WEIGHT",
        externalId: "uuid-shared",
        measuredAt: at,
        userId: "user-2",
      });
    const { next } = await golden(setup, [weight("uuid-shared", at)]);
    expect(next.entries[0].status).toBe("inserted");
  });

  it("10: an all-duplicate batch still sets the sync checkpoint", async () => {
    const at = new Date(NOW - DAY);
    seed({ type: "WEIGHT", externalId: "uuid-dup", measuredAt: at });
    await post([weight("uuid-dup", at)], "background");
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: {
        lastSyncedAt: expect.any(Date),
        healthKitLastSyncedAt: expect.any(Date),
        healthKitLastSyncTrigger: "background",
        healthKitLastBackgroundSyncAt: expect.any(Date),
      },
    });
  });
});

describe("a batch of duplicates only (v1.42)", () => {
  it("enqueues no PR detection, no reminder sweep and writes no detection audit row", async () => {
    const at = new Date(NOW - DAY);
    seed({ type: "WEIGHT", externalId: "uuid-dup", measuredAt: at });
    await post([weight("uuid-dup", at)]);
    expect(enqueuePrDetection).not.toHaveBeenCalled();
    expect(enqueueReminderSatisfy).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(auditLog)
        .mock.calls.some(
          ([action]) => action === "personal_records.detection_enqueued",
        ),
    ).toBe(false);
  });

  it("still enqueues all three when a row was written", async () => {
    await post([weight("uuid-new", new Date(NOW - DAY))]);
    expect(enqueuePrDetection).toHaveBeenCalledTimes(1);
    expect(enqueueReminderSatisfy).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(auditLog)
        .mock.calls.some(
          ([action]) => action === "personal_records.detection_enqueued",
        ),
    ).toBe(true);
  });
});

describe("cache invalidation by origin (v1.42)", () => {
  it.each([
    ["foreground", { evict: true }],
    ["manual", { evict: true }],
    ["background", undefined],
    ["push", undefined],
    [undefined, undefined],
  ])("syncTrigger %s → %o", async (trigger, expected) => {
    await post([weight(`uuid-${trigger}`, new Date(NOW - DAY))], trigger);
    expect(invalidateUserMeasurements).toHaveBeenCalledWith(USER, expected);
  });

  it("evicts for a background batch that wrote a hand-entered reading", async () => {
    await post(
      [
        {
          ...weight("manual-1", new Date(NOW - DAY)),
          source: "MANUAL",
        },
      ],
      "background",
    );
    expect(invalidateUserMeasurements).toHaveBeenCalledWith(USER, {
      evict: true,
    });
  });
});

describe("folded_window guard (v1.42)", () => {
  // Europe/Berlin is UTC+1 in winter and UTC+2 in summer; the store's
  // account zone is Berlin. 120 days back is past the 90-day dense window.
  const old = new Date(NOW - 120 * DAY);
  const localHourId = () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(old);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `stats:HKQuantityTypeIdentifierHeartRate:${get("year")}-${get("month")}-${get("day")}T${hour}`;
  };

  it("12a: an old raw sample under a live hourly `stats:` row is a folded duplicate", async () => {
    seed({
      type: "PULSE",
      externalId: localHourId(),
      measuredAt: new Date(old.getTime() + 1),
    });
    const data = await post([pulse("uuid-old-hr", old)]);
    expect(data.entries[0]).toEqual({
      index: 0,
      status: "duplicate",
      reason: "folded_window",
    });
    expect(store.rows.some((r) => r.externalId === "uuid-old-hr")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("12b: without a covering `stats:` row it is inserted", async () => {
    const data = await post([pulse("uuid-old-hr", old)]);
    expect(data.entries[0].status).toBe("inserted");
  });

  it("12b': a tombstoned `stats:` row does not cover", async () => {
    seed({
      type: "PULSE",
      externalId: localHourId(),
      measuredAt: new Date(old.getTime() + 1),
      deletedAt: new Date(),
    });
    const data = await post([pulse("uuid-old-hr", old)]);
    expect(data.entries[0].status).toBe("inserted");
  });

  it("12c: a mean-type sample younger than 36 h is inserted even under a daily row", async () => {
    const recent = new Date(NOW - 2 * HOUR);
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(recent);
    seed({
      type: "RESPIRATORY_RATE",
      externalId: `stats:HKQuantityTypeIdentifierRespiratoryRate:${day}`,
      measuredAt: new Date(recent.getTime() + 1),
    });
    const data = await post([
      {
        hkIdentifier: "HKQuantityTypeIdentifierRespiratoryRate",
        value: 14,
        unit: "count/min",
        startDate: recent.toISOString(),
        endDate: recent.toISOString(),
        externalId: "uuid-rr",
      },
    ]);
    expect(data.entries[0].status).toBe("inserted");
  });

  it("does not touch a MANUAL reading of the same instant", async () => {
    seed({
      type: "PULSE",
      externalId: localHourId(),
      measuredAt: new Date(old.getTime() + 1),
    });
    const data = await post([{ ...pulse("manual-hr", old), source: "MANUAL" }]);
    expect(data.entries[0].status).toBe("inserted");
  });
});
