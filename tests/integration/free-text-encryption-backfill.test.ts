/**
 * v1.39.3 — the Coach conversation title and the custom-metric reading note
 * move to AES-256-GCM at rest. Migration 0357 only adds the ciphertext
 * columns; the existing rows are sealed by the boot-time backfill. This runs
 * the real discovery and the real per-user pass against Postgres, with the
 * migrated schema:
 *
 *   - discovery finds exactly the accounts still holding a readable value;
 *   - the pass seals every such row in its own transaction, nulls the readable
 *     column, and reads back the same text;
 *   - a second pass and a second discovery find nothing (it converges);
 *   - a row written the current way is left as it was.
 *
 * v1.39.4 adds the practitioner phone number and address and the workout GPS
 * track (migration 0361) to the same pass; the second case covers them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";

import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  decryptRouteGeometry,
  encryptRouteGeometry,
} from "@/lib/workouts/route-geometry-cipher";
import {
  enqueueBootTimeFreeTextEncryptionBackfill,
  runFreeTextEncryptionBackfillForUser,
} from "@/lib/jobs/free-text-encryption-backfill";
import { getPrismaClient, truncateAllTables } from "./setup";

function makeCapturingBoss() {
  const sent: { queue: string; userId: string; startAfter?: number }[] = [];
  const boss = {
    send: async (
      queue: string,
      payload: { userId?: string },
      opts: { startAfter?: number },
    ) => {
      if (payload.userId) sent.push({ queue, userId: payload.userId, ...opts });
      return `job-${sent.length}`;
    },
  };
  return { boss, sent };
}

async function seedUser(id: string) {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  setGlobalBoss(null as never);
});

describe("free-text encryption backfill (real Postgres)", () => {
  it("discovers, seals, and converges", async () => {
    const prisma = getPrismaClient();
    await Promise.all([seedUser("ft-a"), seedUser("ft-b"), seedUser("ft-c")]);

    // ft-a: a legacy readable title and a sealed one.
    // Last active months ago: the backfill must not make it look recent.
    const lastActive = new Date("2026-03-02T09:15:00.000Z");
    await prisma.coachConversation.create({
      data: {
        id: "conv-legacy",
        userId: "ft-a",
        title: "Legacy title",
        updatedAt: lastActive,
      },
    });
    await prisma.coachConversation.create({
      data: {
        id: "conv-sealed",
        userId: "ft-a",
        titleEncrypted: encryptToBytes("Sealed title"),
      },
    });
    // ft-b: a legacy readable note on a custom-metric reading.
    const metric = await prisma.customMetric.create({
      data: { userId: "ft-b", name: "Grip", unit: "kg" },
    });
    await prisma.customMetricEntry.create({
      data: {
        id: "entry-legacy",
        userId: "ft-b",
        customMetricId: metric.id,
        value: 40,
        unit: "kg",
        measuredAt: new Date("2026-09-01T08:00:00.000Z"),
        note: "legacy note",
      },
    });
    await prisma.customMetricEntry.create({
      data: {
        id: "entry-none",
        userId: "ft-b",
        customMetricId: metric.id,
        value: 41,
        unit: "kg",
        measuredAt: new Date("2026-09-02T08:00:00.000Z"),
      },
    });
    // ft-c: nothing readable, only a sealed title.
    await prisma.coachConversation.create({
      data: { userId: "ft-c", titleEncrypted: encryptToBytes("Only sealed") },
    });

    const first = makeCapturingBoss();
    setGlobalBoss(first.boss as never);
    const discovered = await enqueueBootTimeFreeTextEncryptionBackfill(180);
    expect(discovered.error).toBeNull();
    expect(first.sent.map((s) => s.userId).sort()).toEqual(["ft-a", "ft-b"]);
    // The boot call is deferred past the startup storm.
    expect(first.sent.every((s) => s.startAfter === 180)).toBe(true);

    expect(await runFreeTextEncryptionBackfillForUser("ft-a")).toEqual({
      conversationTitlesMigrated: 1,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });
    expect(await runFreeTextEncryptionBackfillForUser("ft-b")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 1,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });

    const conversations = await prisma.coachConversation.findMany({
      where: { userId: "ft-a" },
      orderBy: { id: "asc" },
    });
    expect(
      conversations.map((c) => ({
        id: c.id,
        readable: c.title,
        text: readNote(c.titleEncrypted, c.title),
      })),
    ).toEqual([
      { id: "conv-legacy", readable: null, text: "Legacy title" },
      { id: "conv-sealed", readable: null, text: "Sealed title" },
    ]);
    // The Coach panel orders and groups by updatedAt; sealing a title is not
    // activity, so the stamp is the one the conversation already had.
    expect(conversations[0].updatedAt).toEqual(lastActive);
    const entries = await prisma.customMetricEntry.findMany({
      where: { userId: "ft-b" },
      orderBy: { id: "asc" },
    });
    expect(
      entries.map((e) => ({
        id: e.id,
        readable: e.note,
        text: readNote(e.noteEncrypted, e.note),
      })),
    ).toEqual([
      { id: "entry-legacy", readable: null, text: "legacy note" },
      { id: "entry-none", readable: null, text: null },
    ]);

    // Converged: nothing left to discover, nothing left to seal.
    const second = makeCapturingBoss();
    setGlobalBoss(second.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(second.sent).toEqual([]);
    expect(await runFreeTextEncryptionBackfillForUser("ft-a")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });
  });

  it("seals practitioner contacts and workout GPS tracks, and converges", async () => {
    const prisma = getPrismaClient();
    await Promise.all([seedUser("pc-a"), seedUser("pc-b"), seedUser("pc-c")]);
    const track = {
      type: "LineString",
      coordinates: [
        [13.4012, 52.5201, 34],
        [13.4051, 52.5233, 36],
      ],
    };

    // pc-a: a legacy practitioner with both fields, one with only an address.
    await prisma.practitioner.create({
      data: {
        id: "pr-both",
        userId: "pc-a",
        name: "Praxis Nord",
        phone: "+49 30 1234567",
        location: "Hauptstr. 1",
      },
    });
    await prisma.practitioner.create({
      data: {
        id: "pr-loc",
        userId: "pc-a",
        name: "Praxis Sued",
        location: "Am Markt 3",
      },
    });
    // pc-b: a legacy readable track, found through its workout.
    const startedAt = new Date("2026-09-01T06:00:00.000Z");
    await prisma.workout.create({
      data: {
        id: "wk-legacy",
        userId: "pc-b",
        sportType: "running",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30 * 60_000),
        durationSec: 1800,
        route: { create: { id: "rt-legacy", geometry: track } },
      },
    });
    // pc-c: only rows written the current way.
    await prisma.practitioner.create({
      data: {
        userId: "pc-c",
        name: "Praxis West",
        phoneEncrypted: encryptToBytes("+49 40 7654321"),
      },
    });
    await prisma.workout.create({
      data: {
        id: "wk-sealed",
        userId: "pc-c",
        sportType: "running",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30 * 60_000),
        durationSec: 1800,
        route: {
          create: {
            id: "rt-sealed",
            geometryEncrypted: encryptRouteGeometry(track),
          },
        },
      },
    });

    const first = makeCapturingBoss();
    setGlobalBoss(first.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(first.sent.map((s) => s.userId).sort()).toEqual(["pc-a", "pc-b"]);

    expect(await runFreeTextEncryptionBackfillForUser("pc-a")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 2,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });
    expect(await runFreeTextEncryptionBackfillForUser("pc-b")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 1,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });

    const practitioners = await prisma.practitioner.findMany({
      where: { userId: "pc-a" },
      orderBy: { id: "asc" },
    });
    expect(
      practitioners.map((p) => ({
        id: p.id,
        phone: p.phone,
        location: p.location,
        phoneText: readNote(p.phoneEncrypted, null),
        locationText: readNote(p.locationEncrypted, null),
      })),
    ).toEqual([
      {
        id: "pr-both",
        phone: null,
        location: null,
        phoneText: "+49 30 1234567",
        locationText: "Hauptstr. 1",
      },
      {
        id: "pr-loc",
        phone: null,
        location: null,
        phoneText: null,
        locationText: "Am Markt 3",
      },
    ]);

    // The track is SQL NULL in the readable column, not a JSON null, and the
    // sealed value does not carry a coordinate readable on disk.
    const onDisk = await prisma.$queryRaw<
      { readable_is_null: boolean; leaks: boolean }[]
    >`
      SELECT geometry IS NULL AS readable_is_null,
             position(convert_to('52.5201', 'UTF8') IN geometry_encrypted) > 0
               AS leaks
      FROM workout_routes WHERE id = 'rt-legacy'`;
    expect(onDisk).toEqual([{ readable_is_null: true, leaks: false }]);
    const route = await prisma.workoutRoute.findUniqueOrThrow({
      where: { id: "rt-legacy" },
    });
    expect(decryptRouteGeometry(route.geometryEncrypted!)).toEqual(track);

    // Converged.
    const second = makeCapturingBoss();
    setGlobalBoss(second.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(second.sent).toEqual([]);
    expect(await runFreeTextEncryptionBackfillForUser("pc-b")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });
  });

  it("clears appointment address copies, scrubs old contact audit rows, and settles a JSON-null track", async () => {
    const prisma = getPrismaClient();
    await Promise.all([seedUser("ad-a"), seedUser("ad-b")]);

    // ad-a: an appointment reminder holding a readable copy of the address,
    // and a checkup whose own location is the person's words and stays.
    await prisma.measurementReminder.create({
      data: {
        id: "rem-appt",
        userId: "ad-a",
        label: "Praxis Nord",
        origin: "ENCOUNTER",
        location: "Hauptstr. 1, Berlin",
      },
    });
    await prisma.measurementReminder.create({
      data: {
        id: "rem-checkup",
        userId: "ad-a",
        label: "Blood panel",
        location: "Labor Mitte",
      },
    });
    // ad-a: an edit's audit row from before the contact fields were sealed,
    // carrying the old address and phone number, and a current-shape row.
    await prisma.auditLog.create({
      data: {
        id: "audit-old",
        userId: "ad-a",
        action: "practitioner.contact.update",
        details: JSON.stringify({
          practitionerId: "pr-x",
          fields: ["location", "name", "phone"],
          previous: {
            location: "Hauptstr. 1, Berlin",
            name: "Praxis Alt",
            phone: "+49 30 1234567",
          },
        }),
      },
    });
    const currentDetails = JSON.stringify({
      practitionerId: "pr-x",
      fields: ["location"],
      previous: {},
    });
    await prisma.auditLog.create({
      data: {
        id: "audit-current",
        userId: "ad-a",
        action: "practitioner.contact.update",
        details: currentDetails,
      },
    });
    // An account deleted since: the row lost its owner and no per-user job
    // reaches it, so discovery scrubs it itself.
    await prisma.auditLog.create({
      data: {
        id: "audit-orphan",
        userId: null,
        action: "practitioner.contact.update",
        details: JSON.stringify({
          practitionerId: "pr-y",
          fields: ["phone"],
          previous: { phone: "+49 40 7654321" },
        }),
      },
    });
    // ad-b: a route whose readable column is a JSON null rather than SQL
    // NULL. Nothing to seal, but discovery must not find it every night.
    const startedAt = new Date("2026-09-01T06:00:00.000Z");
    await prisma.workout.create({
      data: {
        id: "wk-jsonnull",
        userId: "ad-b",
        sportType: "running",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30 * 60_000),
        durationSec: 1800,
        route: { create: { id: "rt-jsonnull", geometry: Prisma.JsonNull } },
      },
    });

    const first = makeCapturingBoss();
    setGlobalBoss(first.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(first.sent.map((s) => s.userId).sort()).toEqual(["ad-a", "ad-b"]);

    const summaryA = await runFreeTextEncryptionBackfillForUser("ad-a");
    expect(summaryA).toMatchObject({
      appointmentAddressesCleared: 1,
      contactAuditRowsScrubbed: 1,
    });
    await runFreeTextEncryptionBackfillForUser("ad-b");

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: "ad-a" },
      orderBy: { id: "asc" },
    });
    expect(reminders.map((r) => [r.id, r.location])).toEqual([
      ["rem-appt", null],
      ["rem-checkup", "Labor Mitte"],
    ]);

    const audits = await prisma.auditLog.findMany({
      where: { action: "practitioner.contact.update" },
      orderBy: { id: "asc" },
    });
    const byId = Object.fromEntries(audits.map((a) => [a.id, a.details]));
    expect(JSON.parse(byId["audit-old"]!)).toEqual({
      practitionerId: "pr-x",
      fields: ["location", "name", "phone"],
      previous: { name: "Praxis Alt" },
    });
    expect(byId["audit-current"]).toBe(currentDetails);
    expect(JSON.parse(byId["audit-orphan"]!)).toEqual({
      practitionerId: "pr-y",
      fields: ["phone"],
      previous: {},
    });
    for (const details of Object.values(byId)) {
      expect(details).not.toContain("Hauptstr");
      expect(details).not.toContain("+49");
    }

    const onDisk = await prisma.$queryRaw<{ readable_is_null: boolean }[]>`
      SELECT geometry IS NULL AS readable_is_null
      FROM workout_routes WHERE id = 'rt-jsonnull'`;
    expect(onDisk).toEqual([{ readable_is_null: true }]);

    // Converged: the next discovery finds nobody.
    const second = makeCapturingBoss();
    setGlobalBoss(second.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(second.sent).toEqual([]);
  });

  it("has the partial indexes migration 0361 adds", async () => {
    const indexes = await getPrismaClient().$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN (
        'practitioners_contact_backfill_idx',
        'workout_routes_geometry_backfill_idx'
      )
      ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      "practitioners_contact_backfill_idx",
      "workout_routes_geometry_backfill_idx",
    ]);
    expect(indexes[0].indexdef).toContain(
      "WHERE ((phone IS NOT NULL) OR (location IS NOT NULL))",
    );
    expect(indexes[1].indexdef).toContain("WHERE (geometry IS NOT NULL)");
  });

  it("uses the partial indexes migration 0357 adds", async () => {
    const indexes = await getPrismaClient().$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN (
        'coach_conversations_title_backfill_idx',
        'custom_metric_entries_note_backfill_idx'
      )
      ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      "coach_conversations_title_backfill_idx",
      "custom_metric_entries_note_backfill_idx",
    ]);
    expect(indexes[0].indexdef).toContain("WHERE (title IS NOT NULL)");
    expect(indexes[1].indexdef).toContain("WHERE (note IS NOT NULL)");
  });
});
