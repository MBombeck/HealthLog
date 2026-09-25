/**
 * A catalogue key the instance no longer knows must not cost the file.
 *
 * Three of the restore's lookups resolve a key against a seeded catalogue —
 * cycle symptoms, illness symptoms, mood factors. Each of them used to throw on
 * a key it could not resolve, and the throw was inside the one transaction that
 * wipes and rebuilds the account. So one retired symptom rolled everything back:
 * no measurements, no doses, no notes, no cycle history, HTTP 500. A backup a
 * year old, restored onto an instance three releases newer, is the ordinary
 * case for a backup, not a corrupt file.
 *
 * The link is dropped and reported now. This test proves both halves against
 * the REAL admin restore route and against ROWS, never against a helper's
 * return value:
 *
 *   - everything else in the file lands (the measurement is the load-bearing
 *     assertion — it is the data the old behaviour destroyed to protect a
 *     symptom chip),
 *   - the surviving symptom keeps its link,
 *   - the retired key's link is gone AND named in the response, with the count,
 *   - the retired key is not resurrected in the catalogue: a restore does not
 *     get to invent reference data on the instance's behalf.
 *
 * Every owner row is deleted before the restore runs. That is the vacuousness
 * guard, not tidiness: leave the fixture in place and a restore that did
 * nothing at all would still find the rows sitting there and pass.
 *
 * Mutation check: put the `throw new Error("Unknown cycle symptom keys: …")`
 * back in `restoreCycleData` and this test fails on `expected 500 to be 200`.
 * Excise the whole `prisma.$transaction` body and it fails on the measurement
 * that never came back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "./restore-job-driver";
import { invalidateUserData } from "@/lib/cache/invalidate";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

/**
 * Catalogue rows the fixture owns, so the test never mutates the migration
 * seed other tests in the same container depend on. `userId: null` on the two
 * cycle rows is what makes them CATALOGUE rows: the payload builder carries
 * only `where: { userId }` symptoms in `customSymptoms`, so a NULL-owner key
 * the instance drops afterwards has nothing in the file that could put it back.
 * That is exactly the drift being modelled.
 */
const KEPT_CYCLE_KEY = "test:cycle-symptom-that-stays";
const RETIRED_CYCLE_KEY = "test:cycle-symptom-retired-later";
const KEPT_ILLNESS_KEY = "test:illness-symptom-that-stays";
const RETIRED_ILLNESS_KEY = "test:illness-symptom-retired-later";
const KEPT_MOOD_KEY = "test:mood-factor-that-stays";
const RETIRED_MOOD_KEY = "test:mood-factor-retired-later";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(invalidateUserData).mockClear();
});

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

describe("a backup naming a catalogue key this instance retired", () => {
  it("restores the file, drops only the unresolvable links, and names them", async () => {
    const prisma = getPrismaClient();

    // Owner and operator are the same account so the fixture stays about the
    // catalogue rather than about the ownership guard.
    const owner = await prisma.user.create({
      data: {
        username: "catalogue-drift-owner",
        email: "catalogue-drift-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    /* ── the catalogues, before the drift ──────────────────────────────── */

    const cycleCategory = await prisma.cycleSymptomCategory.findFirstOrThrow();
    const keptCycleSymptom = await prisma.cycleSymptom.create({
      data: {
        categoryId: cycleCategory.id,
        key: KEPT_CYCLE_KEY,
        labelKey: "cycle.symptom.kept",
        sortOrder: 1,
      },
    });
    const retiredCycleSymptom = await prisma.cycleSymptom.create({
      data: {
        categoryId: cycleCategory.id,
        key: RETIRED_CYCLE_KEY,
        labelKey: "cycle.symptom.retired",
        sortOrder: 2,
      },
    });

    const keptIllnessSymptom = await prisma.illnessSymptom.create({
      data: { key: KEPT_ILLNESS_KEY, labelKey: "illness.symptom.kept" },
    });
    const retiredIllnessSymptom = await prisma.illnessSymptom.create({
      data: { key: RETIRED_ILLNESS_KEY, labelKey: "illness.symptom.retired" },
    });

    const moodCategory = await prisma.moodTagCategory.findFirstOrThrow({
      where: { userId: null },
    });
    const keptMoodTag = await prisma.moodTag.create({
      data: {
        categoryId: moodCategory.id,
        key: KEPT_MOOD_KEY,
        labelKey: "mood.factor.kept",
        kind: "RATED",
        scaleMin: 1,
        scaleMax: 5,
      },
    });
    const retiredMoodTag = await prisma.moodTag.create({
      data: {
        categoryId: moodCategory.id,
        key: RETIRED_MOOD_KEY,
        labelKey: "mood.factor.retired",
        kind: "RATED",
        scaleMin: 1,
        scaleMax: 5,
      },
    });

    /* ── the account's data ────────────────────────────────────────────── */

    // The measurement carries no catalogue reference at all, which is the
    // point: it is what the whole-file refusal was destroying.
    await prisma.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 81.4,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-07-03T06:30:00.000Z"),
      },
    });

    const cycle = await prisma.menstrualCycle.create({
      data: {
        userId: owner.id,
        startDate: "2026-07-01",
        periodEndDate: "2026-07-05",
        tz: "Europe/Berlin",
      },
    });
    await prisma.cycleDayLog.create({
      data: {
        userId: owner.id,
        cycleId: cycle.id,
        date: "2026-07-03",
        flow: "MEDIUM",
        source: "MANUAL",
        tz: "Europe/Berlin",
        symptomLinks: {
          create: [
            { symptomId: keptCycleSymptom.id, severity: 2 },
            { symptomId: retiredCycleSymptom.id, severity: 4 },
          ],
        },
      },
    });

    // A SECOND day carrying the retired symptom. The report has to count links,
    // not distinct keys: one key across two days is two lost links, and
    // reporting it as one understates the loss by half.
    await prisma.cycleDayLog.create({
      data: {
        userId: owner.id,
        cycleId: cycle.id,
        date: "2026-07-04",
        flow: "LIGHT",
        source: "MANUAL",
        tz: "Europe/Berlin",
        symptomLinks: { create: [{ symptomId: retiredCycleSymptom.id }] },
      },
    });

    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: owner.id,
        label: "Summer cold",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: new Date("2026-07-02T00:00:00.000Z"),
        dayLogs: {
          create: {
            userId: owner.id,
            date: "2026-07-03",
            functionalImpact: 2,
            symptomLinks: {
              create: [
                { symptomId: keptIllnessSymptom.id, severity: 1 },
                { symptomId: retiredIllnessSymptom.id, severity: 3 },
              ],
            },
          },
        },
      },
    });

    const moodEntry = await prisma.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-07-03",
        mood: "GOOD",
        score: 4,
        source: "MOODLOG",
        moodLoggedAt: new Date("2026-07-03T19:00:00.000Z"),
        tagLinks: {
          create: [
            { moodTagId: keptMoodTag.id, rating: 3 },
            { moodTagId: retiredMoodTag.id, rating: 5 },
          ],
        },
      },
    });

    /* ── the real writer, the real wire format, the real reader ────────── */

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "CATALOGUE_DRIFT_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });

    /* ── the drift: three keys the instance stops carrying ─────────────── */

    await prisma.cycleSymptom.delete({ where: { id: retiredCycleSymptom.id } });
    await prisma.illnessSymptom.delete({
      where: { id: retiredIllnessSymptom.id },
    });
    await prisma.moodTag.delete({ where: { id: retiredMoodTag.id } });

    // Every owner row goes before the restore runs, so nothing below can pass
    // on a row the fixture left behind. A restore that did nothing at all has
    // to fail this test.
    await prisma.measurement.deleteMany({ where: { userId: owner.id } });
    await prisma.cycleDayLog.deleteMany({ where: { userId: owner.id } });
    await prisma.menstrualCycle.deleteMany({ where: { userId: owner.id } });
    await prisma.illnessEpisode.deleteMany({ where: { userId: owner.id } });
    await prisma.moodEntry.deleteMany({ where: { userId: owner.id } });
    expect(
      await prisma.measurement.count({ where: { userId: owner.id } }),
    ).toBe(0);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    // The whole file came back. Pre-fix this was 500 and the account was empty.
    expect(response.status).toBe(200);

    /* ── what actually landed in the database ──────────────────────────── */

    // The data the old behaviour threw away to protect a symptom chip.
    const measurements = await prisma.measurement.findMany({
      where: { userId: owner.id },
      select: { type: true, value: true, unit: true },
    });
    expect(measurements).toEqual([{ type: "WEIGHT", value: 81.4, unit: "kg" }]);

    const restoredDayLogs = await prisma.cycleDayLog.findMany({
      where: { userId: owner.id },
      orderBy: { date: "asc" },
      include: { symptomLinks: { include: { symptom: true } } },
    });
    // Both days come back, including the one whose ONLY symptom was retired.
    // A day-log stripped of its last link is still the day the person logged:
    // the flow, the timezone, the note are all still theirs.
    expect(restoredDayLogs.map((d) => d.flow)).toEqual(["MEDIUM", "LIGHT"]);
    // The surviving symptom keeps its link AND its intensity; the retired one
    // is simply not there.
    expect(
      restoredDayLogs[0].symptomLinks.map((link) => ({
        key: link.symptom.key,
        severity: link.severity,
      })),
    ).toEqual([{ key: KEPT_CYCLE_KEY, severity: 2 }]);
    expect(restoredDayLogs[1].symptomLinks).toEqual([]);

    const restoredIllnessDayLog = await prisma.illnessDayLog.findFirstOrThrow({
      where: { userId: owner.id },
      include: { symptomLinks: { include: { symptom: true } } },
    });
    expect(restoredIllnessDayLog.episodeId).toBe(episode.id);
    expect(restoredIllnessDayLog.functionalImpact).toBe(2);
    expect(
      restoredIllnessDayLog.symptomLinks.map((link) => ({
        key: link.symptom.key,
        severity: link.severity,
      })),
    ).toEqual([{ key: KEPT_ILLNESS_KEY, severity: 1 }]);

    const restoredMood = await prisma.moodEntry.findFirstOrThrow({
      where: { userId: owner.id },
      include: { tagLinks: { include: { moodTag: true } } },
    });
    expect(restoredMood.id).toBe(moodEntry.id);
    expect(restoredMood.score).toBe(4);
    expect(
      restoredMood.tagLinks.map((link) => ({
        key: link.moodTag.key,
        rating: link.rating,
      })),
    ).toEqual([{ key: KEPT_MOOD_KEY, rating: 3 }]);

    /* ── what the operator is told ─────────────────────────────────────── */

    const body = (await response.json()) as {
      data: {
        skipped: {
          links: number;
          catalogueKeys: Array<{
            catalogue: string;
            key: string;
            links: number;
          }>;
        };
      };
    };
    // Four links across three keys — the cycle symptom was on two days.
    expect(body.data.skipped.links).toBe(4);
    expect(body.data.skipped.catalogueKeys).toEqual([
      { catalogue: "cycleSymptom", key: RETIRED_CYCLE_KEY, links: 2 },
      { catalogue: "illnessSymptom", key: RETIRED_ILLNESS_KEY, links: 1 },
      { catalogue: "moodFactor", key: RETIRED_MOOD_KEY, links: 1 },
    ]);

    // The durable half. A screen gets closed; the audit row is still here.
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.backups.restore" },
      orderBy: { createdAt: "desc" },
    });
    // `AuditLog.details` is a JSON string column, not a Json column.
    const auditDetails = JSON.parse(auditRow.details ?? "{}") as {
      skipped?: {
        links?: number;
        catalogueKeys?: Array<{ key: string }>;
      };
    };
    expect(auditDetails.skipped?.links).toBe(4);
    expect(auditDetails.skipped?.catalogueKeys?.map((e) => e.key)).toEqual([
      RETIRED_CYCLE_KEY,
      RETIRED_ILLNESS_KEY,
      RETIRED_MOOD_KEY,
    ]);

    // A restore reads reference data; it does not get to write it. Minting the
    // retired keys back into the catalogue would preserve the links at the cost
    // of a row that collides with whatever the next migration seeds under that
    // key, and of a label nothing in the app can translate.
    expect(
      await prisma.cycleSymptom.count({ where: { key: RETIRED_CYCLE_KEY } }),
    ).toBe(0);
    expect(
      await prisma.illnessSymptom.count({
        where: { key: RETIRED_ILLNESS_KEY },
      }),
    ).toBe(0);
    expect(
      await prisma.moodTag.count({ where: { key: RETIRED_MOOD_KEY } }),
    ).toBe(0);
  });
});
