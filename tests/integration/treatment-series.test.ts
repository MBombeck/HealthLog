/**
 * Treatment series against real Postgres, through the real routes.
 *
 * What only a real database can answer:
 *
 *   - migration 0565's table and `encounters.series_id` exist, the title is
 *     ciphertext on disk, and the foreign keys null rather than cascade;
 *   - the progress is derived from the visits that name a series: filing,
 *     cancelling and booking a session moves the counts and the status, and
 *     a visit's session number skips a cancelled one;
 *   - a series is owner-scoped: a stranger's id is a 404 on read and on a
 *     visit that names it;
 *   - deleting a series leaves its visits, and a restore brings it back;
 *   - the backup carries the series and the visit's reference both ways;
 *   - the calendar feed, the timeline lane and the doctor report read it;
 *   - a series about to run out with sessions left is reminded once, through
 *     the check-up reminder's claim ledger, and an ended or used-up one never.
 *
 * Mutation checks (each run, each seen red):
 *   - count CANCELLED as done in `summarizeSessions` → "cancelled sessions use
 *     up nothing" goes red;
 *   - drop `seriesId` from the restore's encounter `createMany` → the round
 *     trip goes red with a session that lost its series.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  GET as listEncounters,
  POST as createEncounter,
} from "@/app/api/encounters/route";
import { PATCH as patchEncounter } from "@/app/api/encounters/[id]/route";
import {
  GET as listSeries,
  POST as createSeries,
} from "@/app/api/treatment-series/route";
import {
  DELETE as deleteSeries,
  GET as getSeries,
  PATCH as patchSeries,
} from "@/app/api/treatment-series/[id]/route";
import { POST as restoreSeries } from "@/app/api/treatment-series/[id]/restore/route";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { buildCareFeed } from "@/lib/care-feed/build";
import { loadTreatmentSeriesReport } from "@/lib/doctor-report/clinical-records";
import {
  buildVisitsBackupSection,
  restoreVisitsData,
} from "@/lib/export/visits-backup";
import { LANE_READERS } from "@/lib/timeline/lanes";
import { runTreatmentSeriesExpiryTick } from "@/lib/treatment-series/expiry-reminder";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { backupPayloadSchema } from "@/lib/validations/backup";

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

const OWNER_ID = "series-owner";
const STRANGER_ID = "series-stranger";
const DAY = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function seedSession() {
  const prisma = getPrismaClient();
  for (const id of [OWNER_ID, STRANGER_ID]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "Europe/Berlin",
        locale: "en",
      },
    });
  }
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as never;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function json<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface SeriesRow {
  id: string;
  title: string | null;
  status: string;
  plannedSessions: number | null;
  sessions: {
    done: number;
    booked: number;
    cancelled: number;
    remaining: number | null;
  };
  prescriber: { name: string } | null;
  performer: { name: string } | null;
  condition: { id: string; label: string | null } | null;
  firstSessionAt: string | null;
  nextSessionAt: string | null;
  visits?: Array<{
    id: string;
    series: { sessionNumber: number | null } | null;
  }>;
}

async function startSeries(body: Record<string, unknown>) {
  const res = await createSeries(
    request("POST", "/api/treatment-series", body),
  );
  expect(res.status).toBe(201);
  return json<SeriesRow>(res);
}

async function fileVisit(body: Record<string, unknown>) {
  const res = await createEncounter(request("POST", "/api/encounters", body));
  expect(res.status).toBe(201);
  return json<{ id: string; series: { sessionNumber: number | null } | null }>(
    res,
  );
}

async function readSeries(id: string) {
  const res = await getSeries(
    request("GET", `/api/treatment-series/${id}`),
    params(id),
  );
  return {
    status: res.status,
    body: res.ok ? await json<SeriesRow>(res) : null,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("a treatment series", () => {
  it("stores its title as ciphertext and names both practitioners and the condition", async () => {
    const prisma = getPrismaClient();
    const [orderer, giver] = await Promise.all([
      prisma.practitioner.create({
        data: { userId: OWNER_ID, name: "Dr. Orthopedics" },
      }),
      prisma.practitioner.create({
        data: { userId: OWNER_ID, name: "Physio Practice" },
      }),
    ]);
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Knee pain",
        type: "INFECTION",
        onsetAt: daysFromNow(-30),
      },
    });

    const series = await startSeries({
      title: "Physiotherapy, left knee",
      plannedSessions: 6,
      startsOn: dayKey(daysFromNow(-10)),
      validUntil: dayKey(daysFromNow(60)),
      prescriberId: orderer.id,
      performerId: giver.id,
      episodeId: episode.id,
    });
    expect(series).toMatchObject({
      title: "Physiotherapy, left knee",
      status: "PLANNED",
      plannedSessions: 6,
      sessions: { done: 0, booked: 0, cancelled: 0, remaining: 6 },
      prescriber: { name: "Dr. Orthopedics" },
      performer: { name: "Physio Practice" },
      condition: { id: episode.id, label: "Knee pain" },
    });

    const raw = await prisma.treatmentSeries.findUniqueOrThrow({
      where: { id: series.id },
    });
    expect(Buffer.from(raw.titleEncrypted).toString("utf8")).not.toContain(
      "Physiotherapy",
    );
    expect(decryptFromBytes(raw.titleEncrypted)).toBe(
      "Physiotherapy, left knee",
    );

    // Removing the practice nulls the reference; the series stays.
    await prisma.practitioner.delete({ where: { id: giver.id } });
    const after = await readSeries(series.id);
    expect(after.body?.performer).toBeNull();
    expect(after.body?.prescriber).toMatchObject({ name: "Dr. Orthopedics" });
  });

  it("derives its progress from the visits that name it", async () => {
    const series = await startSeries({
      title: "Radiation",
      plannedSessions: 3,
      startsOn: dayKey(daysFromNow(-10)),
    });

    const first = await fileVisit({
      occurredAt: daysFromNow(-5).toISOString(),
      status: "DONE",
      kind: "THERAPY",
      seriesId: series.id,
    });
    const cancelled = await fileVisit({
      occurredAt: daysFromNow(-3).toISOString(),
      status: "DONE",
      seriesId: series.id,
    });
    const res = await patchEncounter(
      request("PATCH", `/api/encounters/${cancelled.id}`, {
        status: "CANCELLED",
      }),
      params(cancelled.id),
    );
    expect(res.status).toBe(200);
    const second = await fileVisit({
      occurredAt: daysFromNow(-1).toISOString(),
      status: "DONE",
      seriesId: series.id,
    });
    const booked = await fileVisit({
      occurredAt: daysFromNow(2).toISOString(),
      status: "PLANNED",
      seriesId: series.id,
    });

    const read = await readSeries(series.id);
    expect(read.body).toMatchObject({
      status: "ACTIVE",
      sessions: { done: 2, booked: 1, cancelled: 1, remaining: 1 },
    });
    expect(read.body?.nextSessionAt).not.toBeNull();
    // Cancelled sessions use up nothing: the numbering skips them.
    const numbers = Object.fromEntries(
      (read.body?.visits ?? []).map((v) => [v.id, v.series?.sessionNumber]),
    );
    expect(numbers).toEqual({
      [first.id]: 1,
      [cancelled.id]: null,
      [second.id]: 2,
      [booked.id]: 3,
    });
    expect(booked.series?.sessionNumber).toBe(3);

    // The visit list carries the same reference.
    const list = await json<{
      upcoming: Array<{ id: string; series: { title: string } | null }>;
    }>(await listEncounters(request("GET", "/api/encounters")));
    expect(list.upcoming[0]).toMatchObject({
      id: booked.id,
      series: { title: "Radiation" },
    });

    // The last planned session taking place completes it.
    await patchEncounter(
      request("PATCH", `/api/encounters/${booked.id}`, {
        status: "DONE",
        occurredAt: daysFromNow(-0.5).toISOString(),
      }),
      params(booked.id),
    );
    expect((await readSeries(series.id)).body?.status).toBe("COMPLETED");
  });

  it("expires once its last valid day passes with sessions left, and completes when ended", async () => {
    const series = await startSeries({
      title: "Injections",
      plannedSessions: 5,
      startsOn: dayKey(daysFromNow(-40)),
      validUntil: dayKey(daysFromNow(-2)),
    });
    await fileVisit({
      occurredAt: daysFromNow(-20).toISOString(),
      status: "DONE",
      seriesId: series.id,
    });
    expect((await readSeries(series.id)).body?.status).toBe("EXPIRED");

    const res = await patchSeries(
      request("PATCH", `/api/treatment-series/${series.id}`, {
        endedOn: dayKey(daysFromNow(-3)),
      }),
      params(series.id),
    );
    expect(res.status).toBe(200);
    expect((await json<SeriesRow>(res)).status).toBe("COMPLETED");
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await createSeries(
      request("POST", "/api/treatment-series", {
        title: "Backwards",
        startsOn: "2026-05-10",
        validUntil: "2026-05-01",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("is the owner's alone", async () => {
    const prisma = getPrismaClient();
    const foreign = await prisma.treatmentSeries.create({
      data: {
        userId: STRANGER_ID,
        titleEncrypted: encryptToBytes("Not yours"),
        startsOn: new Date("2026-05-01T00:00:00.000Z"),
      },
    });
    expect((await readSeries(foreign.id)).status).toBe(404);
    const res = await createEncounter(
      request("POST", "/api/encounters", {
        occurredAt: daysFromNow(-1).toISOString(),
        seriesId: foreign.id,
      }),
    );
    expect(res.status).toBe(404);
    const list = await json<{ series: SeriesRow[] }>(
      await listSeries(request("GET", "/api/treatment-series")),
    );
    expect(list.series).toEqual([]);
  });

  it("leaves its visits standing when deleted, and comes back on restore", async () => {
    const series = await startSeries({
      title: "Dental plan",
      startsOn: dayKey(daysFromNow(-10)),
    });
    const visit = await fileVisit({
      occurredAt: daysFromNow(-2).toISOString(),
      seriesId: series.id,
    });

    const del = await deleteSeries(
      request("DELETE", `/api/treatment-series/${series.id}`),
      params(series.id),
    );
    expect(del.status).toBe(200);
    expect((await readSeries(series.id)).status).toBe(404);
    const past = await json<{
      past: Array<{ id: string; series: unknown }>;
    }>(await listEncounters(request("GET", "/api/encounters")));
    expect(past.past).toEqual([
      expect.objectContaining({ id: visit.id, series: null }),
    ]);

    const restored = await restoreSeries(
      request("POST", `/api/treatment-series/${series.id}/restore`, {}),
      params(series.id),
    );
    expect(restored.status).toBe(200);
    expect((await json<SeriesRow>(restored)).sessions.done).toBe(1);
  });
});

describe("treatment series elsewhere in the record", () => {
  async function seedCourse() {
    const prisma = getPrismaClient();
    const practice = await prisma.practitioner.create({
      data: { userId: OWNER_ID, name: "Physio Practice" },
    });
    const series = await prisma.treatmentSeries.create({
      data: {
        userId: OWNER_ID,
        titleEncrypted: encryptToBytes("Physiotherapy"),
        plannedSessions: 6,
        startsOn: new Date(`${dayKey(daysFromNow(-10))}T00:00:00.000Z`),
        validUntil: new Date(`${dayKey(daysFromNow(20))}T00:00:00.000Z`),
        performerId: practice.id,
        noteEncrypted: encryptToBytes("bring a towel"),
      },
    });
    await prisma.encounter.create({
      data: {
        userId: OWNER_ID,
        occurredAt: daysFromNow(-5),
        status: "DONE",
        kind: "THERAPY",
        seriesId: series.id,
        practitionerId: practice.id,
      },
    });
    const booked = await prisma.encounter.create({
      data: {
        userId: OWNER_ID,
        occurredAt: daysFromNow(3),
        status: "PLANNED",
        kind: "THERAPY",
        seriesId: series.id,
        practitionerId: practice.id,
      },
    });
    return { series, booked };
  }

  it("travels through a backup and back, on both arms", async () => {
    const prisma = getPrismaClient();
    const { series } = await seedCourse();
    for (const purpose of ["disaster-recovery", "portable-export"] as const) {
      const section = await buildVisitsBackupSection(prisma, OWNER_ID, {
        purpose,
      });
      expect(section.treatmentSeries).toHaveLength(1);
      expect(section.encounters.every((e) => e.seriesId === series.id)).toBe(
        true,
      );
      const parsed = backupPayloadSchema.parse({
        exportedAt: new Date().toISOString(),
        userId: OWNER_ID,
        ...JSON.parse(JSON.stringify(section)),
      });
      await prisma.$transaction((tx) =>
        restoreVisitsData(tx, OWNER_ID, parsed, []),
      );
      const back = await prisma.treatmentSeries.findUniqueOrThrow({
        where: { id: series.id },
        include: { sessions: true, performer: true },
      });
      expect(decryptFromBytes(back.titleEncrypted)).toBe("Physiotherapy");
      expect(back.noteEncrypted && decryptFromBytes(back.noteEncrypted)).toBe(
        "bring a towel",
      );
      expect(back.plannedSessions).toBe(6);
      expect(back.performer?.name).toBe("Physio Practice");
      expect(back.sessions).toHaveLength(2);
    }
  });

  it("numbers a booked session in the calendar feed and draws the last valid day", async () => {
    const { series, booked } = await seedCourse();
    const { calendar } = await buildCareFeed(
      {
        id: "feed-1",
        includeVisits: true,
        includeCheckups: false,
        includeVaccinations: false,
        titleMode: "DESCRIPTIVE",
      },
      { id: OWNER_ID, timezone: "Europe/Berlin", locale: "en" },
    );
    const summaries = calendar.events.map((e) => e.summary);
    expect(summaries).toContain("Session 2 of 6: Physio Practice");
    expect(summaries).toContain("Treatment series ends: Physio Practice");
    // The title is the person's health text and never reaches the feed.
    expect(JSON.stringify(calendar)).not.toContain("Physiotherapy");
    expect(series.id).toBeTruthy();
    expect(booked.id).toBeTruthy();
  });

  it("draws a stretch in the timeline's visits lane", async () => {
    const { series } = await seedCourse();
    const lane = await LANE_READERS.visits({
      userId: OWNER_ID,
      tz: "Europe/Berlin",
      access: {
        modules: {} as never,
        domainVisible: () => true,
        owner: true,
      },
    });
    const stretch = lane.items.find((i) => i.kind === "treatmentSeries");
    expect(stretch).toMatchObject({
      id: series.id,
      label: "Physiotherapy",
      sub: "1/6",
      open: true,
    });
  });

  it("reaches the doctor report with its counts", async () => {
    await seedCourse();
    const rows = await loadTreatmentSeriesReport(
      OWNER_ID,
      daysFromNow(-30),
      daysFromNow(0),
      "Europe/Berlin",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        title: "Physiotherapy",
        status: "ACTIVE",
        done: 1,
        plannedSessions: 6,
        performerName: "Physio Practice",
      }),
    ]);
  });
});

describe("the expiry reminder", () => {
  // 09:15 today on the owner's clock (Europe/Berlin). Today rather than a
  // fixed date: the claim ledger stamps its rows with the real clock.
  const today = userDayKey(new Date(), "Europe/Berlin");
  const [year, month, day] = today.split("-").map(Number);
  const now = zonedWallClockToUtc(
    { year, month, day, hour: 9, minute: 15 },
    "Europe/Berlin",
  );
  const validUntil = shiftDateKey(today, 5);

  async function seedExpiring(
    overrides: { endedOn?: Date; done?: number } = {},
  ) {
    const prisma = getPrismaClient();
    const series = await prisma.treatmentSeries.create({
      data: {
        userId: OWNER_ID,
        titleEncrypted: encryptToBytes("Physiotherapy"),
        plannedSessions: 3,
        startsOn: dayKeyAsUtcMidnight(shiftDateKey(today, -30)),
        validUntil: dayKeyAsUtcMidnight(validUntil),
        endedOn: overrides.endedOn ?? null,
      },
    });
    for (let i = 0; i < (overrides.done ?? 1); i += 1) {
      await prisma.encounter.create({
        data: {
          userId: OWNER_ID,
          occurredAt: dayKeyAsUtcMidnight(shiftDateKey(today, -20 + i)),
          status: "DONE",
          kind: "THERAPY",
          seriesId: series.id,
        },
      });
    }
    return series;
  }

  it("goes out once per series and expiry date, on the check-up event", async () => {
    const series = await seedExpiring();
    const dispatch = vi.fn().mockResolvedValue({ dispatched: true });
    const prisma = getPrismaClient();

    const first = await runTreatmentSeriesExpiryTick(prisma, now, {
      dispatch,
    });
    const second = await runTreatmentSeriesExpiryTick(
      prisma,
      new Date(now.getTime() + 15 * 60_000),
      { dispatch },
    );

    expect(first.dispatched).toBe(1);
    expect(second.skippedAlreadyClaimed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      eventType: "MEASUREMENT_REMINDER",
      userId: OWNER_ID,
      metadata: { treatmentSeriesId: series.id },
    });
    expect(dispatch.mock.calls[0][0].message).toContain("2 sessions left");
    const claims = await prisma.notificationEvent.findMany({
      where: { recordUserId: OWNER_ID },
    });
    expect(claims.map((c) => c.dedupKey)).toEqual([
      `series-expiry:${series.id}:${validUntil}`,
    ]);
  });

  it("stays silent for an ended series and one with nothing left", async () => {
    await seedExpiring({
      endedOn: dayKeyAsUtcMidnight(shiftDateKey(today, -1)),
    });
    await seedExpiring({ done: 3 });
    const dispatch = vi.fn().mockResolvedValue({ dispatched: true });

    const summary = await runTreatmentSeriesExpiryTick(getPrismaClient(), now, {
      dispatch,
    });

    expect(summary.candidates).toBe(1);
    expect(summary.skippedNothingLeft).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
