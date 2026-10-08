/**
 * RMSSD HRV from HealthKit (#1110), against real Postgres: iOS / watchOS 27
 * added `HKQuantityTypeIdentifierHeartRateVariabilityRMSSD`. Both ingest
 * paths, the live batch and the `export.zip` import, read the one mapping;
 * each must store it as `HRV_RMSSD`, apart from SDNN, and keep a reading
 * above the old 200 ms ceiling instead of skipping it for good.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

const USER_ID = "user-hrv-rmssd-ingest";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "hrv-rmssd",
      email: "hrv-rmssd@example.test",
      timezone: "UTC",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

describe("RMSSD HRV ingest (#1110)", () => {
  it("stores a batch entry as HRV_RMSSD, a 250 ms reading included", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");
    const at = "2026-10-01T03:00:00.000Z";
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD",
              value: 250,
              unit: "ms",
              startDate: at,
              endDate: at,
              externalId: "uuid-rmssd-1",
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
              value: 48,
              unit: "ms",
              startDate: at,
              endDate: at,
              externalId: "uuid-sdnn-1",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "inserted",
    ]);
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID },
      orderBy: { type: "asc" },
      select: { type: true, value: true, unit: true },
    });
    expect(rows).toEqual([
      { type: "HEART_RATE_VARIABILITY", value: 48, unit: "ms" },
      { type: "HRV_RMSSD", value: 250, unit: "ms" },
    ]);
  });

  it("imports an RMSSD record from export.zip as HRV_RMSSD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-rmssd-"));
    const xmlPath = join(dir, "export.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRateVariabilityRMSSD" unit="ms"
          startDate="2026-10-01 05:00:00 +0200"
          endDate="2026-10-01 05:00:00 +0200"
          value="71.5" sourceName="Watch" sourceVersion="27.0"/>
</HealthData>`,
    );
    await streamParseExportXml({
      xmlPath,
      userId: USER_ID,
      userTimezone: "UTC",
      prisma: getPrismaClient(),
    });
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID },
      select: { type: true, value: true, source: true },
    });
    expect(rows).toEqual([
      { type: "HRV_RMSSD", value: 71.5, source: "APPLE_HEALTH" },
    ]);
  });
});
