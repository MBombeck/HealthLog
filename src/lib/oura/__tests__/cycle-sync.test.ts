/**
 * `syncUserOuraCyclePhases` — Oura Cycle Insights → CycleDayLog, subordinate
 * to any existing row. The core invariant under test: a day that already
 * carries ANY CycleDayLog row (regardless of source) is never touched —
 * Oura only ever fills a genuinely empty day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchCyclePhasesMock,
  isCycleAvailableMock,
  findUserMock,
  createMock,
  ensureCycleMock,
  owningCycleMock,
} = vi.hoisted(() => ({
  fetchCyclePhasesMock: vi.fn(),
  isCycleAvailableMock: vi.fn(),
  findUserMock: vi.fn(),
  createMock: vi.fn(),
  ensureCycleMock: vi.fn(),
  owningCycleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: findUserMock },
    cycleDayLog: { create: createMock },
  },
}));

vi.mock("@/lib/cycle/cycle-boundaries", () => ({
  ensureCycleForBleedingDay: ensureCycleMock,
}));

vi.mock("@/lib/cycle/cycle-attribution", () => ({
  findOwningCycleId: owningCycleMock,
}));

vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: isCycleAvailableMock,
}));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchDailyCyclePhases: fetchCyclePhasesMock,
  };
});

import { syncUserOuraCyclePhases } from "../cycle-sync";

const WINDOW = { startDate: "2026-09-20", endDate: "2026-09-27" };

function uniqueViolation() {
  const err = new Error("Unique constraint failed") as Error & {
    code: string;
  };
  err.code = "P2002";
  return err;
}

beforeEach(() => {
  fetchCyclePhasesMock.mockReset().mockResolvedValue([]);
  isCycleAvailableMock.mockReset().mockResolvedValue(true);
  findUserMock.mockReset().mockResolvedValue({ timezone: "Europe/Berlin" });
  createMock.mockReset().mockResolvedValue({ id: "cdl-1" });
  ensureCycleMock.mockReset().mockResolvedValue(null);
  owningCycleMock.mockReset().mockResolvedValue(null);
});

describe("syncUserOuraCyclePhases", () => {
  it("no-ops without touching the DB when the collection is empty", async () => {
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(0);
    expect(isCycleAvailableMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("no-ops when the series carries no derivable period day", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-08", phase: "luteal" },
      { day: "2026-06-09", phase: "luteal" },
    ]);
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(0);
    expect(isCycleAvailableMock).not.toHaveBeenCalled();
  });

  it("respects the two-layer cycle gate — no write when disabled", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    isCycleAvailableMock.mockResolvedValue(false);
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates a source=OURA flow=LIGHT row for a detected period day", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(1);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        date: "2026-06-05",
        tz: "Europe/Berlin",
        source: "OURA",
        flow: "LIGHT",
        cycleId: null,
      },
    });
  });

  it("attributes a created day to its cycle and lets a first bleeding day open one", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    owningCycleMock.mockResolvedValue("cycle-before");
    await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ cycleId: "cycle-before" }),
    });
    expect(ensureCycleMock).toHaveBeenCalledWith(
      "u1",
      "2026-06-05",
      "Europe/Berlin",
      { flow: "LIGHT", intermenstrualBleeding: false },
    );
    // The inference runs after the create, so the opened cycle claims it.
    expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(
      ensureCycleMock.mock.invocationCallOrder[0]!,
    );
  });

  it("infers no cycle from a day it did not create", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    createMock.mockRejectedValue(uniqueViolation());
    await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(ensureCycleMock).not.toHaveBeenCalled();
  });

  it("skips a day that already has ANY existing row (manual wins) — unique-violation swallowed silently", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    createMock.mockRejectedValue(uniqueViolation());
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(0);
  });

  it("never calls .update — a pre-existing row (its own or another source's) is left exactly as-is", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
      { day: "2026-06-06", phase: "menstrual" },
    ]);
    createMock
      .mockRejectedValueOnce(uniqueViolation()) // 06-05 already logged (manual)
      .mockResolvedValueOnce({ id: "cdl-2" }); // 06-06 genuinely empty
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-unique-violation write error without crashing the whole batch", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
      { day: "2026-06-06", phase: "menstrual" },
    ]);
    createMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ id: "cdl-2" });
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    // The failing day is skipped (warned, not thrown); the healthy sibling
    // still writes.
    expect(created).toBe(1);
  });

  it("propagates the Oura fetch error to the caller (the sync layer decides how to swallow it)", async () => {
    fetchCyclePhasesMock.mockRejectedValue(new Error("403 forbidden"));
    await expect(syncUserOuraCyclePhases("u1", "tok", WINDOW)).rejects.toThrow(
      "403 forbidden",
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to a null tz when the user row / timezone is unresolvable", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-05", phase: "menstrual" },
    ]);
    findUserMock.mockResolvedValue(null);
    await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tz: null }) }),
    );
  });

  it("creates one row per distinct detected day from a luteal→follicular transition", async () => {
    fetchCyclePhasesMock.mockResolvedValue([
      { day: "2026-06-08", phase: "luteal" },
      { day: "2026-06-09", phase: "follicular" },
    ]);
    const created = await syncUserOuraCyclePhases("u1", "tok", WINDOW);
    expect(created).toBe(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ date: "2026-06-09", flow: "LIGHT" }),
      }),
    );
  });
});
