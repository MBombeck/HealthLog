/**
 * The single create routes answer a re-post of an entry deleted in HealthLog
 * the way the bulk routes do: it stays deleted, and the answer is final.
 *
 * The app posts State of Mind samples one by one through
 * `POST /api/mood-entries`. That route upserted onto the tombstone, left it
 * deleted and answered `201`: the app believed the entry was back, nobody
 * saw it, and a sample the phone had reported deleted in Apple Health stayed
 * deleted when it came back. The sleep-stage arm of `POST /api/measurements`
 * answered `200 duplicate` with the deleted row, the single cycle day revived
 * a day the person had deleted, and an AUDIT-C replay answered a deleted
 * entry as live. Each now answers `410` with `reason: "deleted_in_healthlog"`
 * after a delete in HealthLog, and writes back a sample the phone reported
 * deleted in Apple Health. Real deletes on both ends: the person's own DELETE
 * route and the phone's by-external-ids report.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const OWNER = "user-single-route-tombstone";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: OWNER,
      username: OWNER,
      email: `${OWNER}@example.test`,
      timezone: "UTC",
      gender: "FEMALE",
    },
  });
  const session = await prisma.session.create({
    data: { userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface Refusal {
  data: null;
  meta: { errorCode: string; reason: string; id: string };
}

async function expectRefused(
  res: Response,
  errorCode: string,
  id: string,
): Promise<void> {
  expect(res.status).toBe(410);
  const body = (await res.json()) as Refusal;
  expect(body.data).toBeNull();
  expect(body.meta).toMatchObject({
    errorCode,
    reason: "deleted_in_healthlog",
    id,
  });
}

describe("POST /api/mood-entries", () => {
  const entry = (externalId: string) => ({
    mood: "GUT",
    moodLoggedAt: "2026-10-10T07:00:00.000Z",
    source: "APPLE_HEALTH",
    externalId,
  });

  it("refuses the re-post of an entry the person deleted, and writes back one the phone reported deleted", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/mood-entries/route");
    const created = await POST(
      request("POST", "/api/mood-entries", entry("SOM-P")),
    );
    expect(created.status).toBe(201);
    const row = await prisma.moodEntry.findFirstOrThrow({
      where: { userId: OWNER, externalId: "SOM-P" },
    });

    const single = await import("@/app/api/mood-entries/[id]/route");
    const removed = await single.DELETE(
      request("DELETE", `/api/mood-entries/${row.id}`),
      params(row.id),
    );
    expect(removed.status).toBeLessThan(300);

    await expectRefused(
      await POST(request("POST", "/api/mood-entries", entry("SOM-P"))),
      "mood.deleted_in_healthlog",
      row.id,
    );
    // The same answer again: final, and nothing came back.
    expect(
      (await POST(request("POST", "/api/mood-entries", entry("SOM-P")))).status,
    ).toBe(410);
    const after = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.deletedAt).not.toBeNull();

    // Reported deleted in Apple Health by the phone: a re-post means the
    // sample is in HealthKit again, so it is live again.
    const other = {
      ...entry("SOM-H"),
      moodLoggedAt: "2026-10-10T08:00:00.000Z",
    };
    expect(
      (await POST(request("POST", "/api/mood-entries", other))).status,
    ).toBe(201);
    const reported =
      await import("@/app/api/mood-entries/by-external-ids/route");
    const report = await reported.DELETE(
      request("DELETE", "/api/mood-entries/by-external-ids", {
        externalIds: ["SOM-H"],
      }),
    );
    expect(report.status).toBe(200);
    const back = await POST(request("POST", "/api/mood-entries", other));
    expect(back.status).toBe(201);
    const live = await prisma.moodEntry.findFirstOrThrow({
      where: { userId: OWNER, externalId: "SOM-H" },
    });
    expect(live.deletedAt).toBeNull();
    expect(live.appleHealthDeletedAt).toBeNull();
  });
});

describe("POST /api/measurements with a named sleep stage", () => {
  const segment = (externalId: string, start: string, end: string) => ({
    type: "SLEEP_DURATION",
    sleepStage: "DEEP",
    startDate: start,
    endDate: end,
    source: "APPLE_HEALTH",
    externalId,
  });

  it("refuses the re-post of a segment the person deleted, and writes back one the phone reported deleted", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/route");
    const own = segment(
      "SLP-P",
      "2026-10-10T01:00:00.000Z",
      "2026-10-10T01:40:00.000Z",
    );
    expect((await POST(request("POST", "/api/measurements", own))).status).toBe(
      201,
    );
    const row = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER, externalId: "SLP-P" },
    });
    const single = await import("@/app/api/measurements/[id]/route");
    const removed = await single.DELETE(
      request("DELETE", `/api/measurements/${row.id}`),
      params(row.id),
    );
    expect(removed.status).toBeLessThan(300);

    await expectRefused(
      await POST(request("POST", "/api/measurements", own)),
      "measurement.deleted_in_healthlog",
      row.id,
    );
    expect(
      (await prisma.measurement.findUniqueOrThrow({ where: { id: row.id } }))
        .deletedAt,
    ).not.toBeNull();

    const theirs = segment(
      "SLP-H",
      "2026-10-10T03:00:00.000Z",
      "2026-10-10T03:30:00.000Z",
    );
    expect(
      (await POST(request("POST", "/api/measurements", theirs))).status,
    ).toBe(201);
    const reported =
      await import("@/app/api/measurements/by-external-ids/route");
    expect(
      (
        await reported.DELETE(
          request("DELETE", "/api/measurements/by-external-ids", {
            externalIds: ["SLP-H"],
          }),
        )
      ).status,
    ).toBe(200);
    const back = await POST(request("POST", "/api/measurements", theirs));
    expect(back.status).toBe(200);
    expect(
      ((await back.json()) as { data: { status: string } }).data.status,
    ).toBe("updated");
    const live = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER, externalId: "SLP-H" },
    });
    expect(live.deletedAt).toBeNull();
  });
});

describe("POST /api/cycle/day-logs", () => {
  it("refuses an Apple Health re-post of a day the person deleted; the person's own write still revives it", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/cycle/day-logs/route");
    const day = {
      date: "2026-10-03",
      flow: "LIGHT",
      source: "APPLE_HEALTH",
      externalId: "cycle-hk:2026-10-03",
      loggedAt: "2026-10-03T08:00:00.000Z",
    };
    expect(
      (await POST(request("POST", "/api/cycle/day-logs", day))).status,
    ).toBe(201);
    const row = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: OWNER, externalId: day.externalId },
    });
    const single = await import("@/app/api/cycle/day-logs/[id]/route");
    const removed = await single.DELETE(
      request("DELETE", `/api/cycle/day-logs/${row.id}`),
      params(row.id),
    );
    expect(removed.status).toBeLessThan(300);

    await expectRefused(
      await POST(request("POST", "/api/cycle/day-logs", day)),
      "cycle.day-log.deleted_in_healthlog",
      row.id,
    );
    expect(
      await prisma.cycleDayLog.count({
        where: { userId: OWNER, date: day.date, deletedAt: null },
      }),
    ).toBe(0);

    const written = await POST(
      request("POST", "/api/cycle/day-logs", {
        date: day.date,
        flow: "HEAVY",
        loggedAt: day.loggedAt,
      }),
    );
    expect(written.status).toBeLessThan(300);
    expect(
      await prisma.cycleDayLog.count({
        where: { userId: OWNER, date: day.date, deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe("POST /api/anamnesis/audit-c", () => {
  it("refuses the replay of an entry deleted since", async () => {
    const { POST } = await import("@/app/api/anamnesis/audit-c/route");
    const body = { items: [1, 1, 0], source: "IOS", externalId: "audit-1" };
    const created = await POST(request("POST", "/api/anamnesis/audit-c", body));
    expect(created.status).toBe(201);
    const { id } = (
      (await created.json()) as { data: { result: { id: string } } }
    ).data.result;

    // A replay of a live entry still answers it.
    expect(
      (await POST(request("POST", "/api/anamnesis/audit-c", body))).status,
    ).toBe(200);

    const single = await import("@/app/api/anamnesis/audit-c/[id]/route");
    const removed = await single.DELETE(
      request("DELETE", `/api/anamnesis/audit-c/${id}`),
      params(id),
    );
    expect(removed.status).toBe(200);

    await expectRefused(
      await POST(request("POST", "/api/anamnesis/audit-c", body)),
      "anamnesis.auditC.deleted_in_healthlog",
      id,
    );
    const prisma = getPrismaClient();
    expect(
      await prisma.mentalHealthAssessment.count({
        where: { userId: OWNER, instrument: "AUDIT_C", deletedAt: null },
      }),
    ).toBe(0);
  });
});
