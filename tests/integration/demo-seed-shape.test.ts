/**
 * The demo's short-window charts need a shape to show. Every 90-day series in
 * the seed is a mean-reverting walk, and around a settled target that is flat
 * noise: a 7-day trend line over the last 30 days of blood pressure drew a
 * straight line, which is exactly the view the demo exists to show off. The
 * seed carries a busy stretch a few weeks back that lifts blood pressure to
 * about 144/91 for some ten days, and ramipril goes up on the day it
 * turns.
 *
 * The blood-pressure chart scales one axis to fit systolic and diastolic, so a
 * swing has to be large to read: a first version lifted systolic by 12 mmHg,
 * its 7-day mean swung 8 to 14 mmHg, and on a 60 to 140 axis that still drew a
 * nearly flat line. This runs the real `scripts/seed-demo.ts` and holds the
 * last 30 days to a swing of the size that reads, to day-to-day noise small
 * enough for the 7-day mean to draw an arc, to today's reading back in the
 * settled band, and to the dose change landing on the turn. The seed is random,
 * so the bounds leave room around the measured values (swing about 23 mmHg,
 * day-to-day steps around 1 to 2 mmHg outside the climb and the fall). The
 * peak also has a ceiling: past 148 the chart's padded axis jumps to 50-200.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let systolic: number[];
let diastolic: number[];
let means: number[];
let doseChanges: Array<{ effectiveFrom: Date; doseValue: number }>;

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { seed } = await import("../../scripts/seed-demo");
  await seed();
  const user = await prisma.user.findUniqueOrThrow({
    where: { username: "demo" },
    select: { id: true },
  });
  const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS",
      source: "WITHINGS",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true },
  });
  systolic = rows.map((r) => Number(r.value));
  const diaRows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_PRESSURE_DIA",
      source: "WITHINGS",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true },
  });
  diastolic = diaRows.map((r) => Number(r.value));
  const ramipril = await prisma.medication.findFirstOrThrow({
    where: { userId: user.id, name: "Ramipril" },
    select: { id: true },
  });
  const changes = await prisma.medicationDoseChange.findMany({
    where: { medicationId: ramipril.id, effectiveFrom: { gte: since } },
    select: { effectiveFrom: true, doseValue: true },
  });
  doseChanges = changes.map((c) => ({
    effectiveFrom: c.effectiveFrom,
    doseValue: Number(c.doseValue),
  }));
  means = [];
  for (let i = 6; i < systolic.length; i++) {
    const week = systolic.slice(i - 6, i + 1);
    means.push(week.reduce((a, b) => a + b, 0) / week.length);
  }
}, 180_000);

describe("demo seed, short-window shape", () => {
  it("gives the 7-day systolic mean over 30 days a rise and fall that reads", () => {
    expect(systolic.length).toBeGreaterThanOrEqual(28);
    const swing = Math.max(...means) - Math.min(...means);
    expect(swing).toBeGreaterThanOrEqual(18);
    expect(Math.max(...systolic)).toBeGreaterThanOrEqual(140);
    // One mmHg past 148 and the padded axis rounds out to 50-200 in steps of
    // 50, which flattens the rise again.
    expect(Math.max(...systolic)).toBeLessThanOrEqual(148);
    expect(Math.max(...diastolic)).toBeGreaterThanOrEqual(88);
  });

  it("keeps the day-to-day steps small enough for the 7-day mean to draw an arc", () => {
    const steps = systolic.slice(1).map((v, i) => Math.abs(v - systolic[i]));
    const sorted = [...steps].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThanOrEqual(3);
  });

  it("leaves the median of the window in the settled band", () => {
    // The usual range is the median ± 3 MAD of the last 30 days. A stretch
    // that fills half the window moves that median onto the stretch and
    // widens the band to something like 87-181 mmHg. The seed's own spread
    // reaches about ±22 in one run of 150, so the bound sits at 24, still far
    // below what a stretch that long produces.
    const sorted = [...systolic].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeLessThanOrEqual(124);
    const deviations = systolic
      .map((v) => Math.abs(v - median))
      .sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)];
    expect(3 * 1.4826 * mad).toBeLessThanOrEqual(24);
  });

  it("raises ramipril on the day the stretch turns", () => {
    expect(doseChanges).toHaveLength(1);
    expect(doseChanges[0].doseValue).toBe(10);
    const daysBefore =
      (Date.now() - doseChanges[0].effectiveFrom.getTime()) / 86_400_000;
    expect(daysBefore).toBeGreaterThan(8);
    expect(daysBefore).toBeLessThan(14);
  });

  it("brings today's systolic reading back down from the stretch", () => {
    expect(systolic.at(-1)).toBeLessThanOrEqual(Math.max(...means) - 15);
    expect(systolic.at(-1)).toBeLessThanOrEqual(125);
  });
});
