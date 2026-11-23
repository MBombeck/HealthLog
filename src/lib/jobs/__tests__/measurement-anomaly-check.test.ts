import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  preferences: vi.fn(),
  users: vi.fn(),
  illness: vi.fn(),
  told: vi.fn(),
  shifts: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/insights/derived/changepoint", () => ({
  buildExtendedChangepointSignals: m.shifts,
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(async () => ({})),
}));
vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: m.claim,
}));
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: m.dispatch,
}));

import {
  anomalyTapUrl,
  FRESH_BREAK_DAYS,
  pickFreshShift,
  runMeasurementAnomalyTick,
} from "../measurement-anomaly-check";

const prisma = {
  notificationPreference: { findMany: m.preferences },
  user: { findMany: m.users },
  illnessEpisode: { findFirst: m.illness },
  notificationEvent: { findFirst: m.told, deleteMany: m.release },
} as unknown as Parameters<typeof runMeasurementAnomalyTick>[1];

// 10:15 in Berlin (winter, UTC+1).
const AT_TEN = new Date("2026-11-21T09:15:00.000Z");
const shift = (breakDate: string, magnitude = 3) => ({
  metric: "RESTING_HEART_RATE" as const,
  breakDate,
  direction: "up" as const,
  magnitude,
  beforeMean: 55,
  afterMean: 61,
  beforeDays: 40,
  afterDays: 12,
});

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.preferences.mockResolvedValue([{ channel: { userId: "u1" } }]);
  m.users.mockResolvedValue([
    { id: "u1", timezone: "Europe/Berlin", locale: "en" },
  ]);
  m.illness.mockResolvedValue(null);
  m.told.mockResolvedValue(null);
  m.shifts.mockResolvedValue([shift("2026-11-09")]);
  m.claim.mockResolvedValue(true);
  m.dispatch.mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  });
});

describe("anomalyTapUrl", () => {
  it("opens the metric's own page, and nothing for a type without one", () => {
    expect(anomalyTapUrl("RESTING_HEART_RATE")).toEqual({
      url: "/insights/resting-pulse",
    });
    expect(anomalyTapUrl("WEIGHT")).toEqual({ url: "/insights/weight" });
    expect(anomalyTapUrl("RECOVERY_SCORE")).toEqual({});
  });
});

describe("pickFreshShift", () => {
  it("keeps only a break within the fresh window, strongest first", () => {
    const old = shift("2026-09-01", 9);
    const weak = shift("2026-11-15", 2);
    const strong = { ...shift("2026-11-10", 4), metric: "WEIGHT" as const };
    expect(pickFreshShift([old, weak, strong], "2026-11-21")).toBe(strong);
    expect(pickFreshShift([old], "2026-11-21")).toBeNull();
    const edge = shift("2026-10-31");
    expect(pickFreshShift([edge], "2026-11-21")).toBe(edge);
    expect(FRESH_BREAK_DAYS).toBe(21);
  });
});

describe("runMeasurementAnomalyTick", () => {
  it("tells an opted-in person about a fresh shift in their morning", async () => {
    const result = await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0 });
    expect(m.release).not.toHaveBeenCalled();
    const payload = m.dispatch.mock.calls[0][0];
    expect(payload.eventType).toBe("MEASUREMENT_ANOMALY");
    expect(payload.message).toBe(
      "Resting heart rate has stayed higher since Nov 9. Insights shows the before and after.",
    );
  });

  it("stays quiet outside the morning hour", async () => {
    const result = await runMeasurementAnomalyTick(
      new Date("2026-11-21T20:00:00.000Z"),
      prisma,
    );
    expect(result.scanned).toBe(0);
    expect(m.shifts).not.toHaveBeenCalled();
  });

  it("never scans without an opt-in", async () => {
    m.preferences.mockResolvedValue([]);
    await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(m.users).not.toHaveBeenCalled();
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("says nothing during an open illness", async () => {
    m.illness.mockResolvedValue({ id: "ep1" });
    await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("tells a shift once, and never burns the week on one already told", async () => {
    m.told.mockResolvedValue({ id: "e1" });
    await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("holds to one push a week", async () => {
    m.claim.mockResolvedValue(false);
    await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.claim.mock.calls[0][1].dedupKey).toBe("week");
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("hands the week back and counts the person when no channel delivered", async () => {
    m.dispatch.mockResolvedValue({
      dispatched: false,
      channelsAttempted: 2,
      channelsSucceeded: 0,
    });
    const result = await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1 });
    const released = m.release.mock.calls.map((c) => c[0].where.dedupKey);
    expect(released).toEqual(["week", "shift:RESTING_HEART_RATE:up"]);
  });

  it("hands the week back without counting a failure when no channel was tried", async () => {
    m.dispatch.mockResolvedValue({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    const result = await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0 });
    expect(m.release).toHaveBeenCalledTimes(2);
  });

  it("hands the week back and carries on when the notice throws", async () => {
    m.dispatch.mockRejectedValue(new Error("boom"));
    const result = await runMeasurementAnomalyTick(AT_TEN, prisma);
    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1 });
    expect(m.release).toHaveBeenCalledTimes(2);
  });
});
