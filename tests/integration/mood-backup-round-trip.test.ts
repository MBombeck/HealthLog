/**
 * A mood entry, out through the real backup and back in through the real
 * restore, asserted on the rows.
 *
 * Deliberately not a classification test. Asserting that the payload has a
 * `moodEntries` key proves nothing this repository has not already been burned
 * by: excise the restore call entirely and a shape check still reports green.
 * So this seeds an account, exports through `buildFullBackupPayload`, parses
 * through `parseBackupPayload`, restores through the real
 * `POST /api/admin/backups/[id]/restore`, and then reads the row back out of
 * Postgres and compares values.
 *
 * The fixture is the entry that used to come back wrong in four ways at once:
 * a ticked BINARY tag and a rated factor on the same entry, a note in the
 * encrypted column, a timezone that is not the legacy Europe/Berlin default,
 * and a sync counter above zero. The old payload carried none of them.
 *
 * The second case is the compatibility floor: a hand-written payload in the
 * shape files were written in BEFORE this change, restored through the same
 * route. Every field this adds is optional or defaulted precisely so that file
 * keeps working, and the only way to know is to send one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@/generated/prisma/client";
import { encrypt } from "@/lib/crypto";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "./restore-job-driver";

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

const OWNER_ID = "mood-round-trip-owner";
const NOTE = "slept badly, long walk in the afternoon";
const LOGGED_AT = new Date("2026-07-19T23:40:00.000Z");
const CREATED_AT = new Date("2026-07-19T23:41:00.000Z");
const UPDATED_AT = new Date("2026-07-20T06:05:00.000Z");
const DELETED_AT = new Date("2026-07-20T07:00:00.000Z");
const CONTEXT_NOTE = "the meeting overran and the evening went with it";
const CONTEXT_EVENT_AT = new Date("2026-07-19T16:30:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession(prisma: PrismaClient) {
  const admin = await prisma.user.create({
    data: {
      username: "mood-round-trip-admin",
      email: "mood-round-trip-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

async function seedOwner(prisma: PrismaClient) {
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "mood-round-trip-owner",
      email: "mood-round-trip-owner@example.test",
    },
  });
}

/**
 * The taxonomy the entry links to: one seeded BINARY tag (`userId: null`, the
 * reference data every instance has), one BINARY tag the account made itself,
 * and one RATED factor. The account's own tag matters — it travels in the file
 * as a `customMoodTags` row, and a restore that could not re-create it would
 * lose the link even with everything else correct.
 */
async function seedTaxonomy(prisma: PrismaClient) {
  const category = await prisma.moodTagCategory.create({
    data: {
      id: "mood-rt-category",
      key: "mood_round_trip",
      labelKey: "mood.tagCategory.roundTrip",
    },
  });
  const seededTag = await prisma.moodTag.create({
    data: {
      id: "mood-rt-seeded-tag",
      categoryId: category.id,
      key: "rt_headache",
      labelKey: "mood.tag.rtHeadache",
      kind: "BINARY",
    },
  });
  const ownTag = await prisma.moodTag.create({
    data: {
      id: "mood-rt-own-tag",
      userId: OWNER_ID,
      categoryId: category.id,
      key: "custom:rt_long_walk",
      labelKey: "mood.tag.custom",
      kind: "BINARY",
    },
  });
  const factor = await prisma.moodTag.create({
    data: {
      id: "mood-rt-factor",
      categoryId: category.id,
      key: "rt_sleep_quality",
      labelKey: "mood.tag.rtSleepQuality",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
    },
  });
  return { category, seededTag, ownTag, factor };
}

function makeRestoreRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

async function restoreFromPayload(
  prisma: PrismaClient,
  payload: unknown,
  type: string,
) {
  const backup = await prisma.dataBackup.create({
    data: {
      userId: OWNER_ID,
      type,
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return POST(makeRestoreRequest(backup.id) as never, {
    params: Promise.resolve({ id: backup.id }),
  });
}

describe("mood backup round trip", () => {
  it("brings the note, the timezone, the sync counter and both tag arms back", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    const { seededTag, ownTag, factor } = await seedTaxonomy(prisma);

    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-entry",
        userId: OWNER_ID,
        date: "2026-07-19",
        mood: "OKAY",
        score: 3,
        // All five level-A values, and deliberately not the ones the label
        // would derive: a restore that re-derived them instead of carrying
        // them would look right on this row and be wrong on every row where
        // the person disagreed with their own five-point pick.
        moodA1: 4,
        stressA2: 9,
        energyA3: 2,
        connectionA4: 6,
        stabilityA5: 0,
        tags: JSON.stringify(["free-text-tag"]),
        note: null,
        noteEncrypted: encryptNote(NOTE),
        source: "MANUAL",
        externalId: null,
        moodLoggedAt: LOGGED_AT,
        // Not Europe/Berlin: a restore that drops `tz` moves this entry's day
        // boundary by six hours and nothing else in the row shows it.
        tz: "America/New_York",
        syncVersion: 3,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        tagLinks: {
          create: [
            { moodTagId: factor.id, rating: 4 },
            { moodTagId: seededTag.id, rating: null },
            { moodTagId: ownTag.id, rating: null },
          ],
        },
        // The day context, with one value from each of the four sections plus
        // its own encrypted note. A zero is in there for the same reason it is
        // among the level-A values above: zero is a real answer and a carrier
        // that read it as absence would round-trip it to NULL and pass every
        // truthiness check on the way.
        context: {
          create: {
            userId: OWNER_ID,
            workStatus: "overtime",
            workMinutes: 600,
            workLoad: 8,
            workSatisfaction: 0,
            contactCircles: JSON.stringify(["partner", "friends"]),
            contactForm: "phone",
            contactQuality: 7,
            leisureCategories: JSON.stringify(["reading"]),
            leisureMinutes: 30,
            eventType: "conflict",
            eventValence: -4,
            eventAt: CONTEXT_EVENT_AT,
            notesEncrypted: encryptNote(CONTEXT_NOTE),
          },
        },
      },
    });
    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-tombstone",
        userId: OWNER_ID,
        date: "2026-07-18",
        mood: "SCHLECHT",
        score: 2,
        source: "MANUAL",
        moodLoggedAt: new Date("2026-07-18T22:00:00.000Z"),
        tz: "America/New_York",
        syncVersion: 5,
        deletedAt: DELETED_AT,
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(payload);

    // Wipe what the restore is supposed to bring back. The tag rows stay: the
    // instance's catalogue is reference data, and the account's own tag rides
    // in the file and is re-created by the restore either way.
    await prisma.moodEntry.deleteMany({ where: { userId: OWNER_ID } });
    await prisma.moodTag.deleteMany({ where: { userId: OWNER_ID } });
    expect(await prisma.moodEntry.count({ where: { userId: OWNER_ID } })).toBe(
      0,
    );

    const response = await restoreFromPayload(
      prisma,
      parsed,
      "MOOD_ROUND_TRIP",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { skipped: { links: number } };
    };
    // Nothing was dropped. A restore that lost a link and still answered 200
    // is exactly what the skip report exists to make visible.
    expect(body.data.skipped.links).toBe(0);

    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-entry" },
    });
    // Asserted as "there is a note" before it is decrypted, so a payload that
    // stopped carrying the ciphertext fails by name rather than as a TypeError
    // three frames inside the cipher.
    expect(
      restored.noteEncrypted,
      "the restored entry has no note ciphertext — the backup dropped it",
    ).not.toBeNull();
    expect(decryptFromBytes(restored.noteEncrypted!)).toBe(NOTE);
    expect(restored.note).toBeNull();
    expect(restored.tz).toBe("America/New_York");
    expect(restored.syncVersion).toBe(3);
    expect(restored.moodLoggedAt).toEqual(LOGGED_AT);
    expect(restored.createdAt).toEqual(CREATED_AT);
    expect(restored.updatedAt).toEqual(UPDATED_AT);
    expect(restored.date).toBe("2026-07-19");
    expect(restored.score).toBe(3);
    // Each of the five asserted by value. Zero is included on purpose: it is a
    // real answer on this scale, and a carrier that treated it as absence
    // would round-trip it as NULL and pass a truthiness check.
    expect(restored.moodA1).toBe(4);
    expect(restored.stressA2).toBe(9);
    expect(restored.energyA3).toBe(2);
    expect(restored.connectionA4).toBe(6);
    expect(restored.stabilityA5).toBe(0);
    expect(restored.tags).toBe(JSON.stringify(["free-text-tag"]));
    expect(restored.deletedAt).toBeNull();

    const tombstone = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-tombstone" },
    });
    expect(tombstone.deletedAt).toEqual(DELETED_AT);
    expect(tombstone.syncVersion).toBe(5);
    // The tombstone was written without level-A values and comes back without
    // them. A restore filling these in would put an answer nobody gave into a
    // row the person had already deleted.
    expect(tombstone.moodA1).toBeNull();
    expect(tombstone.stressA2).toBeNull();

    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: "mood-rt-entry" },
      select: { rating: true, moodTag: { select: { key: true, kind: true } } },
      orderBy: { moodTagId: "asc" },
    });
    const byKey = new Map(links.map((l) => [l.moodTag.key, l]));
    expect([...byKey.keys()].sort()).toEqual([
      "custom:rt_long_walk",
      "rt_headache",
      "rt_sleep_quality",
    ]);
    // The rating is what tells the two arms apart in the row: a ticked tag
    // carries NULL, and that NULL is what the old backup filter read as
    // "nothing to carry".
    expect(byKey.get("rt_headache")!.rating).toBeNull();
    expect(byKey.get("custom:rt_long_walk")!.rating).toBeNull();
    expect(byKey.get("rt_sleep_quality")!.rating).toBe(4);

    // The day context comes back as its own row, bound to the restored entry.
    // Asserted as "the row is there" before any column is read, so a restore
    // that stopped writing it fails by name instead of as a Prisma throw three
    // frames down.
    expect(
      await prisma.moodContext.count({
        where: { moodEntryId: "mood-rt-entry" },
      }),
      "the restored entry has no day context — the backup or the restore dropped it",
    ).toBe(1);
    const context = await prisma.moodContext.findUniqueOrThrow({
      where: { moodEntryId: "mood-rt-entry" },
    });
    expect(context.userId).toBe(OWNER_ID);
    expect(context.workStatus).toBe("overtime");
    expect(context.workMinutes).toBe(600);
    expect(context.workLoad).toBe(8);
    // Zero, not NULL.
    expect(context.workSatisfaction).toBe(0);
    expect(context.contactCircles).toBe(JSON.stringify(["partner", "friends"]));
    expect(context.contactForm).toBe("phone");
    expect(context.contactQuality).toBe(7);
    // Untouched sections stay empty rather than arriving as a defaulted middle.
    expect(context.contactSupport).toBeNull();
    expect(context.leisureCategories).toBe(JSON.stringify(["reading"]));
    expect(context.leisureMinutes).toBe(30);
    expect(context.leisureJoy).toBeNull();
    expect(context.eventType).toBe("conflict");
    expect(context.eventValence).toBe(-4);
    expect(context.eventAt).toEqual(CONTEXT_EVENT_AT);
    expect(
      context.notesEncrypted,
      "the restored context has no note ciphertext — the backup dropped it",
    ).not.toBeNull();
    expect(decryptFromBytes(context.notesEncrypted!)).toBe(CONTEXT_NOTE);

    // The entry that never had a context still has none. A restore that minted
    // an empty row for every entry would turn "never asked" into "asked and
    // answered nothing" across the whole account.
    expect(
      await prisma.moodContext.count({
        where: { moodEntryId: "mood-rt-tombstone" },
      }),
    ).toBe(0);
  });

  it("a file written before contexts existed restores without one", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);

    // The compatibility floor for this change: no `context` key at all, and a
    // live row that DOES have one. The restore wipes and rebuilds, so the row
    // comes back exactly as the file describes it — which means without a
    // context, not with the one that happened to be on disk.
    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-legacy-context",
        userId: OWNER_ID,
        date: "2026-07-19",
        mood: "OKAY",
        score: 3,
        source: "MANUAL",
        moodLoggedAt: LOGGED_AT,
        context: { create: { userId: OWNER_ID, workStatus: "regular" } },
      },
    });
    expect(await prisma.moodContext.count()).toBe(1);

    const legacyPayload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-legacy-context",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          factors: [],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const response = await restoreFromPayload(
      prisma,
      parseBackupPayload(legacyPayload),
      "MOOD_CONTEXT_LEGACY",
    );
    expect(response.status).toBe(200);
    await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-legacy-context" },
    });
    expect(await prisma.moodContext.count()).toBe(0);
  });

  it("carries the context through a portable export, in plain text", async () => {
    const prisma = getPrismaClient();
    await seedOwner(prisma);
    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-portable",
        userId: OWNER_ID,
        date: "2026-07-19",
        mood: "GUT",
        score: 4,
        source: "MANUAL",
        moodLoggedAt: LOGGED_AT,
        context: {
          create: {
            userId: OWNER_ID,
            leisureCategories: JSON.stringify(["music"]),
            leisureJoy: 9,
            notesEncrypted: encryptNote(CONTEXT_NOTE),
          },
        },
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    const entries = (payload as { moodEntries: Array<Record<string, unknown>> })
      .moodEntries;
    const context = entries[0].context as Record<string, unknown>;
    // A portable file is for a person to read: the note is plain text and no
    // ciphertext rides along.
    expect(context.note).toBe(CONTEXT_NOTE);
    expect(context.notesEncrypted).toBeUndefined();
    expect(context.leisureJoy).toBe(9);
    expect(context.leisureCategories).toBe(JSON.stringify(["music"]));
  });

  it("wipes before it rebuilds, so a live row comes back exactly as the file describes it", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);

    // A row as it stands today, with answered sliders.
    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-live",
        userId: OWNER_ID,
        date: "2026-07-19",
        mood: "OKAY",
        score: 3,
        moodA1: 4,
        stressA2: 9,
        source: "MANUAL",
        moodLoggedAt: LOGGED_AT,
      },
    });

    // Restoring a file written before these columns existed. The restore
    // deletes the owner's mood partition and rebuilds it from the file, so
    // the row that comes back is the file's row and carries nothing the file
    // did not hold. This is the disaster-recovery contract and it is asserted
    // here so nobody reads the omit-on-update below as protecting a live row:
    // by the time that arm runs there are no live rows left.
    const legacyPayload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-live",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          factors: [],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const response = await restoreFromPayload(
      prisma,
      parseBackupPayload(legacyPayload),
      "MOOD_LEVEL_A_WIPE",
    );
    expect(response.status).toBe(200);

    const after = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-live" },
    });
    // Not 4 and not 9: the file said nothing about them and the file is what
    // was restored. Nothing was derived to fill the gap either.
    expect(after.moodA1).toBeNull();
    expect(after.stressA2).toBeNull();
  });

  it("lets a second entry for the same row add without erasing", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);

    // Two entries in ONE file addressing the same row. The first creates it,
    // the second lands on the upsert's update arm — the only way that arm is
    // reachable, since the partition was wiped a moment earlier. A second
    // entry that mentions nothing about a dimension must not blank what the
    // first one set, and one that mentions it wins, including a null.
    const payload = {
      schemaVersion: "2",
      exportedAt: "2026-08-08T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-collide",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          a1: 4,
          a2: 9,
          a3: 6,
          factors: [],
        },
        {
          id: "mood-rt-collide",
          date: "2026-07-19",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          a1: 7,
          a3: null,
          factors: [],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const response = await restoreFromPayload(
      prisma,
      parseBackupPayload(payload),
      "MOOD_LEVEL_A_COLLIDE",
    );
    expect(response.status).toBe(200);

    const after = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-collide" },
    });
    expect(after.mood).toBe("GUT");
    // Stated by the second entry.
    expect(after.moodA1).toBe(7);
    // Not mentioned by the second entry: the first entry's answer stands.
    expect(after.stressA2).toBe(9);
    // Stated as null by the second entry: cleared.
    expect(after.energyA3).toBeNull();
  });

  it("restores a file written in the shape that predates these fields", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    const { factor } = await seedTaxonomy(prisma);

    // Verbatim the shape the builder emitted before this change: no `note`, no
    // `noteEncrypted`, no `tz`, no `syncedAt`, no `syncVersion`, no
    // `createdAt`/`updatedAt`, no `structuredTags`. Hand-written rather than
    // generated, because a fixture built from today's builder cannot describe
    // yesterday's file.
    const legacyPayload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-legacy",
          date: "2026-07-19",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: "moodlog-legacy",
          deletedAt: null,
          factors: [{ key: factor.key, rating: 5 }],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const parsed = parseBackupPayload(legacyPayload);
    // Defaults, not values: absence has to stay absence through the parse.
    expect(parsed.moodEntries[0].structuredTags).toEqual([]);
    expect(parsed.moodEntries[0].tz).toBeUndefined();
    expect(parsed.moodEntries[0].syncVersion).toBeUndefined();
    expect(parsed.moodEntries[0].a1).toBeUndefined();

    const response = await restoreFromPayload(
      prisma,
      parsed,
      "MOOD_LEGACY_SHAPE",
    );
    expect(response.status).toBe(200);

    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-legacy" },
    });
    // Identical to what the old restore wrote for the same file: the note
    // columns empty, `tz` NULL — which is what such a row meant, the legacy
    // Europe/Berlin reading — and the counter at the schema default.
    expect(restored.note).toBeNull();
    expect(restored.noteEncrypted).toBeNull();
    expect(restored.tz).toBeNull();
    expect(restored.syncVersion).toBe(0);
    expect(restored.mood).toBe("GUT");
    expect(restored.score).toBe(4);
    expect(restored.externalId).toBe("moodlog-legacy");
    expect(restored.deletedAt).toBeNull();
    // A file from before these columns carries no answer for them, and the
    // restore does not invent one. `GUT` would derive to 7; a restore that
    // derived instead of carrying would write a number this file never held.
    expect(restored.moodA1).toBeNull();
    expect(restored.stressA2).toBeNull();
    expect(restored.energyA3).toBeNull();
    expect(restored.connectionA4).toBeNull();
    expect(restored.stabilityA5).toBeNull();

    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: "mood-rt-legacy" },
      select: { rating: true, moodTagId: true },
    });
    expect(links).toEqual([{ moodTagId: factor.id, rating: 5 }]);
  });

  it("names a ticked tag this instance cannot resolve instead of losing it quietly", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    await seedTaxonomy(prisma);

    const payload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-unknown-tag",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          factors: [],
          structuredTags: ["rt_headache", "rt_retired_tag"],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const response = await restoreFromPayload(
      prisma,
      parseBackupPayload(payload),
      "MOOD_UNKNOWN_TAG",
    );
    expect(response.status).toBe(200);
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
    expect(body.data.skipped.catalogueKeys).toEqual([
      { catalogue: "moodTag", key: "rt_retired_tag", links: 1 },
    ]);
    expect(body.data.skipped.links).toBe(1);

    // The entry itself came back whole. One key that has nowhere to attach
    // costs the link, never the record.
    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-unknown-tag" },
    });
    expect(restored.score).toBe(3);
    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: restored.id },
      select: { moodTag: { select: { key: true } } },
    });
    expect(links).toEqual([{ moodTag: { key: "rt_headache" } }]);
  });
});
