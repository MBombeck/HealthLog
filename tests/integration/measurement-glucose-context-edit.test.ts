/**
 * Correcting a blood glucose reading's meal context after it is saved
 * (#1407), against Postgres: `PUT /api/measurements/[id]` writes the new
 * context, `null` clears it, the row's `updatedAt` moves so a paired client
 * picks the change up, the per-context target read files the reading under
 * its new context, and a context sent for another type is refused without a
 * write.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { readGlucoseTargetSummaries } from "@/lib/targets/glucose-read";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "glucose-context-edit",
      email: "glucose-context-edit@example.test",
      role: "USER",
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function put(id: string, body: unknown): Promise<Response> {
  const { PUT } = await import("@/app/api/measurements/[id]/route");
  return PUT(
    new NextRequest(`http://localhost/api/measurements/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PUT /api/measurements/[id] — glucose context", () => {
  it("moves a reading to its corrected context and clears it with null", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession();
    const measuredAt = new Date(Date.now() - 3_600_000);
    const row = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_GLUCOSE",
        value: 160,
        unit: "mg/dL",
        source: "MANUAL",
        glucoseContext: "FASTING",
        measuredAt,
      },
    });

    await new Promise((r) => setTimeout(r, 5));
    const res = await put(row.id, { glucoseContext: "POSTPRANDIAL" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { glucoseContext: string } };
    expect(body.data.glucoseContext).toBe("POSTPRANDIAL");

    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.glucoseContext).toBe("POSTPRANDIAL");
    expect(after.value).toBe(160);
    // The sync feed pages on `updatedAt`; the change has to move it.
    expect(after.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());

    // The per-context target read files it under the new context now.
    const summaries = await readGlucoseTargetSummaries({
      userId: user.id,
      since: new Date(Date.now() - 86_400_000),
      recentSince: new Date(Date.now() - 86_400_000),
      timeZone: "UTC",
    });
    expect(summaries.map((s) => s.glucoseContext)).toEqual(["POSTPRANDIAL"]);

    // The audit row names the overwritten context.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: user.id, action: "measurement.update" },
    });
    expect(JSON.parse(audit.details ?? "{}")).toMatchObject({
      measurementId: row.id,
      fields: ["glucoseContext"],
      previous: { glucoseContext: "FASTING" },
    });

    // A body that does not name the context leaves it alone.
    expect((await put(row.id, { notes: "after lunch" })).status).toBe(200);
    expect(
      (await prisma.measurement.findUniqueOrThrow({ where: { id: row.id } }))
        .glucoseContext,
    ).toBe("POSTPRANDIAL");

    const cleared = await put(row.id, { glucoseContext: null });
    expect(cleared.status).toBe(200);
    const clearedRow = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(clearedRow.glucoseContext).toBeNull();
  });

  it("gives a sensor reading a context without touching its value", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession();
    const row = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_GLUCOSE",
        value: 104,
        unit: "mg/dL",
        source: "NIGHTSCOUT",
        measuredAt: new Date(Date.now() - 3_600_000),
      },
    });

    const res = await put(row.id, { glucoseContext: "BEDTIME" });
    expect(res.status).toBe(200);
    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.glucoseContext).toBe("BEDTIME");
    expect(after.value).toBe(104);
  });

  it("refuses a context on another type and writes nothing", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession();
    const row = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(Date.now() - 3_600_000),
      },
    });

    const res = await put(row.id, { glucoseContext: "FASTING", value: 81 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe(
      "measurement.update.glucose_context_not_glucose",
    );
    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.value).toBe(80);
    expect(after.glucoseContext).toBeNull();
  });
});
