/**
 * Every field the app's exporters write for a reading or a mood entry is
 * either read by the JSON import or named here with the reason it is not.
 *
 * The same kind of guard as `measurement-backup-completeness.test.ts` and
 * `mood-backup-completeness.test.ts`, one step further down the pipe: those
 * prove a column reaches the file, this one proves a field of the file reaches
 * the import. The JSON import used to read six measurement fields and six
 * mood fields while the files carried twice that, so a sleep night came back
 * as stageless rows, a range as a single value, a mood entry without its note,
 * its sliders, its links or its day.
 *
 * The field sets are read from what the exporters actually write, for an
 * account with every column filled in (`json-import-seed.ts`), so a field an
 * exporter learns to write appears here the release it does. Each file is
 * walked in both of its forms: the JSON export, the portable full backup and
 * the disaster-recovery backup.
 *
 * The reasons are checked the other way too: a reason for a field no exporter
 * writes any more is stale and fails, so the list cannot grow into a list of
 * things that were once true.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as exportJson } from "@/app/api/export/route";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import {
  jsonImportMeasurementSchema,
  jsonImportMoodContextSchema,
  jsonImportMoodEntrySchema,
} from "@/lib/import/json/schema";

import { callRoute } from "../kit/call-route";
import { makeSession } from "../kit/factories";
import {
  seedJsonImportCatalogue,
  seedJsonImportOwner,
} from "./json-import-seed";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

/** Why a field of an exported row is not a field of the imported one. */
const ROW_ID =
  "The import writes new rows into the importing account; the file's row id names a row of the account it came from.";
const SOURCE =
  "Every imported row is stamped IMPORT. Source priority and the sync paths key on the source, and a row claiming an integration would be taken for that integration's own.";
const DELETED_AT =
  "A deletion record, not a reading: the import skips the row and counts it (`normalize.ts`).";
const CIPHERTEXT =
  "Ciphertext under the exporting instance's key (disaster-recovery file only). The portable file carries the same note as text, and that is what the import reads.";
const BOOKKEEPING =
  "Sync bookkeeping of the account the file came from (disaster-recovery file only). It describes that account's history with its sources, not the reading.";
const ROW_STAMP =
  "The row's own write stamp (disaster-recovery file only); an imported row is written now.";

const MEASUREMENT_NOT_IMPORTED: Record<string, string> = {
  id: ROW_ID,
  source: SOURCE,
  deletedAt: DELETED_AT,
  notesEncrypted: CIPHERTEXT,
  externalSourceVersion: BOOKKEEPING,
  aggregationProvenance: BOOKKEEPING,
  ingestTokenId:
    "The API token that wrote the reading on the exporting account; no token of that account exists in the importing one.",
  syncVersion: BOOKKEEPING,
  createdAt: ROW_STAMP,
  updatedAt: ROW_STAMP,
};

const MOOD_NOT_IMPORTED: Record<string, string> = {
  id: ROW_ID,
  source: SOURCE,
  deletedAt: DELETED_AT,
  noteEncrypted: CIPHERTEXT,
  syncedAt: BOOKKEEPING,
  syncVersion: BOOKKEEPING,
  createdAt: ROW_STAMP,
  updatedAt: ROW_STAMP,
  linkCreatedAt: ROW_STAMP,
};

const CONTEXT_NOT_IMPORTED: Record<string, string> = {
  notesEncrypted: CIPHERTEXT,
  createdAt: ROW_STAMP,
  updatedAt: ROW_STAMP,
};

/**
 * The files' other sections. The JSON import carries readings and mood
 * entries into an account that has its own record already; an account's
 * whole record (medications, labs, documents, settings, …) comes back through
 * the backup restore, which replaces it. The mood vocabulary is named apart
 * because the entries' links point into it: a link to a tag the importing
 * account does not have is dropped and named in the response.
 */
const IMPORTED_SECTIONS = new Set(["measurements", "moodEntries"]);
const VOCABULARY_SECTIONS: Record<string, string> = {
  customMoodTags:
    "Account vocabulary, restored by the backup restore. An imported link to one of these tags resolves only when the importing account has a tag of that key, and is otherwise dropped and named (`droppedTagKeys`).",
  customMoodTagCategories:
    "Account vocabulary, restored by the backup restore with the tags it groups.",
  hiddenMoodTags:
    "An account setting (which tags its editor hides), restored by the backup restore.",
};

type Row = Record<string, unknown>;

function keysOf(rows: readonly Row[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  return keys;
}

/** Fields of `written` the import neither reads nor names. */
function unaccounted(
  written: Set<string>,
  read: Set<string>,
  named: Record<string, string>,
): string[] {
  return [...written].filter((key) => !read.has(key) && !(key in named));
}

interface Files {
  jsonExport: { top: Row; measurements: Row[]; moodEntries: Row[] };
  portable: Row & { measurements: Row[]; moodEntries: Row[] };
  disasterRecovery: Row & { measurements: Row[]; moodEntries: Row[] };
}

let files: Files;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedJsonImportCatalogue(prisma);
  const { ownerId } = await seedJsonImportOwner(prisma);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  const exported = await callRoute<unknown>(exportJson, {
    method: "GET",
    route: "/api/export",
    query: { format: "json", type: "all" },
    auth: await makeSession(owner),
  });
  expect(exported.status).toBe(200);
  const data = (exported.body as { data: Row }).data;
  const portable = await buildFullBackupPayload(prisma, ownerId);
  const disasterRecovery = await buildFullBackupPayload(prisma, ownerId, {
    purpose: "disaster-recovery",
  });
  files = {
    jsonExport: {
      top: data,
      measurements: data.measurements as Row[],
      moodEntries: data.moodEntries as Row[],
    },
    portable: portable.payload as Files["portable"],
    disasterRecovery: disasterRecovery.payload as Files["disasterRecovery"],
  };
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

const MEASUREMENT_READ = new Set(
  Object.keys(jsonImportMeasurementSchema.shape),
);
const MOOD_READ = new Set(Object.keys(jsonImportMoodEntrySchema.shape));
const CONTEXT_READ = new Set(Object.keys(jsonImportMoodContextSchema.shape));

const FILE_NAMES = ["jsonExport", "portable", "disasterRecovery"] as const;

function measurementsOf(name: (typeof FILE_NAMES)[number]): Row[] {
  return files[name].measurements;
}
function moodOf(name: (typeof FILE_NAMES)[number]): Row[] {
  return files[name].moodEntries;
}
function contextsOf(name: (typeof FILE_NAMES)[number]): Row[] {
  return moodOf(name)
    .map((entry) => entry.context)
    .filter((context): context is Row => !!context);
}

describe("the JSON import reads what the exporters write", () => {
  it.each(FILE_NAMES)("every measurement field of the %s", (name) => {
    const rows = measurementsOf(name);
    expect(rows.length).toBeGreaterThan(3);
    expect(
      unaccounted(keysOf(rows), MEASUREMENT_READ, MEASUREMENT_NOT_IMPORTED),
    ).toEqual([]);
  });

  it.each(FILE_NAMES)("every mood-entry field of the %s", (name) => {
    const rows = moodOf(name);
    expect(rows.length).toBeGreaterThan(0);
    expect(unaccounted(keysOf(rows), MOOD_READ, MOOD_NOT_IMPORTED)).toEqual([]);
  });

  it.each(["portable", "disasterRecovery"] as const)(
    "every day-context field of the %s",
    (name) => {
      const rows = contextsOf(name);
      expect(rows.length).toBeGreaterThan(0);
      expect(
        unaccounted(keysOf(rows), CONTEXT_READ, CONTEXT_NOT_IMPORTED),
      ).toEqual([]);
    },
  );

  it("names the mood vocabulary the entries' links point into", () => {
    for (const name of ["portable", "disasterRecovery"] as const) {
      const sections = Object.keys(files[name]);
      expect(sections).toEqual(expect.arrayContaining([...IMPORTED_SECTIONS]));
      for (const section of Object.keys(VOCABULARY_SECTIONS)) {
        expect(sections, `${name} carries ${section}`).toContain(section);
      }
    }
    // The JSON export's other two sections are medications, restored the
    // same way as every other section of an account's record.
    expect(Object.keys(files.jsonExport.top).sort()).toEqual([
      "intakeEvents",
      "measurements",
      "medications",
      "moodEntries",
    ]);
  });

  it("gives no reason for a field no exporter writes", () => {
    const writtenMeasurement = new Set(
      FILE_NAMES.flatMap((name) => [...keysOf(measurementsOf(name))]),
    );
    const writtenMood = new Set(
      FILE_NAMES.flatMap((name) => [...keysOf(moodOf(name))]),
    );
    const writtenContext = new Set(
      FILE_NAMES.flatMap((name) => [...keysOf(contextsOf(name))]),
    );
    const stale = [
      ...Object.keys(MEASUREMENT_NOT_IMPORTED)
        .filter((key) => !writtenMeasurement.has(key))
        .map((key) => `measurement.${key}`),
      ...Object.keys(MOOD_NOT_IMPORTED)
        .filter((key) => !writtenMood.has(key))
        .map((key) => `moodEntry.${key}`),
      ...Object.keys(CONTEXT_NOT_IMPORTED)
        .filter((key) => !writtenContext.has(key))
        .map((key) => `context.${key}`),
    ];
    expect(stale).toEqual([]);
  });

  it("reads no field it also names as left out", () => {
    const both = [
      ...Object.keys(MEASUREMENT_NOT_IMPORTED).filter((k) =>
        MEASUREMENT_READ.has(k),
      ),
      ...Object.keys(MOOD_NOT_IMPORTED).filter((k) => MOOD_READ.has(k)),
      ...Object.keys(CONTEXT_NOT_IMPORTED).filter((k) => CONTEXT_READ.has(k)),
    ];
    expect(both).toEqual([]);
  });
});
