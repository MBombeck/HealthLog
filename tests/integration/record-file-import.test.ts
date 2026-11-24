/**
 * The record-file imports end to end against Postgres: a synthetic
 * Gadgetbridge database and a synthetic FHIR R4 Bundle, each run through the
 * worker twice. The first run writes native rows and a summary of counts and
 * closed reasons; the second writes nothing and counts duplicates. A run that
 * reaches its time budget stops, keeps what it wrote, and fails the job so
 * the same file can be uploaded again.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";
import { buildGadgetbridgeFixture } from "@/lib/import/gadgetbridge/__tests__/fixture";
import type { RecordFileImportKind } from "@/lib/import/file-import/kinds";

vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => {}),
}));

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let counter = 0;
async function makeUser() {
  const suffix = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `rfi-${suffix}`,
      email: `rfi-${suffix}@example.test`,
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
}

/** A staged copy of `source`, as the upload route leaves it for the worker. */
function stage(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rfi-stage-"));
  cleanup.push(dir);
  const path = join(dir, "upload.bin");
  copyFileSync(source, path);
  return path;
}

async function run(userId: string, kind: RecordFileImportKind, source: string) {
  const prisma = getPrismaClient();
  const job = await prisma.importJob.create({
    data: { userId, kind, status: "queued", uploadBytes: 1 },
  });
  const { runRecordFileImport } =
    await import("@/lib/jobs/record-file-import-worker");
  await runRecordFileImport({
    kind,
    userId,
    importJobId: job.id,
    uploadPath: stage(source),
  });
  return prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("Gadgetbridge import", () => {
  it("maps the sample tables onto native types, once", async () => {
    const user = await makeUser();
    const fixture = buildGadgetbridgeFixture();
    cleanup.push(dirname(fixture));

    const first = await run(user.id, "gadgetbridge", fixture);
    expect(first.status).toBe("done");
    const result = first.result as {
      imported: number;
      duplicates: number;
      lines: Array<{ key: string; imported: number }>;
      skips: Array<{ key: string; reason: string; count: number }>;
    };
    const byKey = Object.fromEntries(
      result.lines.map((l) => [l.key, l.imported]),
    );
    expect(byKey).toEqual({
      ACTIVITY_STEPS: 1,
      PULSE: 1,
      OXYGEN_SATURATION: 1,
      RESTING_HEART_RATE: 1,
      SLEEP_DURATION: 1,
      WEIGHT: 1,
    });
    expect(result.skips).toEqual(
      expect.arrayContaining([
        { key: "HUAMI_STRESS_SAMPLE", reason: "not_read", count: 1 },
        { key: "HUAMI_SPO2_SAMPLE", reason: "invalid_value", count: 1 },
      ]),
    );

    const prisma = getPrismaClient();
    const steps = await prisma.measurement.findFirstOrThrow({
      where: { userId: user.id, type: "ACTIVITY_STEPS" },
    });
    // The band's 6 000 steps, not the band and the watch added together.
    expect(steps.value).toBe(6000);
    expect(steps.source).toBe("IMPORT");
    const pulse = await prisma.measurement.findFirstOrThrow({
      where: { userId: user.id, type: "PULSE" },
    });
    // The "no reading" marker (255) and the watch's zeros are not averaged in.
    expect(pulse.value).toBe(70);
    const sleep = await prisma.measurement.findFirstOrThrow({
      where: { userId: user.id, type: "SLEEP_DURATION" },
    });
    expect(sleep.value).toBe(480);

    const second = await run(user.id, "gadgetbridge", fixture);
    expect(second.status).toBe("done");
    expect(second.result).toMatchObject({ imported: 0, duplicates: 6 });
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      6,
    );
  });

  it("takes a later export's larger day total", async () => {
    const user = await makeUser();
    const fixture = buildGadgetbridgeFixture();
    const later = buildGadgetbridgeFixture({ extraSteps: 500 });
    cleanup.push(dirname(fixture), dirname(later));
    await run(user.id, "gadgetbridge", fixture);
    await run(user.id, "gadgetbridge", later);
    const steps = await getPrismaClient().measurement.findMany({
      where: { userId: user.id, type: "ACTIVITY_STEPS" },
    });
    expect(steps.map((s) => s.value)).toEqual([6500]);
  });

  it("refuses a file that is not a Gadgetbridge database", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(join(tmpdir(), "rfi-bad-"));
    cleanup.push(dir);
    const path = join(dir, "bad");
    writeFileSync(path, "not a database");
    const job = await run(user.id, "gadgetbridge", path);
    expect(job.status).toBe("failed");
    expect(job.failureReason).toMatch(/^not_gadgetbridge:/);
  });
});

function bundle() {
  const base = "https://portal.example/fhir";
  const entry = (resource: Record<string, unknown>) => ({
    fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
    resource,
  });
  return {
    resourceType: "Bundle",
    id: "export-1",
    type: "collection",
    entry: [
      entry({
        resourceType: "Observation",
        id: "lab-1",
        status: "final",
        category: [{ coding: [{ code: "laboratory" }] }],
        code: {
          text: "Hemoglobin A1c",
          coding: [{ system: "http://loinc.org", code: "4548-4" }],
        },
        effectiveDateTime: "2026-02-10T09:00:00Z",
        valueQuantity: { value: 5.4, unit: "%", code: "%" },
      }),
      entry({
        resourceType: "Observation",
        id: "vital-1",
        status: "final",
        category: [{ coding: [{ code: "vital-signs" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
        effectiveDateTime: "2026-02-10T09:05:00Z",
        valueQuantity: { value: 70.5, code: "kg" },
      }),
      entry({
        resourceType: "Condition",
        id: "cond-1",
        clinicalStatus: { coding: [{ code: "active" }] },
        verificationStatus: { coding: [{ code: "confirmed" }] },
        code: { text: "Seasonal allergy" },
        onsetDateTime: "2020-04-01",
      }),
      entry({
        resourceType: "Condition",
        id: "cond-2",
        verificationStatus: { coding: [{ code: "refuted" }] },
        code: { text: "Ruled out" },
        onsetDateTime: "2021-01-01",
      }),
      entry({
        resourceType: "Immunization",
        id: "imm-1",
        status: "completed",
        vaccineCode: { text: "Tetanus booster" },
        occurrenceDateTime: "2024-05-03",
        lotNumber: "LOT-1",
      }),
      entry({
        resourceType: "MedicationStatement",
        id: "med-1",
        status: "active",
        medicationCodeableConcept: { text: "Example tablet" },
        dosage: [{ text: "1 daily" }],
        effectivePeriod: { start: "2025-01-01" },
      }),
      entry({
        resourceType: "Encounter",
        id: "enc-1",
        status: "finished",
        class: { code: "AMB" },
        reasonCode: [{ text: "Check-up" }],
        period: { start: "2026-02-10T08:30:00Z" },
      }),
      entry({ resourceType: "Patient", id: "p-1" }),
    ],
  };
}

describe("FHIR Bundle import", () => {
  it("maps each resource type onto its model, once per resource id", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(join(tmpdir(), "rfi-fhir-"));
    cleanup.push(dir);
    const path = join(dir, "bundle.json");
    writeFileSync(path, JSON.stringify(bundle()));

    const first = await run(user.id, "fhir_bundle", path);
    expect(first.status).toBe("done");
    const result = first.result as {
      lines: Array<{ key: string; imported: number }>;
      skips: Array<{ key: string; reason: string; count: number }>;
    };
    expect(
      Object.fromEntries(result.lines.map((l) => [l.key, l.imported])),
    ).toEqual({
      WEIGHT: 1,
      condition: 1,
      lab: 1,
      medication: 1,
      vaccination: 1,
      visit: 1,
    });
    expect(result.skips).toEqual(
      expect.arrayContaining([
        { key: "Condition", reason: "not_confirmed", count: 1 },
        { key: "Patient", reason: "unsupported_type", count: 1 },
      ]),
    );

    const prisma = getPrismaClient();
    const lab = await prisma.labResult.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(lab.source).toBe("IMPORT");
    expect(lab.value).toBeCloseTo(5.4);
    const medication = await prisma.medication.findFirstOrThrow({
      where: { userId: user.id },
    });
    // An import states what was taken; it does not start reminding.
    expect(medication.notificationsEnabled).toBe(false);
    expect(
      await prisma.illnessEpisode.count({ where: { userId: user.id } }),
    ).toBe(1);

    const second = await run(user.id, "fhir_bundle", path);
    expect(second.result).toMatchObject({ imported: 0, duplicates: 6 });
    expect(await prisma.encounter.count({ where: { userId: user.id } })).toBe(
      1,
    );
    expect(
      await prisma.vaccinationRecord.count({ where: { userId: user.id } }),
    ).toBe(1);
  });

  it("reads a malformed date as absent instead of failing the file", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(join(tmpdir(), "rfi-fhir-"));
    cleanup.push(dir);
    const path = join(dir, "bundle.json");
    const base = "https://portal.example/fhir";
    const entry = (resource: Record<string, unknown>) => ({
      fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
      resource,
    });
    writeFileSync(
      path,
      JSON.stringify({
        resourceType: "Bundle",
        id: "export-bad-dates",
        type: "collection",
        entry: [
          // A month of 13 next to a readable `recorded`: the day comes off
          // the field that parsed.
          entry({
            resourceType: "Immunization",
            id: "imm-bad",
            status: "completed",
            vaccineCode: { text: "Tetanus booster" },
            occurrenceDateTime: "2024-13-03",
            recorded: "2024-05-04",
          }),
          entry({
            resourceType: "MedicationStatement",
            id: "med-bad",
            status: "active",
            medicationCodeableConcept: { text: "Example tablet" },
            effectivePeriod: { start: "2025-02-30" },
            effectiveDateTime: "2025-01-01",
          }),
          entry({
            resourceType: "Observation",
            id: "vital-1",
            status: "final",
            category: [{ coding: [{ code: "vital-signs" }] }],
            code: {
              coding: [{ system: "http://loinc.org", code: "29463-7" }],
            },
            effectiveDateTime: "2026-02-10T09:05:00Z",
            valueQuantity: { value: 70.5, code: "kg" },
          }),
        ],
      }),
    );

    const job = await run(user.id, "fhir_bundle", path);
    expect(job.status).toBe("done");
    const prisma = getPrismaClient();
    const vaccination = await prisma.vaccinationRecord.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(vaccination.occurredAt.toISOString().slice(0, 10)).toBe(
      "2024-05-04",
    );
    const medication = await prisma.medication.findFirstOrThrow({
      where: { userId: user.id },
      include: { courses: true },
    });
    expect(
      medication.courses.map((c) => c.startsOn.toISOString().slice(0, 10)),
    ).toEqual(["2025-01-01"]);
    expect(
      await prisma.measurement.count({
        where: { userId: user.id, type: "WEIGHT" },
      }),
    ).toBe(1);
  });

  it("recognises a urn:uuid resource again in the next export of the record", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(join(tmpdir(), "rfi-fhir-"));
    cleanup.push(dir);
    // A document Bundle names its entries by urn:uuid and gets a new id each
    // time it is generated.
    const summary = (bundleId: string) => ({
      resourceType: "Bundle",
      id: bundleId,
      type: "document",
      entry: [
        {
          fullUrl: "urn:uuid:7d3c1a52-0d1e-4b4e-9a51-0a6f3c1e2b10",
          resource: {
            resourceType: "Immunization",
            id: "7d3c1a52-0d1e-4b4e-9a51-0a6f3c1e2b10",
            status: "completed",
            vaccineCode: { text: "Tetanus booster" },
            occurrenceDateTime: "2024-05-03",
          },
        },
        {
          fullUrl: "urn:uuid:0f1e2d3c-4b5a-4968-8776-655443322110",
          resource: {
            resourceType: "Observation",
            id: "0f1e2d3c-4b5a-4968-8776-655443322110",
            status: "final",
            category: [{ coding: [{ code: "vital-signs" }] }],
            code: {
              coding: [{ system: "http://loinc.org", code: "29463-7" }],
            },
            effectiveDateTime: "2026-02-10T09:05:00Z",
            valueQuantity: { value: 70.5, code: "kg" },
          },
        },
      ],
    });
    const first = join(dir, "summary-1.json");
    const second = join(dir, "summary-2.json");
    writeFileSync(first, JSON.stringify(summary("summary-a")));
    writeFileSync(second, JSON.stringify(summary("summary-b")));

    await run(user.id, "fhir_bundle", first);
    const again = await run(user.id, "fhir_bundle", second);
    expect(again.result).toMatchObject({ imported: 0, duplicates: 2 });
    const prisma = getPrismaClient();
    expect(
      await prisma.vaccinationRecord.count({ where: { userId: user.id } }),
    ).toBe(1);
    expect(
      await prisma.measurement.count({
        where: { userId: user.id, type: "WEIGHT" },
      }),
    ).toBe(1);
  });

  it("refuses a file that is not a Bundle", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(join(tmpdir(), "rfi-fhir-"));
    cleanup.push(dir);
    const path = join(dir, "x.json");
    writeFileSync(path, JSON.stringify({ resourceType: "Patient" }));
    const job = await run(user.id, "fhir_bundle", path);
    expect(job.status).toBe("failed");
    expect(job.failureReason).toMatch(/^not_fhir_bundle:/);
  });
});

describe("FHIR Bundle import across a backup", () => {
  it.each(["portable-export", "disaster-recovery"] as const)(
    "adds nothing when the same Bundle is imported after a %s restore",
    async (purpose) => {
      const prisma = getPrismaClient();
      const user = await makeUser();
      const dir = mkdtempSync(join(tmpdir(), "rfi-fhir-"));
      cleanup.push(dir);
      const path = join(dir, "bundle.json");
      writeFileSync(path, JSON.stringify(bundle()));
      await run(user.id, "fhir_bundle", path);

      const { buildFullBackupPayload } =
        await import("@/lib/export/full-backup-payload");
      const { payload } = await buildFullBackupPayload(prisma, user.id, {
        purpose,
      });
      expect(
        (payload as { fhirImportedResources?: unknown[] })
          .fhirImportedResources,
      ).toHaveLength(4);
      // The import ledger and the imported rows are gone, as on a fresh
      // instance; only the file can bring the ledger back.
      await prisma.fhirImportedResource.deleteMany({
        where: { userId: user.id },
      });
      const { encrypt } = await import("@/lib/crypto");
      const backup = await prisma.dataBackup.create({
        data: {
          userId: user.id,
          type: "FHIR_LEDGER_ROUND_TRIP",
          data: encrypt(JSON.stringify(payload)),
        },
      });
      const { restoreBackup } = await import("@/lib/export/restore-backup");
      const { STORED_BACKUP_SELECT } =
        await import("@/lib/export/stored-backup");
      const outcome = await restoreBackup({
        backup: await prisma.dataBackup.findUniqueOrThrow({
          where: { id: backup.id },
          select: STORED_BACKUP_SELECT,
        }),
        actorUserId: user.id,
        ipAddress: null,
        restoreInstanceSettings: false,
      });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: true,
        response: { restored: true },
      });
      expect(
        await prisma.fhirImportedResource.count({ where: { userId: user.id } }),
      ).toBe(4);

      const again = await run(user.id, "fhir_bundle", path);
      expect(again.result).toMatchObject({ imported: 0, duplicates: 6 });
      expect(
        await prisma.illnessEpisode.count({ where: { userId: user.id } }),
      ).toBe(1);
      expect(
        await prisma.vaccinationRecord.count({ where: { userId: user.id } }),
      ).toBe(1);
      expect(
        await prisma.medication.count({ where: { userId: user.id } }),
      ).toBe(1);
      expect(await prisma.encounter.count({ where: { userId: user.id } })).toBe(
        1,
      );
    },
  );
});

describe("time budget", () => {
  it("stops, keeps its counts and fails the job for a retry", async () => {
    vi.resetModules();
    vi.doMock("@/lib/import/file-import/kinds", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      RECORD_FILE_IMPORT_BUDGET_MS: 0,
    }));
    try {
      const user = await makeUser();
      const fixture = buildGadgetbridgeFixture();
      cleanup.push(dirname(fixture));
      const job = await run(user.id, "gadgetbridge", fixture);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toMatch(/^time_budget:/);
      expect(job.result).toMatchObject({ budgetExceeded: true });
    } finally {
      vi.doUnmock("@/lib/import/file-import/kinds");
      vi.resetModules();
    }
  });
});
