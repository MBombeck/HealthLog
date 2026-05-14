/**
 * v1.4.25 W17b/c — Migration 0055 composite-uniqueness contract.
 *
 * The Withings Sleep v2 sync writes one Measurement row per stage
 * segment (AWAKE | CORE | DEEP | REM) for the same night, sharing
 * (user_id, type=SLEEP_DURATION, measured_at, source=WITHINGS). The
 * legacy four-column composite collapsed them onto a single row;
 * Migration 0055 added `sleep_stage` as the fifth axis and recreated
 * the index with `NULLS NOT DISTINCT` so:
 *
 *   - per-stage rows for the same night now co-exist (one per stage)
 *   - non-sleep rows (sleep_stage IS NULL) still dedup on the first
 *     four columns alone — no behavioural change for every meastype
 *     other than SLEEP_DURATION
 *   - re-syncing the same night is idempotent (the stage label still
 *     anchors the upsert key)
 */
import { Prisma } from "@/generated/prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-sleep-stage-composite";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "sleep-stage-composite",
      email: "sleep-stage-composite@example.test",
    },
  });
});

describe("Migration 0055 — measurement composite with sleep_stage", () => {
  it("allows multiple sleep-stage rows for the same (user, type, measuredAt, source)", async () => {
    const prisma = getPrismaClient();
    const measuredAt = new Date("2026-05-12T22:00:00.000Z");

    // Four stage rows that share every legacy-composite column — only
    // sleep_stage differentiates them. All four must persist.
    const stages: Array<"AWAKE" | "CORE" | "DEEP" | "REM"> = [
      "AWAKE",
      "CORE",
      "DEEP",
      "REM",
    ];
    for (const stage of stages) {
      await prisma.measurement.create({
        data: {
          userId: TEST_USER_ID,
          type: "SLEEP_DURATION",
          value: 60,
          unit: "minutes",
          source: "WITHINGS",
          measuredAt,
          sleepStage: stage,
        },
      });
    }

    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION" },
      orderBy: { sleepStage: "asc" },
    });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.sleepStage).sort()).toEqual([
      "AWAKE",
      "CORE",
      "DEEP",
      "REM",
    ]);
  });

  it("still rejects duplicates within the same stage (idempotent re-sync)", async () => {
    const prisma = getPrismaClient();
    const measuredAt = new Date("2026-05-12T22:00:00.000Z");
    const row = {
      userId: TEST_USER_ID,
      type: "SLEEP_DURATION" as const,
      value: 60,
      unit: "minutes",
      source: "WITHINGS" as const,
      measuredAt,
      sleepStage: "DEEP" as const,
    };

    await prisma.measurement.create({ data: row });

    // Same five-tuple → must surface as Prisma P2002.
    await expect(prisma.measurement.create({ data: row })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(rows).toHaveLength(1);
  });

  it("preserves NULL-vs-NULL dedup for non-sleep rows (NULLS NOT DISTINCT)", async () => {
    const prisma = getPrismaClient();
    const measuredAt = new Date("2026-05-12T08:30:00.000Z");
    const row = {
      userId: TEST_USER_ID,
      type: "WEIGHT" as const,
      value: 82.3,
      unit: "kg",
      source: "WITHINGS" as const,
      measuredAt,
      // sleepStage omitted → NULL
    };

    await prisma.measurement.create({ data: row });

    // Migration 0055 created the unique index with NULLS NOT DISTINCT,
    // so the second insert MUST collide on the four legacy columns
    // even though sleep_stage is NULL on both sides.
    await expect(prisma.measurement.create({ data: row })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "WEIGHT" },
    });
    expect(rows).toHaveLength(1);
  });

  it("supports findFirst + create/update idempotency for non-sleep measurements", async () => {
    const prisma = getPrismaClient();
    const measuredAt = new Date("2026-05-12T08:30:00.000Z");

    // Prisma's typed compound input requires a non-null `sleepStage`,
    // so the Withings sync writes via findFirst + create/update. This
    // mirrors that path; the second pass must update in place rather
    // than insert a duplicate.
    for (const value of [82.4, 82.1]) {
      const existing = await prisma.measurement.findFirst({
        where: {
          userId: TEST_USER_ID,
          type: "WEIGHT",
          measuredAt,
          source: "WITHINGS",
          sleepStage: null,
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.measurement.update({
          where: { id: existing.id },
          data: { value },
        });
      } else {
        await prisma.measurement.create({
          data: {
            userId: TEST_USER_ID,
            type: "WEIGHT",
            value,
            unit: "kg",
            measuredAt,
            source: "WITHINGS",
          },
        });
      }
    }

    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "WEIGHT" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(82.1);
  });
});
