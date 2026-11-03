/**
 * The backup file and the restored account, pinned against golden copies.
 *
 * The other backup tests each prove one property: every model comes back
 * (`backup-round-trip.test.ts`), every column does, a refusal happens before
 * the first delete. None of them says the whole file and the whole restored
 * account are what they were yesterday, and that is the claim a change to the
 * backup code has to keep when it means to change nothing. This file makes it:
 *
 *   1. Fill one account as far as the schema allows: a row of every
 *      two-ended model, every column of those rows, every column of the
 *      account row, the instance settings, and a sharing grant beside it.
 *   2. Export it both ways (disaster recovery, portable) and pin the files,
 *      their counts, the parsed payload and the preview.
 *   3. Restore each file into a fresh account, and the disaster-recovery file
 *      once more over the live account, and pin what the restore answered,
 *      the phases it reported, the audit rows and wide-event fields it wrote,
 *      every row the account holds afterwards, and the file it exports then.
 *   4. Restore a version-1 file in the old shapes (no ids, references by
 *      name, the retired heart-rate variability filing, the Coach switch in
 *      module availability) over an account that already holds rows.
 *   5. Hand the restore malformed and unresolvable files and pin each refusal
 *      and each skip report, and the schema's issue list for a bad file.
 *
 * The account carries a tombstone of every model that keeps them and both
 * self-references (a flare under its condition, a superseded profile fact),
 * so the second restore pass has something to resolve. Every timestamp the
 * database stamped while the fixture ran is pinned to a fixed historical
 * value, and the seeded account is asserted to hold none of this run's: a
 * restore that drops a row's `createdAt` then shows up as `<now>` against a
 * historical value instead of hiding behind a seeded `<now>`. The fixture is
 * sealed under the legacy key `v1`, and a second key is active from the
 * export on, so a value the restore re-encrypts instead of carrying over
 * comes back under `v2`.
 *
 * Values that legitimately differ between two runs are normalised, never
 * dropped: ids become `<id:N>` in order of first appearance, ciphertext
 * becomes the key id it names and the text it opens to (or its length when no
 * codec opens it), and a timestamp written during the run becomes `<now>`.
 * Key order is kept, so a file that carries the same values in another order
 * differs.
 *
 * `BACKUP_PARITY_WRITE=1` rewrites the golden copies. Only do that for a
 * change that means to alter the backup, and review the diff of
 * `tests/integration/__golden__/backup-parity/` as part of it. A change to
 * this harness itself writes them from the backup code as it was before the
 * change under test, never from the code being checked.
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  _resetCryptoCacheForTests,
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  extractKeyId,
  extractKeyIdFromBytes,
} from "@/lib/crypto";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { openDayCountry } from "@/lib/dawarich/connection";
import { openLocation } from "@/lib/environment/location-cipher";
import { decryptFactData, decryptFactProvenance } from "@/lib/documents/store";
import { decryptWaveformFromBytes } from "@/lib/withings/ecg-waveform-codec";
import { decryptNoteFromBytes } from "@/lib/labs/store";
import { decryptContextFromBytes } from "@/lib/labs/biomarker-store";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { createBackupPreviewCollector } from "@/lib/export/backup-preview";
import { TWO_ENDED_MODELS } from "@/lib/export/backup-plan";
import {
  restoreBackup,
  type RestoreBackupOutcome,
} from "@/lib/export/restore-backup";
import { STORED_BACKUP_SELECT } from "@/lib/export/stored-backup";
import { parseBackupPayload } from "@/lib/validations/backup";
import { summarizeBackup } from "@/lib/validations/backup-summary";
import { legacyStreamedBlobFrom } from "@/__tests__/helpers/legacy-backup-blob";
import {
  type AuditModel,
  enumValuesFromSchema,
  isDefaultValue,
  ownerWhere,
  readAuditModels,
  syntheticValue,
} from "./backup-column-audit";
import {
  AT,
  COLUMN_PRESENCE_ONLY,
  FILL_OVERRIDES,
  OWNER_ID,
  TOMBSTONE_DELETED_AT,
  USER_FILL_OVERRIDES,
  comparison,
  createOwner,
  delegateOf,
  primaryKeyWhere,
  seedAdminSession,
  seedColumnShapes,
  seedEveryTwoEndedModel,
} from "./backup-fixture";
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

/** What the restore asked of the world outside its transaction. */
const effects = vi.hoisted(() => ({
  invalidated: [] as string[],
  unitRefresh: [] as string[],
  foldRepair: [] as string[],
  annotations: [] as unknown[],
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn((userId: string) => {
    effects.invalidated.push(userId);
  }),
}));

vi.mock("@/lib/insights/unit-change-refresh", () => ({
  refreshTextsAfterUnitChange: vi.fn(async (userId: string) => {
    effects.unitRefresh.push(userId);
  }),
}));

vi.mock("@/lib/jobs/measurement-fold-repair", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueMeasurementFoldRepair: vi.fn(async (userId: string) => {
    effects.foldRepair.push(userId);
  }),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn((...args: Parameters<typeof actual.annotate>) => {
      effects.annotations.push(args[0]);
      return actual.annotate(...args);
    }),
  };
});

const GOLDEN_DIR = resolve(__dirname, "__golden__/backup-parity");
const WRITE = process.env.BACKUP_PARITY_WRITE === "1";
const EXPORTED_AT = new Date("2026-08-01T00:00:00.000Z");
const RUN_STARTED = Date.now();
const DELEGATE_ID = "parity-delegate";
const SLOW = 240_000;

// ── Normalisation ────────────────────────────────────────────────────────────

const CUID = /\bc[a-z0-9]{24}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const VERSIONED = /^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]{24,}$/;
const SEALED_KEY = /(Encrypted|Sealed)$/;

/** Every codec a sealed byte value is written with, tried in order. */
const BYTE_OPENERS: ReadonlyArray<(value: Uint8Array) => string> = [
  decryptFromBytes,
  decryptNoteFromBytes,
  decryptContextFromBytes,
  (value) => JSON.stringify(openLocation(value)),
  (value) => {
    const code = openDayCountry(value);
    if (code === null) throw new Error("not a sealed day country");
    return `country:${code}`;
  },
  (value) => JSON.stringify(decryptWaveformFromBytes(value)),
  (value) => JSON.stringify(decryptFactData(Buffer.from(value))),
  (value) => JSON.stringify(decryptFactProvenance(Buffer.from(value))),
  (value) => `bytes:${decryptBytes(Buffer.from(value)).toString("base64")}`,
];

function openBytes(value: Uint8Array): string | null {
  for (const open of BYTE_OPENERS) {
    try {
      const text = open(value);
      if (text !== undefined && text !== "null") return text;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The key id of a sealed byte value: the header of the binary codec, or the
 * `<id>.` prefix of a string-codec ciphertext stored as its UTF-8 bytes.
 * `-` for neither.
 */
function bytesKeyId(value: Uint8Array): string {
  const buffer = Buffer.from(value);
  return (
    extractKeyIdFromBytes(buffer) ??
    extractKeyId(buffer.toString("utf8")) ??
    "-"
  );
}

/**
 * The key id of a sealed string: the `<id>.` prefix of the string codec, or
 * the header of a sealed byte value carried as base64. `-` for neither (the
 * unversioned legacy string form, or another codec).
 */
function stringKeyId(value: string): string {
  const id = extractKeyId(value);
  if (id !== null) return id;
  if (value.length % 4 === 0 && BASE64.test(value)) {
    return bytesKeyId(Buffer.from(value, "base64"));
  }
  return "-";
}

function openString(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    // not the string codec; try it as base64 of a sealed byte value
  }
  if (value.length % 4 === 0 && BASE64.test(value)) {
    return openBytes(Buffer.from(value, "base64"));
  }
  return null;
}

/**
 * One normalisation pass. Ids are numbered in the order this pass first meets
 * them, so two documents normalised by two passes compare by shape.
 */
class Normaliser {
  private readonly ids = new Map<string, string>();
  private readonly windowFrom = RUN_STARTED - 5 * 60_000;
  private readonly days: ReadonlySet<string>;

  constructor() {
    const today = (t: number) => new Date(t).toISOString().slice(0, 10);
    this.days = new Set([today(RUN_STARTED), today(Date.now())]);
  }

  private alias(id: string): string {
    let alias = this.ids.get(id);
    if (!alias) {
      alias = `<id:${this.ids.size + 1}>`;
      this.ids.set(id, alias);
    }
    return alias;
  }

  text(value: string): string {
    const windowTo = Date.now() + 5 * 60_000;
    const out = value
      .replace(CUID, (id) => this.alias(id))
      .replace(ISO, (iso) => {
        if (iso === TOMBSTONE_DELETED_AT) return "<tombstone>";
        const at = Date.parse(iso);
        return at >= this.windowFrom && at <= windowTo ? "<now>" : iso;
      });
    return DAY.test(out) && this.days.has(out) ? "<today>" : out;
  }

  /**
   * A sealed string, as the key it was sealed under and the text it opens to.
   * The key id is part of the comparison: a restore that re-encrypted a value
   * the file carried as ciphertext opens to the same text under another key,
   * and only the id shows it.
   */
  sealed(value: string): string {
    const opened = openString(value);
    const kid = stringKeyId(value);
    return opened === null
      ? `<sealed:${kid}:${value.length}>`
      : `<sealed:${kid}:${this.text(opened)}>`;
  }

  /** A JSON value, key order kept. */
  json(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (SEALED_KEY.test(key) || VERSIONED.test(value)) {
        const opened = openString(value);
        if (opened !== null || SEALED_KEY.test(key)) return this.sealed(value);
      }
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.json(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.json(v, k)]),
      );
    }
    return value;
  }

  /** A database value: dates, bytes, decimals and big integers made JSON. */
  db(value: unknown, key = ""): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return this.text(value.toISOString());
    if (value instanceof Uint8Array) {
      const opened = openBytes(value);
      return opened === null
        ? `<bytes:${Buffer.from(value).toString("base64")}>`
        : `<sealed:${bytesKeyId(value)}:${this.text(opened)}>`;
    }
    if (typeof value === "bigint") return `bigint:${value}`;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      "toFixed" in value
    ) {
      return `decimal:${String(value)}`;
    }
    if (Array.isArray(value)) return value.map((item) => this.db(item, key));
    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as object).map(([k, v]) => [k, this.db(v, k)]),
      );
    }
    return this.json(value, key);
  }
}

/** Rows in an order that does not depend on their ids or on the heap. */
function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const keyOf = (row: Record<string, unknown>) =>
    JSON.stringify(row, (_k, v) => {
      if (typeof v === "bigint") return `bigint:${v}`;
      if (v instanceof Uint8Array) return `bytes:${v.byteLength}`;
      if (typeof v === "string") return v.replace(CUID, "<id>");
      return v;
    });
  return [...rows].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

// ── Golden copies ────────────────────────────────────────────────────────────

/** Paths where two JSON values differ, key order included, first 40. */
function differences(expected: unknown, actual: unknown, path = "$"): string[] {
  const out: string[] = [];
  const walk = (e: unknown, a: unknown, at: string) => {
    if (out.length >= 40) return;
    if (Array.isArray(e) && Array.isArray(a)) {
      if (e.length !== a.length) {
        out.push(`${at}: length ${e.length} -> ${a.length}`);
      }
      for (let i = 0; i < Math.min(e.length, a.length); i++) {
        walk(e[i], a[i], `${at}[${i}]`);
      }
      return;
    }
    if (
      e &&
      a &&
      typeof e === "object" &&
      typeof a === "object" &&
      !Array.isArray(e) &&
      !Array.isArray(a)
    ) {
      const ek = Object.keys(e);
      const ak = Object.keys(a);
      for (const k of ek) if (!ak.includes(k)) out.push(`${at}.${k}: removed`);
      for (const k of ak) if (!ek.includes(k)) out.push(`${at}.${k}: added`);
      const shared = ek.filter((k) => ak.includes(k));
      const order = ak.filter((k) => ek.includes(k));
      if (shared.join() !== order.join()) out.push(`${at}: key order changed`);
      for (const k of shared) {
        walk(
          (e as Record<string, unknown>)[k],
          (a as Record<string, unknown>)[k],
          `${at}.${k}`,
        );
      }
      return;
    }
    if (JSON.stringify(e) !== JSON.stringify(a)) {
      out.push(
        `${at}: ${JSON.stringify(e)?.slice(0, 120)} -> ${JSON.stringify(a)?.slice(0, 120)}`,
      );
    }
  };
  walk(expected, actual, path);
  return out;
}

function matchGolden(name: string, actual: unknown): void {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  const path = join(GOLDEN_DIR, `${name}.json`);
  if (WRITE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(
    existsSync(path),
    `${path} is missing; write it with BACKUP_PARITY_WRITE=1`,
  ).toBe(true);
  const expected = readFileSync(path, "utf8");
  if (expected === text) return;
  expect(
    differences(JSON.parse(expected), actual),
    `${name} differs from its golden copy`,
  ).toEqual([]);
  expect(text, `${name} differs from its golden copy`).toBe(expected);
}

/** How many leaf values a document holds, so a near-empty one cannot pass. */
function leafCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, v) => n + leafCount(v), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>((n, v) => n + leafCount(v), 0);
  }
  return 1;
}

// ── The account ──────────────────────────────────────────────────────────────

const SNAPSHOT_EXTRA_MODELS = ["AccountGrant"] as const;

function auditModels(prisma: PrismaClient): AuditModel[] {
  return readAuditModels(prisma, TWO_ENDED_MODELS);
}

/**
 * Give every column of the fixture's rows a value that is not its default,
 * the way the column round trip does, and say which ones would not take one.
 */
async function fillDefaultedColumns(prisma: PrismaClient): Promise<string[]> {
  const models = auditModels(prisma);
  const byName = new Map(models.map((m) => [m.name, m]));
  const enumValues = enumValuesFromSchema();
  const unfillable: string[] = [];
  for (const model of models) {
    // In key order, so the row that takes the fill is the same on every run:
    // a table read without an order comes back in whatever order its last
    // updates left on disk.
    const rows = await delegateOf(prisma, model).findMany({
      where: ownerWhere(byName, prisma, model.name, OWNER_ID),
      orderBy: model.primaryKey.map((key) => ({ [key]: "asc" as const })),
    });
    if (rows.length === 0) continue;
    for (const column of model.columns) {
      if (
        comparison(column) !== "value" &&
        !(`${model.name}.${column.name}` in COLUMN_PRESENCE_ONLY)
      ) {
        continue;
      }
      if (column.name === "deletedAt") continue;
      if (rows.some((row) => !isDefaultValue(column, row[column.name]))) {
        continue;
      }
      try {
        await delegateOf(prisma, model).update({
          where: primaryKeyWhere(model, rows[0]),
          data: {
            [column.name]: syntheticValue(column, enumValues, FILL_OVERRIDES),
          },
        });
      } catch {
        unfillable.push(`${model.name}.${column.name}`);
      }
    }
  }
  return unfillable;
}

/** Every column of one row, through its delegate, with the given overrides. */
async function fillRow(
  prisma: PrismaClient,
  modelName: string,
  where: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>>,
  skip: ReadonlySet<string>,
): Promise<string[]> {
  const [model] = readAuditModels(prisma, [modelName]);
  const enumValues = enumValuesFromSchema();
  const unfillable: string[] = [];
  for (const column of model.columns) {
    if (column.isId || column.isUpdatedAt || skip.has(column.name)) continue;
    try {
      await delegateOf(prisma, model).update({
        where,
        data: { [column.name]: syntheticValue(column, enumValues, overrides) },
      });
    } catch {
      unfillable.push(`${modelName}.${column.name}`);
    }
  }
  return unfillable;
}

const APP_SETTINGS_OVERRIDES: Readonly<Record<string, unknown>> = {
  "AppSettings.defaultLocale": "fr",
  "AppSettings.defaultUserTimezone": "America/Chicago",
  "AppSettings.moduleAvailabilityJson": { mood: "off" },
  "AppSettings.adminAiInsightsFeedbackSummary": { helpful: 3 },
  "AppSettings.aiReasoningMaxEffort": "low",
};

/** The whole account, and the host around it. */
async function seedMaximalAccount(prisma: PrismaClient) {
  const admin = await seedAdminSession(prisma);
  await createOwner(prisma);
  await prisma.illnessSymptom.deleteMany({
    where: { key: "round_trip_cough" },
  });
  await seedEveryTwoEndedModel(prisma);
  await seedColumnShapes(prisma);
  const unfillable = await fillDefaultedColumns(prisma);
  unfillable.push(
    ...(await fillRow(
      prisma,
      "User",
      { id: OWNER_ID },
      USER_FILL_OVERRIDES,
      new Set(["username", "role", "email"]),
    )),
  );
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  unfillable.push(
    ...(await fillRow(
      prisma,
      "AppSettings",
      { id: "singleton" },
      APP_SETTINGS_OVERRIDES,
      new Set(),
    )),
  );
  // A grant the owner gave, which the file never carries and a restore into
  // the same account never touches.
  await prisma.user.create({
    data: {
      id: DELEGATE_ID,
      username: "parity-delegate",
      email: "parity-delegate@example.test",
    },
  });
  await prisma.accountGrant.create({
    data: {
      grantorId: OWNER_ID,
      granteeId: DELEGATE_ID,
      access: "WRITE",
      scopeJson: { sections: ["measurements"] },
      acceptedAt: new Date("2026-07-02T09:00:00.000Z"),
    },
  });
  await seedTombstones(prisma);
  await seedSelfReferences(prisma);
  const unpinned = await pinRunTimeTimestamps(prisma);
  rotateActiveKey();
  return { admin, unfillable: unfillable.sort(), unpinned };
}

/**
 * One soft-deleted row of every model that keeps tombstones, beside the live
 * rows the fixture seeds. A disaster-recovery file carries the tombstones a
 * device sync needs to keep a deleted row deleted, and the golden copies pin
 * which models' tombstones the file carries and that each comes back deleted.
 * Seeded after the column fill so the fill still lands on the live rows.
 */
async function seedTombstones(prisma: PrismaClient) {
  const deletedAt = AT(TOMBSTONE_DELETED_AT);
  const userId = OWNER_ID;
  const medication = await prisma.medication.findFirstOrThrow({
    where: { userId, name: "Round-trip tablet" },
  });
  const episode = await prisma.illnessEpisode.findFirstOrThrow({
    where: { userId, label: "Cold" },
  });
  const cycle = await prisma.menstrualCycle.findFirstOrThrow({
    where: { userId, startDate: "2026-06-01" },
  });
  const metric = await prisma.customMetric.findFirstOrThrow({
    where: { userId, name: "Grip strength" },
  });
  const thread = await prisma.coachConversation.findFirstOrThrow({
    where: { userId, documentScoped: false },
  });

  await prisma.medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: medication.id,
      scheduledFor: AT("2026-07-02T08:00:00.000Z"),
      takenAt: AT("2026-07-02T08:03:00.000Z"),
      deletedAt,
    },
  });
  await prisma.mentalHealthAssessment.create({
    data: {
      userId,
      instrument: "GAD7",
      locale: "en",
      version: "standard",
      responsesEncrypted: encryptToBytes(
        JSON.stringify({ items: [1, 1, 0, 1, 0, 1, 0], schema: 1 }),
      ),
      totalScore: 4,
      severityBand: "minimal",
      takenAt: AT("2026-06-05T18:00:00.000Z"),
      tz: "Europe/Berlin",
      source: "WEB",
      deletedAt,
    },
  });
  await prisma.moodEntry.create({
    data: {
      userId,
      date: "2026-07-03",
      mood: "SCHLECHT",
      score: 2,
      moodLoggedAt: AT("2026-07-03T20:00:00.000Z"),
      deletedAt,
    },
  });
  await prisma.measurementReminder.create({
    data: {
      userId,
      label: "Gewicht (deleted)",
      measurementType: "WEIGHT",
      intervalDays: 14,
      deletedAt,
    },
  });
  await prisma.labResult.create({
    data: {
      userId,
      analyte: "TSH",
      value: 2.1,
      unit: "mU/L",
      takenAt: AT("2026-05-30T09:00:00.000Z"),
      deletedAt,
    },
  });
  await prisma.customMetric.create({
    data: { userId, name: "Plank (deleted)", unit: "s", deletedAt },
  });
  await prisma.customMetricEntry.create({
    data: {
      userId,
      customMetricId: metric.id,
      value: 40,
      unit: "kg",
      measuredAt: AT("2026-06-28T18:00:00.000Z"),
      deletedAt,
    },
  });
  await prisma.coachFact.create({
    data: {
      userId,
      factEncrypted: encryptToBytes("a fact the person deleted"),
      category: "preference",
      sourceConversationId: thread.id,
      source: "user",
      deletedAt,
    },
  });
  const plan = await prisma.coachPlan.create({
    data: {
      userId,
      metric: "WEIGHT",
      ifCueEncrypted: encryptToBytes("if the scale reads over 75"),
      thenActionEncrypted: encryptToBytes("then skip the second helping"),
      status: "active",
      deletedAt,
    },
  });
  await prisma.coachReminder.create({
    data: {
      userId,
      noteEncrypted: encryptToBytes("a reminder the person deleted"),
      relatedPlanId: plan.id,
      triggerKind: "date",
      dueAt: AT("2026-09-15T07:00:00.000Z"),
      status: "active",
      source: "extractor",
      deletedAt,
    },
  });
  await prisma.menstrualCycle.create({
    data: { userId, startDate: "2026-05-04", deletedAt },
  });
  await prisma.cycleDayLog.create({
    data: {
      userId,
      cycleId: cycle.id,
      date: "2026-06-03",
      flow: "LIGHT",
      deletedAt,
    },
  });
  await prisma.illnessEpisode.create({
    data: {
      userId,
      label: "Sprained ankle (deleted)",
      type: "INJURY",
      onsetAt: AT("2026-04-10T00:00:00.000Z"),
      deletedAt,
    },
  });
  await prisma.illnessDayLog.create({
    data: { userId, episodeId: episode.id, date: "2026-06-22", deletedAt },
  });
  await prisma.allergy.create({
    data: { userId, substance: "Latex (deleted)", deletedAt },
  });
  await prisma.familyHistoryEntry.create({
    data: {
      userId,
      relationship: "FATHER",
      condition: "Hypertension (deleted)",
      notesEncrypted: encryptToBytes("diagnosed at fifty"),
      deletedAt,
    },
  });
  const bytes = encryptBytes(Buffer.from("a page the person deleted"));
  const contentEncrypted = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  contentEncrypted.set(bytes);
  await prisma.inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      title: "Deleted scan",
      filename: "deleted-scan.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentEncrypted,
      contentCodec: "binary2",
      deletedAt,
    },
  });
  const practitioner = await prisma.practitioner.create({
    data: { userId, name: "Closed practice (deleted)", deletedAt },
  });
  await prisma.encounter.create({
    data: {
      userId,
      occurredAt: AT("2026-04-02T08:00:00.000Z"),
      status: "DONE",
      kind: "ROUTINE",
      practitionerId: practitioner.id,
      deletedAt,
    },
  });
  await prisma.customVaccine.create({
    data: { userId, name: "Deleted combo", components: ["rabies"], deletedAt },
  });
  await prisma.vaccinationRecord.create({
    data: {
      userId,
      occurredAt: AT("2026-04-14T00:00:00.000Z"),
      antigenSlug: "influenza",
      vaccineName: "Influenza (deleted)",
      deletedAt,
    },
  });
  await prisma.lifeEvent.create({
    data: {
      userId,
      category: "OTHER",
      startDate: "2025-12-01",
      precision: "DAY",
      titleEncrypted: encryptToBytes("an event the person deleted"),
      deletedAt,
    },
  });
}

/**
 * The two models that point at another row of themselves. The restore writes
 * those pointers in a second pass once every row of the model is back; with
 * the pointers null, nothing in the file exercised it.
 */
async function seedSelfReferences(prisma: PrismaClient) {
  const userId = OWNER_ID;
  const chronic = await prisma.illnessEpisode.findFirstOrThrow({
    where: { userId, label: "Iron deficiency" },
  });
  await prisma.illnessEpisode.create({
    data: {
      userId,
      label: "Iron deficiency flare",
      type: "CHRONIC",
      lifecycle: "FLARE",
      onsetAt: AT("2026-06-25T00:00:00.000Z"),
      parentConditionId: chronic.id,
    },
  });
  const first = await prisma.healthProfileFactRevision.findFirstOrThrow({
    where: { userId, kind: "SMOKING_STATUS" },
  });
  const correction = await prisma.healthProfileFactRevision.create({
    data: {
      userId,
      kind: "SMOKING_STATUS",
      valueEncrypted: encryptToBytes("former"),
      validFrom: AT("2026-02-01T00:00:00.000Z"),
      provenance: "USER_REPORTED",
    },
  });
  await prisma.healthProfileFactRevision.update({
    where: { id: first.id },
    data: { supersededByRevisionId: correction.id },
  });
}

/**
 * Give every timestamp the database stamped while the fixture ran a fixed
 * historical value. A restore that loses a row's `createdAt` writes the
 * restore's own time; while the seeded value was itself "now", both read as
 * `<now>` after normalisation and the loss could not show. Pinned, the seeded
 * account holds no run-time timestamp at all (asserted below), so a `<now>` in
 * a restored row is the restore's own doing and is pinned as such. Returns the
 * columns that would not take a value.
 */
async function pinRunTimeTimestamps(prisma: PrismaClient): Promise<string[]> {
  const from = RUN_STARTED - 5 * 60_000;
  const runTime = (value: unknown) =>
    value instanceof Date && value.getTime() >= from;
  const base = Date.UTC(2026, 4, 1, 8, 0, 0);
  const unpinned: string[] = [];
  const pin = async (
    model: AuditModel,
    rows: Record<string, unknown>[],
    modelIndex: number,
  ) => {
    for (const [rowIndex, row] of rows.entries()) {
      const data: Record<string, Date> = {};
      model.columns.forEach((column, columnIndex) => {
        if (column.type !== "DateTime" || !runTime(row[column.name])) return;
        data[column.name] = new Date(
          base + (modelIndex * 100 + columnIndex) * 60_000 + rowIndex * 1000,
        );
      });
      if (Object.keys(data).length === 0) continue;
      try {
        await delegateOf(prisma, model).update({
          where: primaryKeyWhere(model, row),
          data,
        });
      } catch {
        unpinned.push(`${model.name}:${Object.keys(data).join(",")}`);
      }
    }
  };
  const models = auditModels(prisma);
  const byName = new Map(models.map((m) => [m.name, m]));
  for (const [index, model] of models.entries()) {
    const rows = await delegateOf(prisma, model).findMany({
      where: ownerWhere(byName, prisma, model.name, OWNER_ID),
      orderBy: model.primaryKey.map((key) => ({ [key]: "asc" as const })),
    });
    await pin(model, rows, index);
  }
  const extra = readAuditModels(prisma, [
    "User",
    "AppSettings",
    "AccountGrant",
  ]);
  const [user, settings, grant] = extra;
  await pin(
    user,
    [await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } })],
    models.length,
  );
  await pin(
    settings,
    [
      await prisma.appSettings.findUniqueOrThrow({
        where: { id: "singleton" },
      }),
    ],
    models.length + 1,
  );
  await pin(
    grant,
    (await prisma.accountGrant.findMany({
      where: { grantorId: OWNER_ID },
      orderBy: { id: "asc" },
    })) as Record<string, unknown>[],
    models.length + 2,
  );
  return unpinned.sort();
}

/**
 * Everything above was sealed under the legacy key, which the environment
 * names `v1`. From here on a second key is the active one, so a value the
 * restore re-encrypts instead of carrying over comes back under `v2`, and the
 * key id in the normalised copies shows it.
 */
const ORIGINAL_KEY_ENV = {
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};
function rotateActiveKey() {
  process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "11".repeat(32) });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  _resetCryptoCacheForTests();
}
function restoreKeyEnv() {
  for (const [name, value] of [
    ["ENCRYPTION_KEYS", ORIGINAL_KEY_ENV.keys],
    ["ENCRYPTION_ACTIVE_KEY_ID", ORIGINAL_KEY_ENV.active],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetCryptoCacheForTests();
}

/** Every row the account holds, model by model, normalised. */
async function snapshotAccount(
  prisma: PrismaClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const n = new Normaliser();
  const models = auditModels(prisma);
  const byName = new Map(models.map((m) => [m.name, m]));
  const out: Record<string, unknown> = {};
  for (const model of models) {
    const rows = await delegateOf(prisma, model).findMany({
      where: ownerWhere(byName, prisma, model.name, userId),
    });
    out[model.name] = sortRows(rows).map((row) => n.db(row));
  }
  for (const name of SNAPSHOT_EXTRA_MODELS) {
    const rows = await prisma.accountGrant.findMany({
      where: { OR: [{ grantorId: userId }, { granteeId: userId }] },
    });
    out[name] = sortRows(rows as Record<string, unknown>[]).map((row) =>
      n.db(row),
    );
  }
  out.User = n.db(await prisma.user.findUnique({ where: { id: userId } }));
  out.AppSettings = n.db(
    await prisma.appSettings.findUnique({ where: { id: "singleton" } }),
  );
  return out;
}

async function exportFile(
  prisma: PrismaClient,
  purpose: "disaster-recovery" | "portable-export",
) {
  const built = await buildFullBackupPayload(prisma, OWNER_ID, {
    purpose,
    exportedAt: EXPORTED_AT,
  });
  let json = "";
  const preview = await createBackupPreviewCollector();
  const counts = await streamFullBackupJson(
    prisma,
    OWNER_ID,
    (chunk) => {
      json += chunk;
    },
    { purpose, exportedAt: EXPORTED_AT, observe: preview.observe },
  );
  // The two writers must write the same bytes; everything below is then
  // about both.
  expect(json).toBe(JSON.stringify(built.payload));
  return {
    json,
    builtCounts: built.counts,
    streamedCounts: counts,
    preview: preview.finish(counts),
  };
}

function normalisedExport(file: Awaited<ReturnType<typeof exportFile>>) {
  const n = new Normaliser();
  const payload = JSON.parse(file.json);
  const parsed = parseBackupPayload(payload);
  return {
    payload: n.json(payload),
    builtCounts: file.builtCounts,
    streamedCounts: file.streamedCounts,
    parsed: n.json(JSON.parse(JSON.stringify(parsed))),
    summary: summarizeBackup(parsed),
    preview: n.json(JSON.parse(JSON.stringify(file.preview))),
  };
}

async function storeCopy(
  prisma: PrismaClient,
  userId: string,
  type: string,
  json: string,
) {
  const row = await prisma.dataBackup.create({
    data: {
      userId,
      type,
      data: await legacyStreamedBlobFrom(async (write) => {
        await write(json);
      }),
    },
    select: STORED_BACKUP_SELECT,
  });
  return row;
}

interface RestoreRun {
  outcome: unknown;
  progress: unknown[];
  audit: unknown[];
  effects: unknown;
}

/** Restore one stored copy and record everything it reported. */
async function runRestore(
  prisma: PrismaClient,
  backup: Awaited<ReturnType<typeof storeCopy>>,
  actorUserId: string,
  restoreInstanceSettings: boolean,
): Promise<{ run: RestoreRun; raw: RestoreBackupOutcome }> {
  effects.invalidated.length = 0;
  effects.unitRefresh.length = 0;
  effects.foldRepair.length = 0;
  effects.annotations.length = 0;
  const progress: Array<Record<string, unknown>> = [];
  const raw = await restoreBackup({
    backup,
    actorUserId,
    ipAddress: null,
    restoreInstanceSettings,
    progress: (phase, p) => {
      const entry = {
        phase,
        sectionsDone: p.sectionsDone,
        sectionsTotal: p.sectionsTotal,
        measurementsTotal: p.measurementsTotal,
      };
      const last = progress[progress.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(entry)) {
        progress.push(entry);
      }
    },
  });
  const audit = await prisma.auditLog.findMany({
    // By the copy's id rather than by time: the database clock and this
    // process's clock do not agree to the millisecond.
    where: {
      action: { startsWith: "admin." },
      details: { contains: backup.id },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true, userId: true, details: true },
  });
  const n = new Normaliser();
  return {
    raw,
    run: {
      outcome: n.json(JSON.parse(JSON.stringify(raw))),
      progress,
      audit: audit.map((row) => ({
        action: row.action,
        userId: row.userId === actorUserId ? "<actor>" : row.userId,
        details: n.json(row.details ? JSON.parse(row.details) : null),
      })),
      effects: n.json({
        invalidated: [...effects.invalidated],
        unitRefresh: [...effects.unitRefresh],
        foldRepair: [...effects.foldRepair],
        annotations: JSON.parse(JSON.stringify(effects.annotations)),
      }),
    },
  };
}

async function recreateOwner(prisma: PrismaClient) {
  await prisma.user.delete({ where: { id: OWNER_ID } });
  await createOwner(prisma);
  await prisma.accountGrant.create({
    data: {
      grantorId: OWNER_ID,
      granteeId: DELEGATE_ID,
      access: "READ",
      acceptedAt: new Date("2026-07-03T09:00:00.000Z"),
    },
  });
}

// ── The cases ────────────────────────────────────────────────────────────────

describe("backup parity", () => {
  const prisma = getPrismaClient();
  let adminId = "";
  let drJson = "";
  let portableJson = "";
  let drRestoredSnapshot: Record<string, unknown> = {};

  beforeAll(async () => {
    await truncateAllTables(prisma);
  }, SLOW);

  afterAll(async () => {
    restoreKeyEnv();
    await truncateAllTables(prisma);
  }, SLOW);

  it(
    "exports the maximal account as it did",
    async () => {
      const { admin, unfillable, unpinned } = await seedMaximalAccount(prisma);
      adminId = admin.id;
      const before = await snapshotAccount(prisma, OWNER_ID);
      // The seeded account holds no timestamp of this run, so every `<now>`
      // further down is one a restore or an export wrote.
      expect(unpinned).toEqual([]);
      expect(JSON.stringify(before)).not.toContain("<now>");
      const dr = await exportFile(prisma, "disaster-recovery");
      const portable = await exportFile(prisma, "portable-export");
      drJson = dr.json;
      portableJson = portable.json;

      const drNormalised = normalisedExport(dr);
      // A near-empty file would agree with a near-empty golden copy.
      expect(leafCount(drNormalised.payload)).toBeGreaterThan(1200);
      expect(
        Object.values(before).filter(
          (rows) => Array.isArray(rows) && rows.length > 0,
        ).length,
      ).toBeGreaterThanOrEqual(TWO_ENDED_MODELS.length);

      matchGolden("seeded-account", { unfillable, snapshot: before });
      matchGolden("export-disaster-recovery", drNormalised);
      matchGolden("export-portable", normalisedExport(portable));
    },
    SLOW,
  );

  it(
    "restores the disaster-recovery file into a fresh account as it did",
    async () => {
      expect(drJson).not.toBe("");
      await recreateOwner(prisma);
      const backup = await storeCopy(prisma, OWNER_ID, "PARITY_DR", drJson);
      const { run, raw } = await runRestore(prisma, backup, adminId, true);
      expect(raw.ok, JSON.stringify([raw, run.audit])).toBe(true);
      drRestoredSnapshot = await snapshotAccount(prisma, OWNER_ID);
      const reexport = await exportFile(prisma, "disaster-recovery");
      matchGolden("restore-disaster-recovery", {
        ...run,
        snapshot: drRestoredSnapshot,
        reexport: new Normaliser().json(JSON.parse(reexport.json)),
      });
    },
    SLOW,
  );

  it(
    "restores the disaster-recovery file over the live account as it did",
    async () => {
      expect(drJson).not.toBe("");
      const backup = await storeCopy(
        prisma,
        OWNER_ID,
        "PARITY_DR_LIVE",
        drJson,
      );
      const { run, raw } = await runRestore(prisma, backup, adminId, false);
      expect(raw.ok, JSON.stringify([raw, run.audit])).toBe(true);
      const snapshot = await snapshotAccount(prisma, OWNER_ID);
      matchGolden("restore-disaster-recovery-over-live", {
        ...run,
        snapshotChanges: differences(drRestoredSnapshot, snapshot),
      });
    },
    SLOW,
  );

  it(
    "restores the portable file into a fresh account as it did",
    async () => {
      expect(portableJson).not.toBe("");
      await recreateOwner(prisma);
      // A portable file carries document metadata only, which the restore
      // refuses to turn into documents; the file of an account without any
      // is the portable file a restore takes.
      const backup = await storeCopy(
        prisma,
        OWNER_ID,
        "PARITY_PORTABLE",
        JSON.stringify({ ...JSON.parse(portableJson), documents: [] }),
      );
      const { run, raw } = await runRestore(prisma, backup, adminId, false);
      expect(raw.ok, JSON.stringify([raw, run.audit])).toBe(true);
      const snapshot = await snapshotAccount(prisma, OWNER_ID);
      const reexport = await exportFile(prisma, "portable-export");
      matchGolden("restore-portable", {
        ...run,
        snapshot,
        reexport: new Normaliser().json(JSON.parse(reexport.json)),
      });
    },
    SLOW,
  );

  it(
    "restores a version-1 file in the old shapes over a live account as it did",
    async () => {
      await recreateOwner(prisma);
      await seedLiveRowsForLegacyRestore(prisma);
      const backup = await prisma.dataBackup.create({
        data: {
          userId: OWNER_ID,
          type: "PARITY_V1",
          data: encrypt(JSON.stringify(legacyVersionOneFile())),
        },
        select: STORED_BACKUP_SELECT,
      });
      const { run, raw } = await runRestore(prisma, backup, adminId, true);
      expect(raw.ok, JSON.stringify([raw, run.audit])).toBe(true);
      const snapshot = await snapshotAccount(prisma, OWNER_ID);
      const reexport = await exportFile(prisma, "disaster-recovery");
      matchGolden("restore-version-1", {
        ...run,
        snapshot,
        reexport: new Normaliser().json(JSON.parse(reexport.json)),
      });
    },
    SLOW,
  );

  it(
    "names what it skips in a file it can only partly place, as it did",
    async () => {
      await recreateOwner(prisma);
      const backup = await prisma.dataBackup.create({
        data: {
          userId: OWNER_ID,
          type: "PARITY_SKIPS",
          data: encrypt(JSON.stringify(partlyPlaceableFile())),
        },
        select: STORED_BACKUP_SELECT,
      });
      const { run, raw } = await runRestore(prisma, backup, adminId, false);
      expect(raw.ok, JSON.stringify([raw, run.audit])).toBe(true);
      const snapshot = await snapshotAccount(prisma, OWNER_ID);
      matchGolden("restore-skips", { ...run, snapshot });
    },
    SLOW,
  );

  it(
    "refuses each malformed or unplaceable file as it did",
    async () => {
      await recreateOwner(prisma);
      await prisma.measurement.create({
        data: {
          userId: OWNER_ID,
          type: "WEIGHT",
          value: 70,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date("2026-07-05T07:00:00.000Z"),
        },
      });
      const before = await snapshotAccount(prisma, OWNER_ID);
      const results: Record<string, unknown> = {};
      for (const [name, body] of Object.entries(refusedFiles())) {
        const backup = await prisma.dataBackup.create({
          data: {
            userId: OWNER_ID,
            type: `PARITY_REFUSE_${name}`,
            data:
              typeof body === "string" ? body : encrypt(JSON.stringify(body)),
          },
          select: STORED_BACKUP_SELECT,
        });
        const { run, raw } = await runRestore(prisma, backup, adminId, false);
        expect(raw.ok, `${name} was restored`).toBe(false);
        results[name] = run;
      }
      // Every refusal leaves the account exactly as it was.
      expect(
        differences(before, await snapshotAccount(prisma, OWNER_ID)),
      ).toEqual([]);
      matchGolden("refusals", results);
    },
    SLOW,
  );

  it("reports the schema's issues for a malformed file as it did", () => {
    const issues: Record<string, unknown> = {};
    for (const [name, body] of Object.entries(schemaInvalidFiles())) {
      try {
        parseBackupPayload(body);
        issues[name] = "parsed";
      } catch (error) {
        issues[name] = JSON.parse(
          JSON.stringify((error as { issues?: unknown }).issues ?? null),
        );
      }
    }
    expect(Object.values(issues)).not.toContain("parsed");
    matchGolden("schema-issues", new Normaliser().json(issues));
  });
});

// ── Hand-built files ─────────────────────────────────────────────────────────

/** Rows the version-1 file meets: a reading it reconciles by natural key. */
async function seedLiveRowsForLegacyRestore(prisma: PrismaClient) {
  await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "WEIGHT",
      value: 99,
      unit: "kg",
      source: "MANUAL",
      measuredAt: new Date("2026-07-01T07:00:00.000Z"),
    },
  });
  await prisma.moodEntry.create({
    data: {
      userId: OWNER_ID,
      date: "2026-07-02",
      mood: "BAD",
      score: 2,
      moodLoggedAt: new Date("2026-07-02T20:00:00.000Z"),
    },
  });
}

function legacyVersionOneFile(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    exportedAt: "2026-07-20T08:00:00.000Z",
    userId: OWNER_ID,
    appSettings: {
      id: "singleton",
      registrationEnabled: false,
      mfaRequired: true,
      defaultLocale: "de",
      telegramGlobal: true,
      ntfyGlobal: false,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidPrivateKeyEncrypted: null,
      webPushVapidSubject: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 30,
      reminderMissedMinutes: 120,
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-legacy",
      adminAiBaseUrl: "https://api.example.com/v1",
      adminCodexAccessTokenEncrypted: null,
      adminCodexRefreshTokenEncrypted: null,
      adminCodexAccountIdEncrypted: null,
      adminCodexTokenExpiresAt: null,
      adminCodexConnectedAt: null,
      adminCodexConnectionStatus: "disconnected",
      adminAiInsightsFeedbackSummary: null,
      defaultUserTimezone: "Europe/Berlin",
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      moduleAvailabilityJson: { coach: "off", mood: "on" },
      documentMaxFileBytes: 10_000_000,
      documentQuotaBytes: "500000000",
    },
    measurements: [
      // Reconciled onto the live reading of the same type, source and instant.
      {
        type: "WEIGHT",
        value: 74.5,
        unit: "kg",
        measuredAt: "2026-07-01T07:00:00.000Z",
        source: "MANUAL",
        notes: "after the long ride",
      },
      {
        type: "BLOOD_PRESSURE_SYS",
        value: 128,
        unit: "mmHg",
        measuredAt: "2026-07-01T07:05:00.000Z",
      },
      // The retired filing: Fitbit RMSSD written as the SDNN series.
      {
        type: "HEART_RATE_VARIABILITY",
        value: 41,
        unit: "ms",
        measuredAt: "2026-07-02T04:00:00.000Z",
        source: "FITBIT",
        externalId: "fitbit-hrv-2026-07-02",
      },
      {
        type: "HEART_RATE_VARIABILITY",
        value: 39,
        unit: "ms",
        measuredAt: "2026-07-03T04:00:00.000Z",
        source: "FITBIT",
        externalId: "fitbit-hrv-2026-07-03",
      },
      {
        type: "HRV_RMSSD",
        value: 40,
        unit: "ms",
        measuredAt: "2026-07-03T04:00:00.000Z",
        source: "FITBIT",
        externalId: "fitbit-hrv-2026-07-03",
      },
    ],
    medications: [
      {
        name: "Ramipril",
        dose: "5 mg",
        active: true,
        schedules: [{ windowStart: "07:00", windowEnd: "09:00", label: null }],
      },
      {
        name: "Vitamin D",
        dose: "1000 IU",
        endsOn: "2026-08-01T00:00:00.000Z",
        schedules: [],
      },
    ],
    intakeEvents: [
      {
        medication: "Ramipril",
        scheduledFor: "2026-07-01T07:00:00.000Z",
        takenAt: "2026-07-01T07:10:00.000Z",
        skipped: false,
      },
      {
        medication: "Vitamin D",
        scheduledFor: "2026-07-01T08:00:00.000Z",
        takenAt: null,
        skipped: true,
      },
    ],
    moodEntries: [
      // Upserted onto the live entry of the same day and instant.
      {
        date: "2026-07-02",
        mood: "GOOD",
        score: 4,
        tags: null,
        note: "slept well",
        loggedAt: "2026-07-02T20:00:00.000Z",
        factors: [],
      },
      {
        date: "2026-07-03",
        mood: "OKAY",
        score: 3,
        tags: null,
        loggedAt: "2026-07-03T20:00:00.000Z",
        source: "MOODLOG",
        externalId: "moodlog-2026-07-03",
        factors: [],
      },
    ],
    biomarkers: [
      {
        name: "Ferritin",
        unit: "ng/mL",
        lowerBound: 30,
        upperBound: 400,
        panel: "Iron",
        hidden: false,
        context: "fasted",
      },
    ],
    labResults: [
      {
        panel: "Iron",
        analyte: "Ferritin",
        value: 91,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        sourceReferenceLow: null,
        sourceReferenceHigh: null,
        sourceReferenceText: null,
        takenAt: "2026-07-05T08:00:00.000Z",
        source: "MANUAL",
        biomarkerName: "Ferritin",
        note: "morning draw",
      },
    ],
    illnessEpisodes: [
      {
        id: "legacy-episode-parent",
        label: "Hypertension",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: "2025-01-01T00:00:00.000Z",
        resolvedAt: null,
        parentConditionId: null,
        note: "since last year",
        dayLogs: [],
      },
      {
        id: "legacy-episode-child",
        label: "Headache",
        type: "OTHER",
        lifecycle: "ACUTE",
        onsetAt: "2026-07-01T00:00:00.000Z",
        resolvedAt: "2026-07-02T00:00:00.000Z",
        parentConditionId: "legacy-episode-parent",
        note: null,
        bodySite: "forehead",
        dayLogs: [
          {
            date: "2026-07-01",
            functionalImpact: 2,
            feverC: null,
            note: "afternoon",
            symptoms: [],
          },
        ],
      },
    ],
    allergies: [
      {
        id: "legacy-allergy",
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
        onsetAt: null,
        reaction: "rash",
        note: "childhood",
      },
    ],
    familyHistory: [
      {
        id: "legacy-family",
        relationship: "FATHER",
        condition: "Diabetes",
        ageAtOnset: 55,
        note: "type 2",
      },
    ],
    workouts: [
      {
        sportType: "RUNNING",
        startedAt: "2026-07-04T06:00:00.000Z",
        endedAt: "2026-07-04T06:40:00.000Z",
        durationSec: 2400,
        totalEnergyKcal: 410,
        totalDistanceM: 6500,
        avgHeartRate: 148,
        maxHeartRate: 171,
        minHeartRate: 98,
        stepCount: 6200,
        elevationM: 40,
        pauseDurationSec: null,
        source: "MANUAL",
        externalId: null,
      },
    ],
    nutrientDays: [
      {
        day: "2026-07-04",
        nutrient: "WATER",
        amount: 2100,
        unit: "mL",
        source: "MANUAL",
      },
    ],
  };
}

/** A current-format file whose references this instance can only partly place. */
function partlyPlaceableFile(): Record<string, unknown> {
  return {
    schemaVersion: "2",
    exportedAt: "2026-07-20T08:00:00.000Z",
    userId: OWNER_ID,
    accountSettings: {
      locale: "xx-unknown",
      timezone: "Not/AZone",
      unitPreference: "metric",
      thresholdsJson: {
        WEIGHT: { min: 60, max: 80 },
        NOT_A_METRIC: { min: 1, max: 2 },
      },
      globalExcludedInjectionSites: ["THIGH_LEFT", "NOWHERE"],
      aiProvider: "OPENAI",
      aiBaseUrl: "https://llm.example.com/v1",
    },
    measurements: [
      {
        id: "skips-measurement",
        type: "WEIGHT",
        value: 72,
        unit: "kg",
        measuredAt: "2026-07-01T07:00:00.000Z",
        source: "MANUAL",
      },
    ],
    medications: [
      {
        id: "skips-medication",
        name: "Metformin",
        dose: "500 mg",
        schedules: [],
        scheduleRevisions: [
          {
            validFrom: "2026-06-01T00:00:00.000Z",
            validUntil: "2026-06-15T00:00:00.000Z",
            payload: { schedules: [] },
            supersededByIndex: 7,
          },
          {
            validFrom: "2026-06-15T00:00:00.000Z",
            validUntil: "2026-07-01T00:00:00.000Z",
            payload: { schedules: [] },
            supersededByIndex: 1,
          },
        ],
        efficacyTargets: [
          { biomarkerName: "HbA1c that is not in the file", primary: true },
          { measurementType: "BLOOD_GLUCOSE", primary: false },
        ],
      },
    ],
    hiddenMoodTags: [{ key: "a_tag_nobody_has" }],
    customMoodTagCategories: [
      {
        id: "skips-mood-category",
        key: "custom:skips-mood-category",
        labelKey: "custom",
        sortOrder: 0,
        isActive: true,
        label: "Evenings",
      },
    ],
    customMoodTags: [
      {
        key: "custom:skips-mood-tag",
        labelKey: "custom",
        categoryId: "skips-mood-category",
        kind: "RATED",
        isActive: true,
        sortOrder: 0,
        label: "Quiet",
        scaleMin: 1,
        scaleMax: 5,
        inverse: false,
      },
    ],
    moodEntries: [
      {
        id: "skips-mood",
        date: "2026-07-02",
        mood: "GOOD",
        score: 4,
        tags: null,
        loggedAt: "2026-07-02T20:00:00.000Z",
        factors: [{ key: "a_factor_nobody_has", rating: 3 }],
        structuredTags: ["a_binary_tag_nobody_has"],
      },
    ],
    illnessEpisodes: [
      {
        id: "skips-episode",
        label: "Cold",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: "2026-07-01T00:00:00.000Z",
        resolvedAt: null,
        parentConditionId: null,
        note: null,
        dayLogs: [
          {
            date: "2026-07-01",
            functionalImpact: 1,
            feverC: 38.1,
            note: null,
            symptoms: [{ key: "a_symptom_nobody_has", severity: 2 }],
          },
        ],
      },
    ],
  };
}

/** Files every one of which the restore refuses before or by rolling back. */
function refusedFiles(): Record<string, unknown> {
  const base = (extra: Record<string, unknown>) => ({
    schemaVersion: "2",
    exportedAt: "2026-07-20T08:00:00.000Z",
    userId: OWNER_ID,
    ...extra,
  });
  return {
    undecryptable: "v1.bm90IGEgYmFja3VwIGF0IGFsbA==",
    schemaInvalid: base({
      measurements: [
        {
          id: "bad-measurement",
          type: "NOT_A_TYPE",
          value: "high",
          unit: "",
          measuredAt: "yesterday",
        },
      ],
    }),
    stableIdMissing: base({
      measurements: [
        {
          type: "WEIGHT",
          value: 70,
          unit: "kg",
          measuredAt: "2026-07-01T07:00:00.000Z",
        },
      ],
    }),
    qualitativeMarkerWithNumbers: base({
      biomarkers: [
        { name: "Urine colour", unit: "", lowerBound: null, upperBound: null },
      ],
      labResults: [
        {
          analyte: "Urine colour",
          value: 3,
          unit: "",
          takenAt: "2026-07-01T07:00:00.000Z",
          source: "MANUAL",
          biomarkerName: "Urine colour",
        },
      ],
    }),
    incompatibleVersion: { ...base({}), schemaVersion: "99" },
    ownerMismatch: { ...base({}), userId: "someone-else" },
    sectionMissing: base({
      manifest: {
        documents: { included: "encrypted-content", note: "carried" },
        workouts: { included: "summary-only", note: "summaries" },
      },
      workouts: [],
    }),
    metadataOnlyDocument: base({
      documents: [
        {
          id: "metadata-only-document",
          kind: "OTHER",
          title: null,
          filename: "scan.pdf",
          mimeType: "application/pdf",
          byteSize: 12,
          status: "STORED",
          reportDate: null,
          documentDate: null,
          summary: null,
          createdAt: "2026-07-03T08:00:00.000Z",
        },
      ],
    }),
    keyMissing: base({
      measurements: [
        {
          id: "sealed-under-a-key-this-host-lacks",
          type: "WEIGHT",
          value: 70,
          unit: "kg",
          measuredAt: "2026-07-01T07:00:00.000Z",
          notesEncrypted: Buffer.from(
            `v9.${Buffer.from("x".repeat(48)).toString("base64")}`,
          ).toString("base64"),
        },
      ],
    }),
    intakeForUnknownMedication: base({
      intakeEvents: [
        {
          id: "orphan-intake",
          medication: "a medication this file never carried",
          scheduledFor: "2026-07-04T08:00:00.000Z",
          takenAt: "2026-07-04T08:05:00.000Z",
        },
      ],
    }),
    labForUnknownMarker: base({
      labResults: [
        {
          id: "orphan-lab",
          analyte: "Ferritin",
          value: 91,
          unit: "ng/mL",
          takenAt: "2026-07-01T07:00:00.000Z",
          source: "MANUAL",
          biomarkerId: "a-marker-the-file-never-carried",
          biomarkerName: "Ferritin",
        },
      ],
    }),
    illnessWithUnknownParent: base({
      illnessEpisodes: [
        {
          id: "orphan-episode",
          label: "Cough",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-07-01T00:00:00.000Z",
          resolvedAt: null,
          parentConditionId: "an-episode-the-file-never-carried",
          note: null,
          dayLogs: [],
        },
      ],
    }),
  };
}

/** Files the schema refuses, for the issue list an upload is answered with. */
function schemaInvalidFiles(): Record<string, unknown> {
  return {
    everySectionWrong: {
      schemaVersion: "2",
      exportedAt: "not a date",
      userId: "",
      measurements: [{ type: "WEIGHT" }],
      medications: [{ name: 3, schedules: "none" }],
      moodEntries: [{ date: "2026-07-01", mood: "GOOD", score: "four" }],
      labResults: [{ analyte: null }],
      documents: [{ id: "d" }],
      accountSettings: { heightCm: "tall", hasDiabetes: "yes" },
      coachConversations: [{ id: "c", messages: [{ role: 1 }] }],
      environmentContexts: [{ day: "July" }],
      ecgRecordings: [{ id: "e" }],
      vaccinations: [{ id: "v" }],
    },
  };
}
