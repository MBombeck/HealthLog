import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { collectDoctorReportData } from "@/lib/doctor-report-data";

import { getPrismaClient, truncateAllTables } from "./setup";

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-05-01T00:00:00.000Z"),
  days: 120,
};

const MODULES = {
  cycle: false,
  mood: false,
  sleep: false,
  glucose: true,
  workouts: false,
  recovery: false,
  labs: false,
  illness: false,
  achievements: true,
  coach: true,
  insights: true,
  medications: true,
  doctorReport: true,
  environment: true,
  mcp: true,
  inboundDocuments: true,
  mentalHealth: true,
  nutrients: true,
} as const;

const SECTIONS = {
  bp: false,
  weight: true,
  pulse: true,
  bmi: false,
  mood: false,
  compliance: false,
  sleep: false,
  glucose: true,
  cycle: false,
  labs: false,
  allergies: false,
  familyHistory: false,
} as const;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doctor report — bounded dense measurement reads", () => {
  it("keeps dense transfer and points bounded by local days while sparse rows remain raw", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "doctor-report-dense",
        email: "doctor-report-dense@example.test",
        timezone: "America/New_York",
        sourcePriorityJson: {
          metricPriority: {
            pulse: ["WITHINGS", "MANUAL"],
          },
        } as Prisma.InputJsonValue,
      },
    });

    const sparseRows = [
      {
        userId: user.id,
        type: "WEIGHT" as const,
        value: 80,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date("2026-01-02T04:15:00.000Z"),
      },
      {
        userId: user.id,
        type: "WEIGHT" as const,
        value: 81,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date("2026-01-02T06:15:00.000Z"),
      },
    ];
    await prisma.measurement.createMany({ data: sparseRows });

    const seedDenseBatch = async (
      offset: number,
      samplesPerLocalDay: number,
    ) => {
      const rows: Prisma.MeasurementCreateManyInput[] = [];
      const localDayInstants = [
        Date.parse("2026-01-02T04:30:00.000Z"), // Jan 1, 23:30 in New York
        Date.parse("2026-01-02T05:30:00.000Z"), // Jan 2, 00:30 in New York
      ];
      for (const [dayIndex, baseMs] of localDayInstants.entries()) {
        for (let i = 0; i < samplesPerLocalDay; i += 1) {
          const measuredAt = new Date(baseMs + (offset + i) * 1_000);
          rows.push(
            {
              userId: user.id,
              type: "PULSE",
              value: 60 + dayIndex,
              unit: "bpm",
              source: "WITHINGS",
              measuredAt,
            },
            {
              userId: user.id,
              type: "PULSE",
              value: 160 + dayIndex,
              unit: "bpm",
              source: "MANUAL",
              measuredAt,
            },
            {
              userId: user.id,
              type: "BLOOD_GLUCOSE",
              value: 90 + dayIndex,
              unit: "mg/dL",
              source: "MANUAL",
              glucoseContext: "FASTING",
              measuredAt,
            },
          );
        }
      }
      await prisma.measurement.createMany({ data: rows });
    };

    await seedDenseBatch(0, 4);
    const findManySpy = vi.spyOn(prisma.measurement, "findMany");

    const initial = await collectDoctorReportData(user.id, RANGE, {
      sections: { ...SECTIONS },
      moduleMap: { ...MODULES },
    });

    expect(initial.measurements.PULSE).toHaveLength(2);
    expect(initial.measurements.BLOOD_GLUCOSE).toHaveLength(2);
    expect(initial.measurements.PULSE.map((point) => point.measuredAt)).toEqual(
      ["2026-01-01T05:00:00.000Z", "2026-01-02T05:00:00.000Z"],
    );
    expect(initial.stats.PULSE).toMatchObject({
      count: 8,
      avg: 60.5,
      min: 60,
      max: 61,
    });
    expect(initial.measurements.WEIGHT).toEqual(
      sparseRows.map((row) => ({
        value: row.value,
        measuredAt: row.measuredAt.toISOString(),
      })),
    );

    const rawRows = (await findManySpy.mock.results[0]?.value) as Array<{
      type: string;
    }>;
    expect(rawRows).toHaveLength(sparseRows.length);
    expect(rawRows.map((row) => row.type)).toEqual(["WEIGHT", "WEIGHT"]);

    await seedDenseBatch(10, 300);
    const grown = await collectDoctorReportData(user.id, RANGE, {
      sections: { ...SECTIONS },
      moduleMap: { ...MODULES },
    });

    expect(grown.measurements.PULSE).toHaveLength(2);
    expect(grown.measurements.BLOOD_GLUCOSE).toHaveLength(2);
    expect(grown.stats.PULSE.count).toBe(608);
    expect(grown.stats.BLOOD_GLUCOSE.count).toBe(608);
    expect(grown.measurements.WEIGHT).toEqual(initial.measurements.WEIGHT);
  });
});
