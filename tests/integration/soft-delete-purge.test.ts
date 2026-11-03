/**
 * The nightly purge of expired tombstones for the soft-delete models the
 * retention register hands to `soft-delete-purge`.
 *
 * Proves, against the migrated schema: every table's purge statement runs; an
 * expired tombstone goes while a recent one and a live row stay; a tombstone
 * a live record still points at stays (a deleted practitioner a live visit
 * names, a deleted visit a live dose names) and goes once nothing live names
 * it; a purged visit cascades its links; a start folded into a live cycle
 * stays; the coach facts keep their longer horizon.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  purgeModels,
  purgeSoftDeletedRows,
  purgeSoftDeletedTable,
} from "@/lib/jobs/soft-delete-retention";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "soft-delete-purge-user";
const NOW = new Date("2026-10-20T03:42:00.000Z");
const DAY = 86_400_000;
const EXPIRED = new Date(NOW.getTime() - (TOMBSTONE_RETENTION_DAYS + 5) * DAY);
const RECENT = new Date(NOW.getTime() - 10 * DAY);

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, role: "USER", timezone: "UTC" },
  });
});

describe("soft-delete purge", () => {
  it("runs every table's purge against the real schema", async () => {
    const legs = await purgeSoftDeletedRows(prisma, NOW);
    expect(legs.map((leg) => leg.model)).toEqual(purgeModels());
    expect(legs.length).toBeGreaterThanOrEqual(19);
    for (const leg of legs) {
      expect(leg, leg.model).toMatchObject({ deleted: 0, drained: true });
    }
  });

  it("removes an expired tombstone and keeps a recent one and a live row", async () => {
    const lab = (id: string, deletedAt: Date | null) =>
      prisma.labResult.create({
        data: {
          id,
          userId: USER,
          analyte: "LDL",
          unit: "mg/dL",
          value: 100,
          takenAt: new Date("2026-01-01T08:00:00.000Z"),
          deletedAt,
        },
      });
    await lab("lab-expired", EXPIRED);
    await lab("lab-recent", RECENT);
    await lab("lab-live", null);

    const leg = await purgeSoftDeletedTable(prisma, "LabResult", NOW);

    expect(leg).toMatchObject({ deleted: 1, drained: true });
    const left = await prisma.labResult.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(left.map((r) => r.id)).toEqual(["lab-live", "lab-recent"]);
  });

  it("keeps a deleted practitioner a live visit still names", async () => {
    const practitioner = (id: string) =>
      prisma.practitioner.create({
        data: { id, userId: USER, name: id, deletedAt: EXPIRED },
      });
    await practitioner("doc-live-visit");
    await practitioner("doc-gone-visit");
    await practitioner("doc-unused");
    await prisma.encounter.create({
      data: {
        id: "visit-live",
        userId: USER,
        occurredAt: new Date("2026-01-01T08:00:00.000Z"),
        practitionerId: "doc-live-visit",
      },
    });
    // A visit that is itself a tombstone holds nothing back.
    await prisma.encounter.create({
      data: {
        id: "visit-tombstoned",
        userId: USER,
        occurredAt: new Date("2026-01-02T08:00:00.000Z"),
        practitionerId: "doc-gone-visit",
        deletedAt: RECENT,
      },
    });

    const leg = await purgeSoftDeletedTable(prisma, "Practitioner", NOW);

    expect(leg.deleted).toBe(2);
    const left = await prisma.practitioner.findMany({ select: { id: true } });
    expect(left.map((r) => r.id)).toEqual(["doc-live-visit"]);
    expect(
      await prisma.encounter.findUniqueOrThrow({
        where: { id: "visit-live" },
        select: { practitionerId: true },
      }),
    ).toEqual({ practitionerId: "doc-live-visit" });
  });

  it("purges the practitioner once the visit naming it is gone", async () => {
    await prisma.practitioner.create({
      data: { id: "doc", userId: USER, name: "doc", deletedAt: EXPIRED },
    });
    await prisma.encounter.create({
      data: {
        id: "visit",
        userId: USER,
        occurredAt: new Date("2026-01-01T08:00:00.000Z"),
        practitionerId: "doc",
      },
    });
    await purgeSoftDeletedTable(prisma, "Practitioner", NOW);
    expect(await prisma.practitioner.count()).toBe(1);

    await prisma.encounter.update({
      where: { id: "visit" },
      data: { deletedAt: EXPIRED },
    });
    // The visit goes first in the run's order, and the practitioner with it.
    await purgeSoftDeletedRows(prisma, NOW);
    expect(await prisma.encounter.count()).toBe(0);
    expect(await prisma.practitioner.count()).toBe(0);
  });

  it("keeps a deleted visit a live dose names and cascades a purged visit's links", async () => {
    const visit = (id: string) =>
      prisma.encounter.create({
        data: {
          id,
          userId: USER,
          occurredAt: new Date("2026-01-01T08:00:00.000Z"),
          deletedAt: EXPIRED,
        },
      });
    await visit("visit-named");
    await visit("visit-linked");
    await prisma.vaccinationRecord.create({
      data: {
        id: "vacc-live",
        userId: USER,
        occurredAt: new Date("2026-01-01T08:00:00.000Z"),
        encounterId: "visit-named",
      },
    });
    await prisma.encounterVaccinationLink.create({
      data: {
        userId: USER,
        encounterId: "visit-linked",
        vaccinationId: "vacc-live",
      },
    });

    const leg = await purgeSoftDeletedTable(prisma, "Encounter", NOW);

    expect(leg.deleted).toBe(1);
    const left = await prisma.encounter.findMany({ select: { id: true } });
    expect(left.map((r) => r.id)).toEqual(["visit-named"]);
    expect(await prisma.encounterVaccinationLink.count()).toBe(0);
    expect(
      await prisma.vaccinationRecord.findUniqueOrThrow({
        where: { id: "vacc-live" },
        select: { encounterId: true, deletedAt: true },
      }),
    ).toEqual({ encounterId: "visit-named", deletedAt: null });
  });

  it("keeps a start folded into a live cycle until that cycle goes", async () => {
    const cycle = (
      id: string,
      startDate: string,
      deletedAt: Date | null,
      absorbedIntoId: string | null = null,
    ) =>
      prisma.menstrualCycle.create({
        data: { id, userId: USER, startDate, deletedAt, absorbedIntoId },
      });
    await cycle("cycle-live", "2026-01-01", null);
    await cycle("cycle-folded", "2026-01-03", EXPIRED, "cycle-live");
    await cycle("cycle-gone-absorber", "2025-12-01", EXPIRED);
    await cycle(
      "cycle-folded-orphan",
      "2025-12-03",
      EXPIRED,
      "cycle-gone-absorber",
    );
    await cycle("cycle-plain", "2025-11-01", EXPIRED);

    const leg = await purgeSoftDeletedTable(prisma, "MenstrualCycle", NOW);

    expect(leg.deleted).toBe(3);
    const left = await prisma.menstrualCycle.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(left.map((r) => r.id)).toEqual(["cycle-folded", "cycle-live"]);
  });

  it("keeps a removed coach fact for the coach message retention", async () => {
    const fact = (id: string, deletedAt: Date) =>
      prisma.coachFact.create({
        data: {
          id,
          userId: USER,
          category: "medication",
          factEncrypted: Buffer.from("opaque"),
          deletedAt,
        },
      });
    await fact("fact-past-sync-horizon", EXPIRED);
    await fact("fact-past-a-year", new Date(NOW.getTime() - 400 * DAY));

    const leg = await purgeSoftDeletedTable(prisma, "CoachFact", NOW);

    expect(leg.deleted).toBe(1);
    const left = await prisma.coachFact.findMany({ select: { id: true } });
    expect(left.map((r) => r.id)).toEqual(["fact-past-sync-horizon"]);
  });

  it("counter-check: refuses a model the register does not hand to it", async () => {
    await expect(
      purgeSoftDeletedTable(prisma, "Measurement", NOW),
    ).rejects.toThrow("No purge entry for Measurement");
  });
});
