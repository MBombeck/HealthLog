/**
 * The pregnancy / postpartum cycle state against real Postgres, driven through
 * the shipped routes and jobs: setting it pauses the forecast on the calendar
 * and drops the cached forecast the reminder cron scans; the refresh job keeps
 * it dropped; the verdict says nothing about today rather than "late"; the
 * DTO carries the resolved week; clearing the state clears its dates; and the
 * state survives a cycle backup round trip.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCycleBackupSection, restoreCycleData } from "@/lib/cycle/backup";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";
import { parseBackupPayload } from "@/lib/validations/backup";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-cycle-pregnancy-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-cycle-pregnancy";

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

const db = () => getPrismaClient();

function dayKey(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function loginAs(userId: string): Promise<void> {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function patchPrefs(body: unknown) {
  const { PATCH } = await import("@/app/api/auth/me/cycle-prefs/route");
  return PATCH(
    new NextRequest("http://localhost/api/auth/me/cycle-prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function calendar() {
  const { GET } = await import("@/app/api/cycle/calendar/route");
  const res = await GET(new NextRequest("http://localhost/api/cycle/calendar"));
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

beforeEach(async () => {
  await truncateAllTables(db());
  await db().user.create({
    data: {
      id: USER_ID,
      username: "cycle-pregnancy",
      email: "cycle-pregnancy@example.test",
      gender: "FEMALE",
      timezone: "UTC",
    },
  });
  // Three observed cycles ending well in the past: an ordinary profile would
  // forecast a period and call it late.
  for (const [start, end] of [
    [dayKey(-200), dayKey(-173)],
    [dayKey(-172), dayKey(-145)],
  ] as const) {
    await db().menstrualCycle.create({
      data: { userId: USER_ID, startDate: start, endDate: end, lengthDays: 28 },
    });
  }
  await db().menstrualCycle.create({
    data: { userId: USER_ID, startDate: dayKey(-144) },
  });
  await loginAs(USER_ID);
});

describe("pregnancy state", () => {
  it("pauses the forecast, drops the cached one, and says nothing late", async () => {
    const before = await calendar();
    expect(before.prediction).not.toBeNull();
    expect(before.verdict.state).toBe("OVERDUE");
    expect(before.pregnancy.predictionsPaused).toBe(false);

    // A cached forecast the reminder cron would scan.
    const { refreshPredictionCacheForUser } =
      await import("@/lib/cycle/prediction-refresh");
    expect(await refreshPredictionCacheForUser(USER_ID)).toBe("persisted");
    expect(
      await db().cyclePrediction.findUnique({ where: { userId: USER_ID } }),
    ).not.toBeNull();

    const start = dayKey(-144);
    const res = await patchPrefs({
      pregnancy: { state: "PREGNANT", startDate: start },
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()).data;
    expect(dto.pregnancy.state).toBe("PREGNANT");
    expect(dto.pregnancy.gestationalWeeks).toBe(20);
    expect(dto.pregnancy.gestationalDays).toBe(4);
    expect(dto.pregnancy.predictionsPaused).toBe(true);

    // The cached forecast went with the state.
    expect(
      await db().cyclePrediction.findUnique({ where: { userId: USER_ID } }),
    ).toBeNull();
    // And the refresh job does not write it back.
    expect(await refreshPredictionCacheForUser(USER_ID)).toBe("paused");
    expect(
      await db().cyclePrediction.findUnique({ where: { userId: USER_ID } }),
    ).toBeNull();

    const during = await calendar();
    expect(during.prediction).toBeNull();
    expect(during.projection).toEqual([]);
    expect(during.verdict.state).toBe("INSUFFICIENT_DATA");
    expect(during.verdict.overdueDays).toBeNull();
    expect(during.pregnancy.state).toBe("PREGNANT");

    // Back to the ordinary cycle: the dates go, the forecast returns.
    const cleared = await patchPrefs({ pregnancy: { state: null } });
    expect(cleared.status).toBe(200);
    const row = await db().cycleProfile.findUniqueOrThrow({
      where: { userId: USER_ID },
    });
    expect(row.reproductiveState).toBeNull();
    expect(row.pregnancyStartDate).toBeNull();
    expect((await calendar()).prediction).not.toBeNull();
  });

  it("refuses POSTPARTUM without a delivery date and a future first day", async () => {
    const noDate = await patchPrefs({ pregnancy: { state: "POSTPARTUM" } });
    expect(noDate.status).toBe(422);
    expect((await noDate.json()).meta.errorCode).toBe(
      "cycle-prefs.pregnancy.delivery_required",
    );
    const future = await patchPrefs({
      pregnancy: { state: "PREGNANT", startDate: dayKey(3) },
    });
    expect(future.status).toBe(422);
    expect(
      await db().cycleProfile.findUniqueOrThrow({ where: { userId: USER_ID } }),
    ).toMatchObject({ reproductiveState: null });
  });

  it("resumes the forecast once the postpartum weeks are over", async () => {
    const res = await patchPrefs({
      pregnancy: {
        state: "POSTPARTUM",
        deliveryDate: dayKey(-30),
        postpartumWeeks: 2,
      },
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()).data;
    expect(dto.pregnancy.storedState).toBe("POSTPARTUM");
    expect(dto.pregnancy.state).toBeNull();
    expect(dto.pregnancy.predictionsPaused).toBe(false);
    expect((await calendar()).prediction).not.toBeNull();
  });

  it("travels in the cycle backup and restores", async () => {
    await patchPrefs({
      pregnancy: {
        state: "PREGNANT",
        startDate: dayKey(-100),
        dueDate: dayKey(180),
      },
    });
    const section = await buildCycleBackupSection(db(), USER_ID);
    expect(section.cycleProfile).toMatchObject({
      reproductiveState: "PREGNANT",
      pregnancyStartDate: dayKey(-100),
      pregnancyDueDate: dayKey(180),
    });
    const payload = parseBackupPayload({
      schemaVersion: "1",
      exportedAt: new Date().toISOString(),
      userId: USER_ID,
      ...section,
    });
    await db().cycleProfile.update({
      where: { userId: USER_ID },
      data: { reproductiveState: null, pregnancyStartDate: null },
    });
    const skips: RestoreSkipLog = [];
    await db().$transaction(async (tx) => {
      await restoreCycleData(tx, USER_ID, payload, skips);
    });
    expect(
      await db().cycleProfile.findUniqueOrThrow({ where: { userId: USER_ID } }),
    ).toMatchObject({
      reproductiveState: "PREGNANT",
      pregnancyStartDate: dayKey(-100),
      pregnancyDueDate: dayKey(180),
    });
  });

  it("reads an ongoing Apple Health pregnancy, once, and never over the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-pregnancy-xml-"));
    const xmlPath = join(dir, "export.xml");
    const start = `${dayKey(-70)} 10:00:00 +0000`;
    const end = `${dayKey(200)} 10:00:00 +0000`;
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData>\n<Record type="HKCategoryTypeIdentifierPregnancy" value="HKCategoryValueNotApplicable" startDate="${start}" endDate="${end}"/>\n</HealthData>`,
    );
    const run = () =>
      streamParseExportXml({
        xmlPath,
        userId: USER_ID,
        userTimezone: "UTC",
        prisma: db(),
      });

    const first = await run();
    expect(first.cycle.pregnancyStateSet).toBe("PREGNANT");
    expect(
      await db().cycleProfile.findUniqueOrThrow({ where: { userId: USER_ID } }),
    ).toMatchObject({
      reproductiveState: "PREGNANT",
      pregnancyStartDate: dayKey(-70),
    });
    expect(
      await db().auditLog.count({
        where: { userId: USER_ID, action: "cycle.profile.pregnancy-imported" },
      }),
    ).toBe(1);

    // The owner clears it; the next import of the same file leaves it cleared.
    expect((await patchPrefs({ pregnancy: { state: null } })).status).toBe(200);
    const again = await run();
    expect(again.cycle.pregnancyStateSet).toBeNull();
    expect(
      await db().cycleProfile.findUniqueOrThrow({ where: { userId: USER_ID } }),
    ).toMatchObject({ reproductiveState: null });
  });
});
