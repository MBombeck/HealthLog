/**
 * A FHIR Bundle whose entries are named by `urn:uuid:` was keyed on its
 * `Bundle.id` until the issuer of such an entry became `urn`. A patient
 * summary gets a new `Bundle.id` every time it is generated, so a record
 * imported under the old key must still be recognised in the next export:
 * nothing is written twice, and a row the person deleted stays deleted.
 *
 * The old behaviour is reproduced by running the importer's own pieces with
 * the issuer it used to derive, `bundle:<Bundle.id>`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => {}),
}));

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

let counter = 0;
async function makeUser() {
  const suffix = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `urn-${suffix}`,
      email: `urn-${suffix}@example.test`,
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
}

type Resource = Record<string, unknown> & { id: string; resourceType: string };

const RESOURCES: Resource[] = [
  {
    resourceType: "Condition",
    id: "1b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b01",
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code: { text: "Seasonal allergy" },
    onsetDateTime: "2020-04-01",
  },
  {
    resourceType: "Immunization",
    id: "2b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b02",
    status: "completed",
    vaccineCode: { text: "Tetanus booster" },
    occurrenceDateTime: "2024-05-03",
  },
  {
    resourceType: "MedicationStatement",
    id: "3b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b03",
    status: "active",
    medicationCodeableConcept: { text: "Cetirizine" },
    dosage: [{ text: "10 mg" }],
    effectivePeriod: { start: "2025-03-01" },
  },
  {
    resourceType: "Encounter",
    id: "4b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b04",
    status: "finished",
    class: { code: "AMB" },
    period: { start: "2025-06-02T08:30:00Z" },
    reasonCode: [{ text: "Annual check-up" }],
  },
  {
    resourceType: "Observation",
    id: "5b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b05",
    status: "final",
    category: [{ coding: [{ code: "vital-signs" }] }],
    code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
    effectiveDateTime: "2026-02-10T09:05:00Z",
    valueQuantity: { value: 70.5, code: "kg" },
  },
  {
    resourceType: "Observation",
    id: "6b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b06",
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: {
      text: "Hemoglobin A1c",
      coding: [{ system: "http://loinc.org", code: "4548-4" }],
    },
    effectiveDateTime: "2026-02-10T09:00:00Z",
    valueQuantity: { value: 5.4, unit: "%", code: "%" },
  },
];

function bundle(bundleId: string, resources: Resource[] = RESOURCES) {
  return {
    resourceType: "Bundle",
    id: bundleId,
    type: "document",
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${resource.id}`,
      resource,
    })),
  };
}

/** What an import wrote before the fix: every key under `bundle:<id>`. */
async function importWithBundleKeys(userId: string, bundleId: string) {
  const issuer = `bundle:${bundleId}`;
  const now = new Date();
  const { importRecordResource } =
    await import("@/lib/import/fhir-bundle/records");
  const { mapVital } = await import("@/lib/import/fhir-bundle/import");
  const { writeImportedMeasurements } =
    await import("@/lib/import/file-import/write-measurements");
  const { RecordFileImportTally } =
    await import("@/lib/import/file-import/tally");
  const { mapFhirLabRecord } =
    await import("@/lib/labs/fhir-import/map-observation");
  const { writeFhirLabReadings } = await import("@/lib/labs/fhir-import/write");
  const tally = new RecordFileImportTally("fhir_bundle");
  for (const resource of RESOURCES) {
    if (resource.resourceType !== "Observation") {
      const outcome = await importRecordResource({
        userId,
        issuer,
        type: resource.resourceType as
          "Condition" | "Immunization" | "MedicationStatement" | "Encounter",
        resource,
        now,
        tz: "Europe/Berlin",
      });
      expect(outcome.status).toBe("imported");
      continue;
    }
    const lab = JSON.stringify(resource.category).includes("laboratory");
    if (!lab) {
      const rows = mapVital(resource, issuer, now, "Europe/Berlin");
      if ("reason" in rows) throw new Error(rows.reason);
      await writeImportedMeasurements(userId, rows, tally);
      continue;
    }
    const mapping = mapFhirLabRecord(
      { resource, fhirVersion: "4.0.1", sourceURL: issuer },
      now,
    );
    if (mapping.kind !== "reading") throw new Error(mapping.kind);
    const written = await writeFhirLabReadings({
      userId,
      tz: "Europe/Berlin",
      readings: [mapping.reading],
      source: "IMPORT",
    });
    expect(written.inserted).toBe(1);
  }
}

async function importFile(userId: string, body: unknown) {
  const prisma = getPrismaClient();
  const dir = mkdtempSync(join(tmpdir(), "urn-fhir-"));
  cleanup.push(dir);
  const path = join(dir, "upload.bin");
  writeFileSync(path, JSON.stringify(body));
  const job = await prisma.importJob.create({
    data: { userId, kind: "fhir_bundle", status: "queued", uploadBytes: 1 },
  });
  const { runRecordFileImport } =
    await import("@/lib/jobs/record-file-import-worker");
  await runRecordFileImport({
    kind: "fhir_bundle",
    userId,
    importJobId: job.id,
    uploadPath: path,
  });
  return prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function counts(userId: string) {
  const prisma = getPrismaClient();
  const where = { userId };
  return {
    conditions: await prisma.illnessEpisode.count({ where }),
    vaccinations: await prisma.vaccinationRecord.count({ where }),
    medications: await prisma.medication.count({ where }),
    visits: await prisma.encounter.count({ where }),
    weights: await prisma.measurement.count({
      where: { userId, type: "WEIGHT" },
    }),
    labs: await prisma.labResult.count({ where }),
  };
}

const ONE_EACH = {
  conditions: 1,
  vaccinations: 1,
  medications: 1,
  visits: 1,
  weights: 1,
  labs: 1,
};

describe("FHIR Bundle import of a record keyed on its old Bundle.id", () => {
  it("writes nothing twice from the next export of the record", async () => {
    const user = await makeUser();
    await importWithBundleKeys(user.id, "summary-a");
    expect(await counts(user.id)).toEqual(ONE_EACH);

    const next = await importFile(user.id, bundle("summary-b"));
    expect(next.status).toBe("done");
    expect(next.result).toMatchObject({ imported: 0, duplicates: 6 });
    expect(await counts(user.id)).toEqual(ONE_EACH);

    // The record now answers to its new key; a third export finds it there.
    const third = await importFile(user.id, bundle("summary-c"));
    expect(third.result).toMatchObject({ imported: 0, duplicates: 6 });
    expect(await counts(user.id)).toEqual(ONE_EACH);
  });

  it("keeps a row the person deleted deleted", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser();
    await importWithBundleKeys(user.id, "summary-a");
    const gone = new Date();
    const where = { userId: user.id };
    await prisma.illnessEpisode.updateMany({
      where,
      data: { deletedAt: gone },
    });
    await prisma.vaccinationRecord.updateMany({
      where,
      data: { deletedAt: gone },
    });
    await prisma.encounter.updateMany({ where, data: { deletedAt: gone } });
    await prisma.measurement.updateMany({ where, data: { deletedAt: gone } });
    await prisma.labResult.updateMany({ where, data: { deletedAt: gone } });

    const next = await importFile(user.id, bundle("summary-b"));
    expect(next.result).toMatchObject({ imported: 0 });
    expect(
      await prisma.illnessEpisode.count({
        where: { ...where, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.vaccinationRecord.count({
        where: { ...where, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.encounter.count({ where: { ...where, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.measurement.count({ where: { ...where, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.labResult.count({ where: { ...where, deletedAt: null } }),
    ).toBe(0);
  });

  it("recognises the same file uploaded again by its old key", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser();
    await importWithBundleKeys(user.id, "summary-a");
    // A medication the person deleted outright leaves only its ledger row.
    await prisma.medication.deleteMany({ where: { userId: user.id } });

    const again = await importFile(user.id, bundle("summary-a"));
    expect(again.result).toMatchObject({ imported: 0, duplicates: 6 });
    expect(await prisma.medication.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });

  it("takes one old record for one resource only", async () => {
    const user = await makeUser();
    await importWithBundleKeys(user.id, "summary-a");
    const vaccination = RESOURCES[1]!;
    const twin = { ...vaccination, id: "7b7c0e52-51d6-4c3e-8f0a-3a1c5e9d2b07" };

    const next = await importFile(
      user.id,
      bundle("summary-b", [vaccination, twin]),
    );
    expect(next.result).toMatchObject({ imported: 1, duplicates: 1 });
    expect(
      await getPrismaClient().vaccinationRecord.count({
        where: { userId: user.id },
      }),
    ).toBe(2);
  });
});
