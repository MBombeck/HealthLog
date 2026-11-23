/**
 * v1.25 — on-write sustained fever / low-SpO2 escalation (finding H-CS1).
 *
 * The retrospective correlation detector classifies a 3-day fever or sustained
 * low-SpO2 run as "seek care", but that escalation only fired when the user
 * opened the episode's correlation tab. These tests pin the on-write seam:
 * a sustained run escalates on INGEST through the SAME illness red-flag push,
 * with the SAME run length (RED_FLAG_RUN_DAYS) and absolute floors the detector
 * uses, and the 24h record-event dedupe stops a 4th reading re-firing the alarm.
 *
 * Calendar-day bucketing runs against TZ=UTC (the gate's contract).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory event claims so the 24h dedupe behaves across calls. */
const ledger: Array<{
  recordUserId: string;
  eventType: string;
  dedupKey: string;
  createdAt: Date;
}> = [];
const measurementFindMany = vi.fn();
const dispatchMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (...a: unknown[]) => measurementFindMany(...a),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ managedProfileAt: null }),
    },
  },
}));

// The daily extremes fold in SQL; the fake folds the rows `findMany` serves.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addMeta: vi.fn(), addWarning: vi.fn() }),
}));

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: (...a: unknown[]) => dispatchMock(...a),
}));

vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: (
    _prisma: unknown,
    input: {
      recordUserId: string;
      eventType: string;
      dedupKey: string;
      since: Date;
    },
  ) => {
    const existing = ledger.find(
      (event) =>
        event.recordUserId === input.recordUserId &&
        event.eventType === input.eventType &&
        event.dedupKey === input.dedupKey &&
        event.createdAt >= input.since,
    );
    if (existing) return Promise.resolve(false);
    ledger.push({ ...input, createdAt: new Date() });
    return Promise.resolve(true);
  },
}));

import { runSafetyFloorCheck } from "../safety-floor-check";

/** A measured-at on a given UTC calendar day, mid-morning. */
function utcDay(day: string): Date {
  return new Date(`${day}T08:00:00Z`);
}

beforeEach(() => {
  ledger.length = 0;
  measurementFindMany.mockReset();
  dispatchMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("runSafetyFloorCheck — sustained fever", () => {
  it("escalates once on a 3-day calendar-consecutive fever run", async () => {
    // °C ≥ 38.5 on three consecutive UTC days.
    measurementFindMany.mockResolvedValue([
      { value: 39.0, measuredAt: utcDay("2026-01-03") },
      { value: 39.1, measuredAt: utcDay("2026-01-02") },
      { value: 38.8, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.0,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const opts = dispatchMock.mock.calls[0][0];
    expect(opts.eventType).toBe("SYSTEM_ALERT");
    expect(opts.urgent).toBe(true);
    expect(opts.titleKey).toBe("illness.correlation.redFlagTitle");
    expect(opts.messageKey).toBe("illness.correlation.redFlagFever");
  });

  it("does not re-fire on a 4th reading inside the dedupe window", async () => {
    measurementFindMany.mockResolvedValue([
      { value: 39.0, measuredAt: utcDay("2026-01-03") },
      { value: 39.1, measuredAt: utcDay("2026-01-02") },
      { value: 38.8, measuredAt: utcDay("2026-01-01") },
    ]);

    // First ingest — fires.
    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.0,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });
    // A later same-day reading — run still holds, but the ledger anchor dedupes.
    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.2,
          measuredAt: new Date("2026-01-03T20:00:00Z"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT escalate on a 2-day fever run (below RED_FLAG_RUN_DAYS)", async () => {
    measurementFindMany.mockResolvedValue([
      { value: 39.0, measuredAt: utcDay("2026-01-02") },
      { value: 38.9, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.0,
          measuredAt: utcDay("2026-01-02"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does NOT escalate on three NON-consecutive febrile days", async () => {
    measurementFindMany.mockResolvedValue([
      { value: 39.0, measuredAt: utcDay("2026-01-05") },
      { value: 39.0, measuredAt: utcDay("2026-01-03") },
      { value: 39.0, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.0,
          measuredAt: utcDay("2026-01-05"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does NOT escalate when the run sits below the fever floor", async () => {
    // 38.0 °C < 38.5 °C floor — elevated but not the escalation band.
    measurementFindMany.mockResolvedValue([
      { value: 38.0, measuredAt: utcDay("2026-01-03") },
      { value: 38.0, measuredAt: utcDay("2026-01-02") },
      { value: 38.0, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 38.0,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("runSafetyFloorCheck — sustained low SpO2", () => {
  it("escalates once on a 3-day calendar-consecutive low-SpO2 run", async () => {
    // ≤ 92% on three consecutive UTC days (per-day MIN is the worst).
    measurementFindMany.mockResolvedValue([
      { value: 89, measuredAt: utcDay("2026-01-03") },
      { value: 91, measuredAt: utcDay("2026-01-02") },
      { value: 92, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "OXYGEN_SATURATION",
          value: 89,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const opts = dispatchMock.mock.calls[0][0];
    expect(opts.titleKey).toBe("illness.correlation.redFlagTitle");
    expect(opts.messageKey).toBe("illness.correlation.redFlagSpo2");
  });

  it("does NOT escalate when a single day recovers above the floor", async () => {
    measurementFindMany.mockResolvedValue([
      { value: 89, measuredAt: utcDay("2026-01-03") },
      { value: 96, measuredAt: utcDay("2026-01-02") }, // breaks the run
      { value: 90, measuredAt: utcDay("2026-01-01") },
    ]);

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "OXYGEN_SATURATION",
          value: 89,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("a fever escalation never suppresses a concurrent SpO2 one (distinct dedupe keys)", async () => {
    // Two independent runs landing on the same write: both should fire once.
    measurementFindMany.mockImplementation(
      ({ where }: { where: { type: string } }) => {
        if (where.type === "BODY_TEMPERATURE") {
          return Promise.resolve([
            { value: 39.0, measuredAt: utcDay("2026-01-03") },
            { value: 39.0, measuredAt: utcDay("2026-01-02") },
            { value: 39.0, measuredAt: utcDay("2026-01-01") },
          ]);
        }
        return Promise.resolve([
          { value: 89, measuredAt: utcDay("2026-01-03") },
          { value: 90, measuredAt: utcDay("2026-01-02") },
          { value: 91, measuredAt: utcDay("2026-01-01") },
        ]);
      },
    );

    await runSafetyFloorCheck({
      userId: "u1",
      written: [
        {
          type: "BODY_TEMPERATURE",
          value: 39.0,
          measuredAt: utcDay("2026-01-03"),
        },
        {
          type: "OXYGEN_SATURATION",
          value: 89,
          measuredAt: utcDay("2026-01-03"),
        },
      ],
      timezone: "UTC",
    });

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const keys = dispatchMock.mock.calls.map((c) => c[0].messageKey).sort();
    expect(keys).toEqual([
      "illness.correlation.redFlagFever",
      "illness.correlation.redFlagSpo2",
    ]);
  });
});
