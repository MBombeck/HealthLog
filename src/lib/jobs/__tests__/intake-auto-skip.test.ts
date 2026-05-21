/**
 * v1.4.46 — coverage for the hourly intake-auto-skip helper.
 *
 * The helper runs a single `updateMany` against `MedicationIntakeEvent`
 * with the `skipped = false AND takenAt IS NULL AND scheduledFor < cutoff`
 * gate, where `cutoff = now - 24 h`. These tests pin:
 *   * cron + queue contract (constants don't drift),
 *   * cutoff is `now - 24 h` exactly (off-by-one safety),
 *   * Prisma `updateMany` is called with the spec'd shape,
 *   * idempotency-by-construction (a second pass on the same state
 *     finds zero candidates because the predicate has already flipped
 *     them).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

import {
  INTAKE_AUTO_SKIP_CRON,
  INTAKE_AUTO_SKIP_GRACE_HOURS,
  INTAKE_AUTO_SKIP_QUEUE,
  runIntakeAutoSkipPass,
} from "../intake-auto-skip";

interface FakeIntakeRow {
  id: string;
  userId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
}

interface FakeUpdateManyWhere {
  skipped?: boolean;
  takenAt?: null;
  scheduledFor?: { lt: Date };
}

function makeFakePrisma(state: { rows: FakeIntakeRow[] }) {
  return {
    medicationIntakeEvent: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: FakeUpdateManyWhere;
          data: { skipped: boolean };
        }) => {
          let count = 0;
          for (const row of state.rows) {
            if (where.skipped !== undefined && row.skipped !== where.skipped)
              continue;
            if (where.takenAt === null && row.takenAt !== null) continue;
            if (
              where.scheduledFor?.lt !== undefined &&
              row.scheduledFor.getTime() >= where.scheduledFor.lt.getTime()
            )
              continue;
            row.skipped = data.skipped;
            count += 1;
          }
          return { count };
        },
      ),
    },
  } as unknown as PrismaClient;
}

const NOW = new Date("2026-05-22T12:00:00Z");
const NOW_MS = NOW.getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("intake-auto-skip — schedule contract", () => {
  it("cron fires hourly at :05 to dodge the :00 reminder-check tick", () => {
    expect(INTAKE_AUTO_SKIP_CRON).toBe("5 * * * *");
  });

  it("queue name stays stable so the scheduler entry doesn't desync", () => {
    expect(INTAKE_AUTO_SKIP_QUEUE).toBe("intake-auto-skip");
  });

  it("grace window is exactly 24 hours", () => {
    expect(INTAKE_AUTO_SKIP_GRACE_HOURS).toBe(24);
  });
});

describe("runIntakeAutoSkipPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips pending rows older than 24 h to skipped=true", async () => {
    const rows: FakeIntakeRow[] = [
      // Stale + unmarked → must flip.
      {
        id: "i-stale-1",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 30 * HOUR_MS),
        takenAt: null,
        skipped: false,
      },
      // Stale + unmarked (different user) → must flip.
      {
        id: "i-stale-2",
        userId: "u2",
        scheduledFor: new Date(NOW_MS - 48 * HOUR_MS),
        takenAt: null,
        skipped: false,
      },
      // Recent (< 24 h) → must stay pending.
      {
        id: "i-recent",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 6 * HOUR_MS),
        takenAt: null,
        skipped: false,
      },
      // Already taken → must stay.
      {
        id: "i-taken",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 36 * HOUR_MS),
        takenAt: new Date(NOW_MS - 30 * HOUR_MS),
        skipped: false,
      },
      // Already manually skipped → must stay.
      {
        id: "i-already-skipped",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 48 * HOUR_MS),
        takenAt: null,
        skipped: true,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect(result.skippedCount).toBe(2);
    expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    expect(state.rows.find((r) => r.id === "i-stale-1")?.skipped).toBe(true);
    expect(state.rows.find((r) => r.id === "i-stale-2")?.skipped).toBe(true);
    expect(state.rows.find((r) => r.id === "i-recent")?.skipped).toBe(false);
    expect(state.rows.find((r) => r.id === "i-taken")?.skipped).toBe(false);
    expect(
      state.rows.find((r) => r.id === "i-already-skipped")?.skipped,
    ).toBe(true);
  });

  it("calls prisma.updateMany with the spec'd where + data shape", async () => {
    const state = { rows: [] as FakeIntakeRow[] };
    const prisma = makeFakePrisma(state);

    await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledWith({
      where: {
        skipped: false,
        takenAt: null,
        scheduledFor: { lt: new Date(NOW_MS - DAY_MS) },
      },
      data: { skipped: true },
    });
  });

  it("is idempotent — a second pass on the same state finds zero candidates", async () => {
    const rows: FakeIntakeRow[] = [
      {
        id: "i-stale",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 30 * HOUR_MS),
        takenAt: null,
        skipped: false,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const first = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(first.skippedCount).toBe(1);

    const second = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(second.skippedCount).toBe(0);
  });

  it("does NOT flip rows exactly at the 24 h boundary (uses strict <)", async () => {
    // The SQL gate is `scheduledFor < NOW - 24h` — a row whose
    // `scheduledFor` lands at the cutoff instant must stay pending so
    // the user still has the closing minute of the window to mark it.
    const rows: FakeIntakeRow[] = [
      {
        id: "i-boundary",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - DAY_MS),
        takenAt: null,
        skipped: false,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(state.rows[0].skipped).toBe(false);
  });

  it("uses Date.now() when no nowMs override is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const state = { rows: [] as FakeIntakeRow[] };
      const prisma = makeFakePrisma(state);

      const result = await runIntakeAutoSkipPass(prisma);
      expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
