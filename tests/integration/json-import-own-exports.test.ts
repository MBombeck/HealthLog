/**
 * The JSON import takes the app's own files back, whole.
 *
 * An account with every column filled in (`json-import-seed.ts`) is written
 * out by the full backup (the portable export, `/api/export/full-backup`) and
 * by the JSON export (`/api/export?format=json`), each file is imported into
 * a fresh account, and the fresh account is written out again by the same
 * exporter. The two files must agree on everything the import carries; what
 * it deliberately leaves out is named in `json-import-field-coverage.test.ts`
 * and is the only thing stripped before the comparison.
 *
 * Reading the result back through the exporter rather than through a
 * hand-written projection of the tables is the point: a field the import
 * drops shows up as a difference in the file a person would get back, which
 * is the loss that matters, and a field an exporter learns to write is
 * compared from the release it starts.
 *
 * Both files spell an empty field their own way, `null` in the backup and an
 * empty string in the export. Before the import read files in the exporter's
 * terms, the first empty note, tag list or glucose context refused the whole
 * file with a 422.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as exportJson } from "@/app/api/export/route";
import { POST as importCsv } from "@/app/api/import/csv/route";
import { GET as exportMeasurementsCsv } from "@/app/api/export/measurements/route";
import { POST as importJson } from "@/app/api/import/route";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { derivedVocabularyKey } from "@/lib/import/json/vocabulary";
import { decryptCustomLabel, encryptCustomLabel } from "@/lib/mood/custom-tags";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import {
  JI_OWN_TAG_KEY,
  JI_OWN_TAG_LABEL,
  seedJsonImportCatalogue,
  seedJsonImportOwner,
} from "./json-import-seed";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

type Row = Record<string, unknown>;

interface ImportStats {
  measurements: number;
  moodEntries: number;
  skipped: number;
  droppedTagKeys?: string[];
  droppedFactorKeys?: string[];
  keptMoodTagKeys?: string[];
}

let ownerId: string;

interface FullBackup {
  measurements: Row[];
  moodEntries: Row[];
  customMoodTags: Row[];
  customMoodTagCategories: Row[];
}

async function fullBackupOf(userId: string): Promise<FullBackup> {
  let text = "";
  await streamFullBackupJson(prisma, userId, (chunk) => {
    text += chunk;
  });
  return JSON.parse(text);
}

async function jsonExportOf(userId: string): Promise<{
  data: { measurements: Row[]; moodEntries: Row[] };
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const res = await callRoute<unknown>(exportJson, {
    method: "GET",
    route: "/api/export",
    query: { format: "json", type: "all" },
    auth: await makeSession(user),
  });
  expect(res.status).toBe(200);
  return res.body as { data: { measurements: Row[]; moodEntries: Row[] } };
}

async function importInto(file: unknown) {
  const user = await makeUser({ timezone: "Europe/Berlin" });
  const res = await callRoute<ImportStats>(importJson, {
    method: "POST",
    route: "/api/import",
    body: file,
    auth: await makeSession(user),
  });
  return { userId: user.id, res };
}

/**
 * A file's own vocabulary, comparable across accounts and servers: each tag
 * with its group named by key rather than by a row id.
 */
function vocabularyOf(file: FullBackup) {
  const groupKey = new Map(
    file.customMoodTagCategories.map((c) => [c.id as string, c.key as string]),
  );
  const groups = new Map(
    file.customMoodTagCategories.map((c) => {
      const { id: _id, ...rest } = c;
      return [c.key as string, rest];
    }),
  );
  return file.customMoodTags
    .map((tag) => {
      const { categoryId, ...rest } = tag;
      const categoryKey =
        groupKey.get(categoryId as string) ?? (categoryId as string);
      return {
        ...rest,
        key: tag.key as string,
        categoryKey,
        group: groups.get(categoryKey) ?? null,
      };
    })
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** A row without the fields the import deliberately does not carry. */
function comparable(row: Row): Row {
  const { id: _id, source: _source, ...rest } = row;
  return rest;
}

function byInstant(at: string) {
  return (a: Row, b: Row) =>
    String(a[at]).localeCompare(String(b[at])) ||
    String(a.type ?? "").localeCompare(String(b.type ?? ""));
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedJsonImportCatalogue(prisma);
  ({ ownerId } = await seedJsonImportOwner(prisma));
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("the JSON import takes the app's own files back", () => {
  it("takes a full backup into another account of the same server, every link included", async () => {
    const original = await fullBackupOf(ownerId);
    // The file carries the shapes the import used to refuse or drop.
    expect(original.measurements.some((m) => m.notes === null)).toBe(true);
    expect(original.measurements.some((m) => m.sleepStage === "DEEP")).toBe(
      true,
    );
    expect(original.moodEntries.some((e) => e.context !== null)).toBe(true);

    const { userId, res } = await importInto(original);
    expect(res.status).toBe(200);
    // Every link lands: the owner's own tags come over as copies, under keys
    // of the importing account, because this server's keys are the owner's.
    expect(res.data).toEqual({
      measurements: original.measurements.length,
      moodEntries: original.moodEntries.length,
      skipped: 0,
    });
    const copyOf = (key: string) =>
      key.startsWith("custom:")
        ? derivedVocabularyKey("custom:", userId, key)
        : key.startsWith("customcat:")
          ? derivedVocabularyKey("customcat:", userId, key)
          : key;

    const back = await fullBackupOf(userId);
    expect(
      back.measurements.map(comparable).sort(byInstant("measuredAt")),
    ).toEqual(
      original.measurements.map(comparable).sort(byInstant("measuredAt")),
    );
    const expectedMood = original.moodEntries
      .map((entry) => ({
        ...comparable(entry),
        structuredTags: (entry.structuredTags as string[]).map(copyOf),
        factors: (entry.factors as Array<{ key: string; rating: number }>).map(
          (factor) => ({ ...factor, key: copyOf(factor.key) }),
        ),
      }))
      .sort(byInstant("loggedAt"));
    expect(
      back.moodEntries.map(comparable).sort(byInstant("loggedAt")),
    ).toEqual(expectedMood);
    expect(vocabularyOf(back)).toEqual(
      vocabularyOf(original)
        .map((tag) => ({
          ...tag,
          key: copyOf(tag.key),
          categoryKey: copyOf(tag.categoryKey),
          group: tag.group && {
            ...tag.group,
            key: copyOf(String(tag.group.key)),
          },
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );

    // A second import of the same file finds the copies.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const again = await callRoute<ImportStats>(importJson, {
      method: "POST",
      route: "/api/import",
      body: original,
      auth: await makeSession(user),
    });
    expect(again.status).toBe(200);
    expect(await prisma.moodTag.count({ where: { userId } })).toBe(
      original.customMoodTags.length,
    );
    expect(await prisma.moodTagCategory.count({ where: { userId } })).toBe(
      original.customMoodTagCategories.length,
    );
  });

  it("keeps the account's own name for a tag the file names differently, and says so", async () => {
    const original = await fullBackupOf(ownerId);
    // The owner renames the tag after the backup, then imports the backup.
    await prisma.moodTag.update({
      where: { key: JI_OWN_TAG_KEY },
      data: { labelEncrypted: encryptCustomLabel("Evening walk") },
    });
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
    });
    // The vocabulary alone: the readings of a portable file carry no source
    // id, and would be written a second time into the account they came from.
    const res = await callRoute<ImportStats>(importJson, {
      method: "POST",
      route: "/api/import",
      body: {
        customMoodTags: original.customMoodTags,
        customMoodTagCategories: original.customMoodTagCategories,
      },
      auth: await makeSession(owner),
    });
    expect(res.status).toBe(200);
    expect(res.data.keptMoodTagKeys).toEqual([JI_OWN_TAG_KEY]);
    const tag = await prisma.moodTag.findUniqueOrThrow({
      where: { key: JI_OWN_TAG_KEY },
    });
    expect(decryptCustomLabel(tag.labelEncrypted)).toBe("Evening walk");
    await prisma.moodTag.update({
      where: { key: JI_OWN_TAG_KEY },
      data: { labelEncrypted: encryptCustomLabel(JI_OWN_TAG_LABEL) },
    });
  });

  it("takes the JSON export back, empty strings and its envelope included", async () => {
    const original = await jsonExportOf(ownerId);
    expect(original.data.measurements.some((m) => m.notes === "")).toBe(true);
    expect(original.data.moodEntries.some((e) => e.note === "")).toBe(true);

    const { userId, res } = await importInto(original);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      measurements: original.data.measurements.length,
      moodEntries: original.data.moodEntries.length,
      skipped: 0,
    });

    // A sleep night is one summary record in this file, and its `notes` is
    // the stage breakdown the exporter writes from the stored stages. The
    // import stores the night and that text as its note; a re-export
    // rebuilds the column from stages the summary does not have. So the
    // night's note is compared against what was stored, and the rest of the
    // record through the file.
    const nights = original.data.measurements.filter(
      (m) => m.type === "SLEEP_DURATION",
    );
    expect(nights).toHaveLength(1);
    const storedNight = await prisma.measurement.findFirstOrThrow({
      where: { userId, type: "SLEEP_DURATION" },
    });
    expect(readNote(storedNight.notesEncrypted, storedNight.notes)).toBe(
      nights[0]!.notes,
    );
    const withoutNightNote = (m: Row) =>
      m.type === "SLEEP_DURATION"
        ? { ...comparable(m), notes: null }
        : comparable(m);

    const back = await jsonExportOf(userId);
    expect(
      back.data.measurements
        .map(withoutNightNote)
        .sort(byInstant("measuredAt")),
    ).toEqual(
      original.data.measurements
        .map(withoutNightNote)
        .sort(byInstant("measuredAt")),
    );
    expect(
      back.data.moodEntries.map(comparable).sort(byInstant("loggedAt")),
    ).toEqual(
      original.data.moodEntries.map(comparable).sort(byInstant("loggedAt")),
    );
  });

  it("leaves out a disaster-recovery file's deletion records, and counts them", async () => {
    const { payload } = await buildFullBackupPayload(prisma, ownerId, {
      purpose: "disaster-recovery",
    });
    const rows = (payload as { measurements: Row[] }).measurements;
    const deleted = rows.filter((m) => typeof m.deletedAt === "string");
    expect(deleted).toHaveLength(1);

    const { userId, res } = await importInto(payload);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      measurements: rows.length - deleted.length,
      skipped: deleted.length,
    });
    expect(
      await prisma.measurement.count({ where: { userId, value: 90 } }),
    ).toBe(0);
  });

  it("takes the same file twice without changing what the first import wrote", async () => {
    const original = await fullBackupOf(ownerId);
    const { userId } = await importInto(original);
    const first = await fullBackupOf(userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const again = await callRoute<ImportStats>(importJson, {
      method: "POST",
      route: "/api/import",
      body: original,
      auth: await makeSession(user),
    });
    expect(again.status).toBe(200);
    // The mood entries carry their instant, so the second pass finds them;
    // the readings carry no source id in a portable file and are written
    // again, as the import has always documented for a file without one.
    expect(again.data.moodEntries).toBe(0);
    const second = await fullBackupOf(userId);
    expect(
      second.moodEntries.map(comparable).sort(byInstant("loggedAt")),
    ).toEqual(first.moodEntries.map(comparable).sort(byInstant("loggedAt")));
  });
});

describe("a full backup moved to another server", () => {
  it("comes back equal, the account's own tags, groups and rated factor included", async () => {
    const original = await fullBackupOf(ownerId);
    expect(original.customMoodTags.length).toBeGreaterThanOrEqual(2);
    expect(original.customMoodTags.some((tag) => tag.kind === "RATED")).toBe(
      true,
    );
    expect(original.customMoodTagCategories).toHaveLength(1);

    // Another server: the same seeded catalogue, none of this account's rows.
    await truncateAllTables(prisma);
    await seedJsonImportCatalogue(prisma);

    const { userId, res } = await importInto(original);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      measurements: original.measurements.length,
      moodEntries: original.moodEntries.length,
      skipped: 0,
    });

    const back = await fullBackupOf(userId);
    expect(
      back.measurements.map(comparable).sort(byInstant("measuredAt")),
    ).toEqual(
      original.measurements.map(comparable).sort(byInstant("measuredAt")),
    );
    expect(
      back.moodEntries.map(comparable).sort(byInstant("loggedAt")),
    ).toEqual(original.moodEntries.map(comparable).sort(byInstant("loggedAt")));
    expect(vocabularyOf(back)).toEqual(vocabularyOf(original));
  });
});

describe("the CSV import reads the measurement CSV export", () => {
  const READINGS = [
    { type: "WEIGHT", value: 81.4, unit: "kg", at: "2026-09-10T06:30:00.000Z" },
    { type: "PULSE", value: 62, unit: "bpm", at: "2026-09-11T07:00:00.000Z" },
    {
      type: "BLOOD_GLUCOSE",
      value: 104,
      unit: "mg/dL",
      at: "2026-09-12T08:00:00.000Z",
      glucoseContext: "FASTING" as const,
    },
  ] as const;

  it("takes it back, in display units too", async () => {
    const owner = await makeUser({
      timezone: "Europe/Berlin",
      glucoseUnit: "mmol/L",
    });
    for (const m of READINGS) {
      await prisma.measurement.create({
        data: {
          userId: owner.id,
          type: m.type,
          value: m.value,
          unit: m.unit,
          measuredAt: new Date(m.at),
          source: "MANUAL",
          notesEncrypted: encryptNote(null),
          glucoseContext: "glucoseContext" in m ? m.glucoseContext : null,
        },
      });
    }
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
    expect(res.data).toMatchObject({ inserted: READINGS.length, skipped: 0 });

    const read = async (userId: string) =>
      (
        await prisma.measurement.findMany({
          where: { userId, deletedAt: null },
          orderBy: [{ measuredAt: "asc" }, { type: "asc" }],
        })
      ).map((m) => ({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt.toISOString(),
        glucoseContext: m.glucoseContext,
        note: readNote(m.notesEncrypted, m.notes),
      }));
    const back = await read(user.id);
    const original = await read(owner.id);
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
