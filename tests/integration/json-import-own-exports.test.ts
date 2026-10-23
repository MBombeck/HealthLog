/**
 * The JSON import takes the app's own files back.
 *
 * An account's full backup (`/api/export/full-backup`, the portable export)
 * and its JSON export (`/api/export?format=json`) are written, as they are
 * served, and imported into a fresh account. What the import carries (a
 * measurement's type, value, unit, instant, glucose context and note; a mood
 * entry's day, label, score, tags and instant) must come back as it was.
 *
 * Both files spell an empty field their own way, `null` in the backup and an
 * empty string in the export. Before the import read files in the exporter's
 * terms, the first empty note, tag list or glucose context refused the whole
 * file with a 422. The portable backup also left a reading's own attributes
 * out (a glucose value's fasting context among them), so the backup half
 * pins those too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as exportJson } from "@/app/api/export/route";
import { POST as importCsv } from "@/app/api/import/csv/route";
import { GET as exportMeasurementsCsv } from "@/app/api/export/measurements/route";
import { POST as importJson } from "@/app/api/import/route";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const MEASUREMENTS = [
  {
    type: "WEIGHT",
    value: 81.4,
    unit: "kg",
    at: "2026-09-10T06:30:00.000Z",
    note: "after the run",
  },
  {
    type: "WEIGHT",
    value: 81.9,
    unit: "kg",
    at: "2026-09-11T06:30:00.000Z",
    note: null,
  },
  {
    type: "PULSE",
    value: 62,
    unit: "bpm",
    at: "2026-09-11T07:00:00.000Z",
    note: null,
  },
  {
    type: "BLOOD_GLUCOSE",
    value: 104,
    unit: "mg/dL",
    at: "2026-09-12T08:00:00.000Z",
    note: null,
    glucoseContext: "FASTING" as const,
  },
  {
    type: "BLOOD_GLUCOSE",
    value: 141,
    unit: "mg/dL",
    at: "2026-09-12T13:00:00.000Z",
    note: "after lunch",
    glucoseContext: "POSTPRANDIAL" as const,
  },
] as const;

const MOOD = [
  {
    date: "2026-09-10",
    mood: "GUT",
    score: 4,
    tags: null,
    at: "2026-09-10T19:00:00.000Z",
  },
  {
    date: "2026-09-11",
    mood: "OKAY",
    score: 3,
    tags: JSON.stringify(["work", "sleep"]),
    at: "2026-09-11T20:30:00.000Z",
  },
  {
    date: "2026-09-12",
    mood: "SUPER_GUT",
    score: 5,
    tags: null,
    at: "2026-09-12T21:15:00.000Z",
  },
] as const;

let ownerId: string;

async function seedOwner(): Promise<void> {
  const owner = await makeUser({
    timezone: "Europe/Berlin",
    glucoseUnit: "mmol/L" /* the JSON export stays in the stored unit */,
  });
  ownerId = owner.id;
  for (const m of MEASUREMENTS) {
    await prisma.measurement.create({
      data: {
        userId: ownerId,
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: new Date(m.at),
        source: "MANUAL",
        notes: null,
        notesEncrypted: encryptNote(m.note),
        glucoseContext: "glucoseContext" in m ? m.glucoseContext : null,
      },
    });
  }
  // A reading deleted before the backup: its row is the record of a
  // deletion, and the import leaves it out.
  await prisma.measurement.create({
    data: {
      userId: ownerId,
      type: "WEIGHT",
      value: 90,
      unit: "kg",
      measuredAt: new Date("2026-09-09T06:30:00.000Z"),
      source: "MANUAL",
      deletedAt: new Date("2026-09-09T07:00:00.000Z"),
    },
  });
  for (const e of MOOD) {
    await prisma.moodEntry.create({
      data: {
        userId: ownerId,
        date: e.date,
        mood: e.mood,
        score: e.score,
        tags: e.tags,
        source: "MANUAL",
        moodLoggedAt: new Date(e.at),
      },
    });
  }
}

/** What an import carries, read back from an account. */
async function carried(userId: string) {
  const measurements = await prisma.measurement.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ measuredAt: "asc" }, { type: "asc" }],
  });
  const mood = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null },
    orderBy: { moodLoggedAt: "asc" },
  });
  return {
    measurements: measurements.map((m) => ({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt.toISOString(),
      glucoseContext: m.glucoseContext,
      note: readNote(m.notesEncrypted, m.notes),
    })),
    mood: mood.map((e) => ({
      date: e.date,
      mood: e.mood,
      score: e.score,
      tags: e.tags,
      loggedAt: e.moodLoggedAt.toISOString(),
    })),
  };
}

async function importInto(file: unknown) {
  const user = await makeUser({ timezone: "Europe/Berlin" });
  const res = await callRoute<{
    data: { measurements: number; moodEntries: number; skipped: number };
  }>(importJson, {
    method: "POST",
    route: "/api/import",
    body: file,
    auth: await makeSession(user),
  });
  return { userId: user.id, res };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedOwner();
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("the JSON import reads the app's own files", () => {
  it("takes a full backup back, nulls and deletion records included", async () => {
    let text = "";
    await streamFullBackupJson(prisma, ownerId, (chunk) => {
      text += chunk;
    });
    const backup = JSON.parse(text) as {
      measurements: Array<Record<string, unknown>>;
      moodEntries: Array<Record<string, unknown>>;
    };
    // The file carries the shapes the import used to refuse.
    expect(backup.measurements.some((m) => m.notes === null)).toBe(true);
    expect(backup.moodEntries.some((e) => e.tags === null)).toBe(true);

    const { userId, res } = await importInto(backup);
    expect(res.status).toBe(200);
    const deletedInFile = backup.measurements.filter(
      (m) => typeof m.deletedAt === "string",
    ).length;
    expect(res.data).toEqual({
      measurements: MEASUREMENTS.length,
      moodEntries: MOOD.length,
      skipped: deletedInFile,
    });

    expect(await carried(userId)).toEqual(await carried(ownerId));
  });

  it("takes the JSON export back, empty strings and its envelope included", async () => {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
    });
    const exported = await callRoute<unknown>(exportJson, {
      method: "GET",
      route: "/api/export",
      query: { format: "json", type: "all" },
      auth: await makeSession(owner),
    });
    expect(exported.status).toBe(200);
    const file = exported.body as {
      data: {
        measurements: Array<Record<string, unknown>>;
        moodEntries: Array<Record<string, unknown>>;
      };
    };
    expect(file.data.measurements.some((m) => m.notes === "")).toBe(true);
    expect(file.data.moodEntries.some((e) => e.tags === "")).toBe(true);

    const { userId, res } = await importInto(file);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      measurements: MEASUREMENTS.length,
      moodEntries: MOOD.length,
    });

    expect(await carried(userId)).toEqual(await carried(ownerId));
  });

  it("takes the measurement CSV back into the CSV import, in display units too", async () => {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
    });
    const exported = await callRoute(exportMeasurementsCsv, {
      method: "GET",
      route: "/api/export/measurements",
      auth: await makeSession(owner),
    });
    expect(exported.status).toBe(200);
    const csv = String(exported.body);
    // The account reads glucose in mmol/L, so that is what the file says.
    expect(csv).toMatch(/BLOOD_GLUCOSE,\d+(\.\d)?,mmol\/L/);

    const user = await makeUser({ timezone: "Europe/Berlin" });
    const res = await callRoute<{ inserted: number; skipped: number }>(
      importCsv,
      {
        method: "POST",
        route: "/api/import/csv",
        text: csv,
        headers: { "content-type": "text/csv" },
        auth: await makeSession(user),
      },
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      inserted: MEASUREMENTS.length,
      skipped: 0,
    });

    const back = (await carried(user.id)).measurements;
    const original = (await carried(ownerId)).measurements;
    expect(back).toHaveLength(original.length);
    back.forEach((m, i) => {
      const o = original[i]!;
      // mmol/L at one decimal: the stored mg/dL value comes back within it.
      const tolerance = m.type === "BLOOD_GLUCOSE" ? 0.05 * 18.0156 : 1e-9;
      expect({ ...m, value: 0 }).toEqual({ ...o, value: 0 });
      expect(Math.abs(m.value - o.value)).toBeLessThanOrEqual(tolerance);
    });
  });
});
