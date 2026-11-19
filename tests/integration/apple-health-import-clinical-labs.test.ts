/**
 * Lab results from Health Records inside an Apple Health export (#1400),
 * through the real import worker against a real Postgres:
 *
 *   - a lab result reaches the account's marker by its LOINC code, and a
 *     reading in another unit is converted with what the report printed kept;
 *   - panel members carry the panel's name, a panel header and a preliminary
 *     result are skipped, a unit the marker cannot take fails without failing
 *     the import, a non-lab clinical record stays in the clinical skips;
 *   - a reading already typed by hand is a duplicate;
 *   - uploading the same archive again writes nothing, and a deleted result
 *     stays deleted;
 *   - a current export, whose `type` attribute holds the FHIR resource type
 *     instead of the HealthKit identifier, imports its R4 and DSTU2 lab
 *     Observations the same way and leaves every other resource skipped.
 *
 * Every fixture is synthetic.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Job } from "pg-boss";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  _setWorkerPrismaForTests,
  handleAppleHealthImport,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  recomputeUserRollups: vi.fn(async () => {}),
}));

const prisma = getPrismaClient();
const USER_ID = "user-apple-clinical-labs";
const SOURCE_URL = "https://fhir.example-clinic.test/api/FHIR/R4";
let jobSequence = 0;

function lab(
  id: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    effectiveDateTime: "2025-03-04T08:15:00+01:00",
    subject: { reference: "Patient/synthetic-patient" },
    ...extra,
  };
}

const RESOURCES: Record<string, Record<string, unknown>> = {
  ldl: lab("ldl", {
    code: {
      text: "LDL Cholesterol (calc)",
      coding: [{ system: "http://loinc.org", code: "13457-7" }],
    },
    valueQuantity: { value: 3.1, unit: "mmol/L", code: "mmol/L" },
    referenceRange: [{ high: { value: 3, unit: "mmol/L" } }],
  }),
  cbc: lab("cbc", {
    code: { text: "Complete blood count" },
    hasMember: [{ reference: "Observation/hgb" }],
  }),
  hgb: lab("hgb", {
    code: { text: "Hemoglobin" },
    valueQuantity: { value: 14.2, unit: "g/dL" },
  }),
  prelim: lab("prelim", {
    status: "preliminary",
    code: { text: "Potassium" },
    valueQuantity: { value: 4.1, unit: "mmol/L" },
  }),
  odd: lab("odd", {
    code: { text: "Odd marker" },
    valueQuantity: { value: 2, unit: "mmol/L" },
  }),
  glucose: lab("glucose", {
    code: { text: "Glucose" },
    valueQuantity: { value: 92, unit: "mg/dL" },
  }),
};

function exportXml(): string {
  const records = Object.keys(RESOURCES)
    .map(
      (id) => `  <ClinicalRecord type="HKClinicalTypeIdentifierLabResultRecord"
    identifier="${id}" sourceName="Example Clinic" sourceURL="${SOURCE_URL}"
    fhirVersion="4.0.1" receivedDate="2025-03-05 10:00:00 +0100"
    resourceFilePath="/clinical-records/Observation-${id}.json"/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2025-03-06 10:00:00 +0100"/>
${records}
  <ClinicalRecord type="HKClinicalTypeIdentifierConditionRecord"
    identifier="cond-1" sourceName="Example Clinic" fhirVersion="4.0.1"
    resourceFilePath="/clinical-records/Condition-cond-1.json"/>
</HealthData>`;
}

function defaultFiles(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    "apple_health_export/export.xml": strToU8(exportXml()),
    "apple_health_export/clinical-records/Condition-cond-1.json": strToU8(
      JSON.stringify({ resourceType: "Condition", id: "cond-1" }),
    ),
  };
  for (const [id, resource] of Object.entries(RESOURCES)) {
    files[`apple_health_export/clinical-records/Observation-${id}.json`] =
      strToU8(JSON.stringify(resource));
  }
  return files;
}

function createArchive(files: Record<string, Uint8Array>): {
  path: string;
  bytes: Buffer;
} {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-clinical-integration-"));
  const path = join(dir, "export.zip");
  const bytes = Buffer.from(zipSync(files, { level: 6 }));
  writeFileSync(path, bytes);
  return { path, bytes };
}

async function runArchive(
  userId: string = USER_ID,
  files: Record<string, Uint8Array> = defaultFiles(),
): Promise<Record<string, unknown>> {
  const archive = createArchive(files);
  jobSequence += 1;
  const jobId = `apple-clinical-job-${jobSequence}`;
  const mirror = await prisma.importJob.create({
    data: {
      userId,
      pgBossJobId: jobId,
      status: "queued",
      uploadBytes: archive.bytes.length,
      uploadSha256: createHash("sha256").update(archive.bytes).digest("hex"),
      parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
    },
  });
  const data: AppleHealthImportPayload = {
    userId,
    uploadPath: archive.path,
    uploadBytes: archive.bytes.length,
    enqueuedAt: "2025-03-06T09:00:00.000Z",
  };
  const outcome = await handleAppleHealthImport({
    id: jobId,
    data,
  } as unknown as Job<AppleHealthImportPayload>);
  expect(outcome.ok).toBe(true);
  const row = await prisma.importJob.findUnique({ where: { id: mirror.id } });
  expect(row?.status).toBe("done");
  return row?.result as Record<string, unknown>;
}

let ldlMarkerId = "";
let glucoseMarkerId = "";

beforeAll(async () => {
  await truncateAllTables(prisma);
  _setWorkerPrismaForTests(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "apple-clinical-labs",
      email: "apple-clinical-labs@example.test",
      timezone: "Europe/Berlin",
    },
  });
  ldlMarkerId = (
    await prisma.biomarker.create({
      data: { userId: USER_ID, name: "LDL", unit: "mg/dL" },
    })
  ).id;
  await prisma.biomarker.create({
    data: { userId: USER_ID, name: "Odd marker", unit: "U/L" },
  });
  glucoseMarkerId = (
    await prisma.biomarker.create({
      data: { userId: USER_ID, name: "Glucose", unit: "mg/dL" },
    })
  ).id;
  // Typed by hand on the same day, before the export arrived.
  await prisma.labResult.create({
    data: {
      userId: USER_ID,
      biomarkerId: glucoseMarkerId,
      analyte: "Glucose",
      value: 92,
      unit: "mg/dL",
      takenAt: new Date("2025-03-04T09:00:00.000Z"),
      source: "MANUAL",
    },
  });
});

afterAll(() => {
  _setWorkerPrismaForTests(null);
});

describe("Apple Health export: lab results from Health Records", () => {
  it("imports the lab results and reports bounded counts", async () => {
    const result = await runArchive();
    expect(result.labs).toEqual({
      discovered: 6,
      imported: 2,
      duplicate: 1,
      skipped: 2,
      failed: 1,
      // Hemoglobin is new to the account; LDL and Glucose already exist.
      markersCreated: 1,
    });
    expect(result.clinical).toEqual({ skipped: 1 });

    const rows = await prisma.labResult.findMany({
      where: { userId: USER_ID, source: "APPLE_HEALTH" },
      orderBy: { analyte: "asc" },
    });
    expect(rows).toHaveLength(2);
    const [hemoglobin, ldl] = rows;

    // Matched to the existing "LDL" marker through its LOINC code, converted
    // into the marker's unit, the printed value kept.
    expect(ldl.biomarkerId).toBe(ldlMarkerId);
    expect(ldl.analyte).toBe("LDL");
    expect(ldl.unit).toBe("mg/dL");
    expect(ldl.value).toBeCloseTo(119.9, 0);
    expect(ldl.sourceValue).toBe(3.1);
    expect(ldl.sourceUnit).toBe("mmol/L");
    expect(ldl.sourceReferenceHigh).toBeCloseTo(116, 0);
    expect(ldl.takenAt.toISOString()).toBe("2025-03-04T07:15:00.000Z");
    expect(ldl.externalId).toMatch(/^fhir:[0-9a-f]{40}$/);

    // A new analyte gets a marker; the member carries its panel's name.
    expect(hemoglobin.analyte).toBe("Hemoglobin");
    expect(hemoglobin.panel).toBe("Complete blood count");
    expect(hemoglobin.value).toBe(14.2);
    const marker = await prisma.biomarker.findFirst({
      where: { userId: USER_ID, name: "Hemoglobin" },
    });
    expect(marker?.unit).toBe("g/dL");

    // Nothing from the resource outside the reading.
    expect(JSON.stringify(result)).not.toContain("synthetic-patient");
    expect(JSON.stringify(result)).not.toContain("example-clinic");
  });

  it("writes nothing when the same archive is uploaded again", async () => {
    const result = await runArchive();
    expect(result.labs).toEqual({
      discovered: 6,
      imported: 0,
      duplicate: 3,
      skipped: 2,
      failed: 1,
      markersCreated: 0,
    });
    expect(
      await prisma.labResult.count({
        where: { userId: USER_ID, source: "APPLE_HEALTH" },
      }),
    ).toBe(2);
  });

  it("keeps a deleted result deleted", async () => {
    const hemoglobin = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER_ID, analyte: "Hemoglobin" },
    });
    await prisma.labResult.update({
      where: { id: hemoglobin.id },
      data: { deletedAt: new Date() },
    });
    const result = await runArchive();
    expect(result.labs).toMatchObject({ imported: 0, duplicate: 3 });
    expect(
      await prisma.labResult.count({
        where: { userId: USER_ID, analyte: "Hemoglobin" },
      }),
    ).toBe(1);
    expect(
      await prisma.labResult.count({
        where: { userId: USER_ID, analyte: "Hemoglobin", deletedAt: null },
      }),
    ).toBe(0);
  });
});

describe("Apple Health export: Health Records named by FHIR resource type", () => {
  const CURRENT_USER = "user-apple-clinical-current";
  const DSTU2_URL = "https://fhir.example-clinic.test/api/FHIR/DSTU2";

  // The form a 2026 export writes: `type` holds the resource type, and the
  // institution may serve R4 or DSTU2.
  const current: Record<
    string,
    { type?: string; fhirVersion: string; resource: Record<string, unknown> }
  > = {
    "Observation-sodium": {
      type: "Observation",
      fhirVersion: "4.0.1",
      resource: lab("sodium", {
        code: { text: "Sodium" },
        valueQuantity: { value: 140, unit: "mmol/L" },
      }),
    },
    "Observation-hba1c": {
      type: "Observation",
      fhirVersion: "1.0.2",
      // DSTU2: one category object, not a list.
      resource: {
        resourceType: "Observation",
        id: "hba1c",
        status: "final",
        category: {
          coding: [
            {
              system: "http://hl7.org/fhir/observation-category",
              code: "laboratory",
            },
          ],
        },
        code: { text: "Hemoglobin A1c" },
        effectiveDateTime: "2025-03-04T08:15:00+01:00",
        valueQuantity: { value: 5.4, unit: "%" },
      },
    },
    "Observation-pulse": {
      type: "Observation",
      fhirVersion: "1.0.2",
      resource: {
        resourceType: "Observation",
        id: "pulse",
        status: "final",
        category: { coding: [{ code: "vital-signs" }] },
        code: { text: "Heart rate" },
        effectiveDateTime: "2025-03-04T08:15:00+01:00",
        valueQuantity: { value: 61, unit: "/min" },
      },
    },
    // No type attribute at all: the file name says what it is.
    "Observation-ferritin": {
      fhirVersion: "4.0.1",
      resource: lab("ferritin", {
        code: { text: "Ferritin" },
        valueQuantity: { value: 80, unit: "ng/mL" },
      }),
    },
    "DiagnosticReport-panel": {
      type: "DiagnosticReport",
      fhirVersion: "4.0.1",
      resource: { resourceType: "DiagnosticReport", id: "panel" },
    },
    "MedicationRequest-mr": {
      type: "MedicationRequest",
      fhirVersion: "4.0.1",
      resource: { resourceType: "MedicationRequest", id: "mr" },
    },
    "Condition-cond": {
      type: "Condition",
      fhirVersion: "1.0.2",
      resource: { resourceType: "Condition", id: "cond" },
    },
    "Patient-pt": {
      type: "Patient",
      fhirVersion: "1.0.2",
      resource: { resourceType: "Patient", id: "pt" },
    },
  };

  function currentFiles(): Record<string, Uint8Array> {
    const records = Object.entries(current)
      .map(([file, entry]) => {
        const type = entry.type ? ` type="${entry.type}"` : "";
        const url = entry.fhirVersion === "1.0.2" ? DSTU2_URL : SOURCE_URL;
        return `  <ClinicalRecord${type} identifier="${entry.resource.id}"
    sourceName="Example Clinic" sourceURL="${url}"
    fhirVersion="${entry.fhirVersion}" receivedDate="2026-11-18 10:00:00 +0100"
    resourceFilePath="/clinical-records/${file}.json"/>`;
      })
      .join("\n");
    const files: Record<string, Uint8Array> = {
      "apple_health_export/export.xml":
        strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2026-11-18 10:00:00 +0100"/>
${records}
</HealthData>`),
    };
    for (const [file, entry] of Object.entries(current)) {
      files[`apple_health_export/clinical-records/${file}.json`] = strToU8(
        JSON.stringify(entry.resource),
      );
    }
    return files;
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: CURRENT_USER,
        username: "apple-clinical-current",
        email: "apple-clinical-current@example.test",
        timezone: "Europe/Berlin",
      },
    });
  });

  it("imports the R4 and DSTU2 lab results and skips the rest", async () => {
    const result = await runArchive(CURRENT_USER, currentFiles());
    expect(result.labs).toEqual({
      discovered: 4,
      imported: 3,
      duplicate: 0,
      // The DSTU2 heart rate is a vital sign, not a lab result.
      skipped: 1,
      failed: 0,
      markersCreated: 3,
    });
    // DiagnosticReport, MedicationRequest, Condition, Patient.
    expect(result.clinical).toEqual({ skipped: 4 });

    const rows = await prisma.labResult.findMany({
      where: { userId: CURRENT_USER, source: "APPLE_HEALTH" },
      orderBy: { analyte: "asc" },
      select: { analyte: true, value: true, unit: true },
    });
    expect(rows).toEqual([
      { analyte: "Ferritin", value: 80, unit: "ng/mL" },
      { analyte: "Hemoglobin A1c", value: 5.4, unit: "%" },
      { analyte: "Sodium", value: 140, unit: "mmol/L" },
    ]);
  });
});
