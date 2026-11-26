/**
 * The doctor report names recovery by its source, one row per source.
 *
 * A window that holds WHOOP nights and nights with only HealthLog's computed
 * proxy used to come out as one "Recovery" row averaging both. Over the real
 * aggregator and the real database, the report now carries two rows, "WHOOP
 * Recovery" and "Readiness (HealthLog)", each over its own nights, and the
 * FHIR export and the rendered PDF follow it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import { observationsFromReportData } from "@/lib/fhir/resources/observation";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { getServerTranslator } from "@/lib/i18n/server-translator";

import { cookieJar, headerJar } from "./mock-next-headers";
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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

const RANGE = {
  start: new Date("2026-03-01T00:00:00.000Z"),
  end: new Date("2026-03-15T00:00:00.000Z"),
  days: 14,
};

async function seed(): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "dr-recovery-sources",
      email: "dr-recovery-sources@example.test",
      timezone: "UTC",
    },
  });
  const row = (source: "WHOOP" | "COMPUTED", value: number, iso: string) => ({
    userId: user.id,
    type: "RECOVERY_SCORE" as const,
    value,
    unit: "score",
    source,
    measuredAt: new Date(iso),
  });
  await prisma.measurement.createMany({
    data: [
      // Three WHOOP nights (wake Mar 3 to 5), stamped the wake morning.
      row("WHOOP", 80, "2026-03-03T06:00:00.000Z"),
      row("WHOOP", 70, "2026-03-04T06:00:00.000Z"),
      row("WHOOP", 60, "2026-03-05T06:00:00.000Z"),
      // The proxy for one of those nights, stamped the day that ended: it
      // collapses under WHOOP's row and counts nowhere.
      row("COMPUTED", 20, "2026-03-03T12:00:00.000Z"),
      // Two nights with only the proxy (wake Mar 9 and 10).
      row("COMPUTED", 50, "2026-03-08T12:00:00.000Z"),
      row("COMPUTED", 40, "2026-03-09T12:00:00.000Z"),
    ],
  });
  return user.id;
}

describe("doctor report: recovery one row per source", () => {
  it("gives WHOOP's nights and the proxy's nights a row each, named by source", async () => {
    const userId = await seed();
    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(["RECOVERY_SCORE"]),
    );

    const recovery = (data.wellnessScores ?? []).filter(
      (s) => s.type === "RECOVERY_SCORE",
    );
    expect(recovery).toHaveLength(2);
    expect(recovery[0]).toMatchObject({
      source: "WHOOP",
      latest: 60,
      avg: 70,
      min: 60,
      max: 80,
      count: 3,
    });
    expect(recovery[1]).toMatchObject({
      source: "COMPUTED",
      latest: 40,
      avg: 45,
      min: 40,
      max: 50,
      count: 2,
    });

    // Not also as one mixed row in the measurement table or its chart.
    expect(data.stats.RECOVERY_SCORE).toBeUndefined();
    expect(data.measurements.RECOVERY_SCORE).toBeUndefined();

    const fhir = observationsFromReportData(data)
      .map((o) => o.code.text)
      .filter((text) => text !== undefined);
    expect(fhir).toEqual(
      expect.arrayContaining(["WHOOP Recovery", "Readiness (HealthLog)"]),
    );
    expect(fhir).not.toContain("Recovery score");

    // Both languages render the section without falling over.
    for (const locale of ["de", "en"] as const) {
      const bytes = renderDoctorReportPdfBytes(data, {
        t: getServerTranslator(locale).t,
        locale,
        timeFormat: "AUTO",
        dateFormat: "AUTO",
      });
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });
});
