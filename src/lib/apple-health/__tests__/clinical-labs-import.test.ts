import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  after: vi.fn(),
  annotate: vi.fn(),
}));
vi.mock("@/lib/labs/fhir-import/write", () => ({
  writeFhirLabReadings: mocks.write,
}));
vi.mock("@/lib/labs/fhir-import/after-write", () => ({
  afterLabReadingsWritten: mocks.after,
}));
vi.mock("@/lib/logging/context", () => ({ annotate: mocks.annotate }));

import { importAppleHealthClinicalLabs } from "../clinical-labs-import";
import type { ClinicalLabReference } from "../clinical-record-ref";
import { zip64Archive } from "./helpers/zip64";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.write.mockImplementation(
    async ({ readings }: { readings: unknown[] }) => ({
      statuses: readings.map(() => ({ status: "inserted" })),
      inserted: readings.length,
      duplicate: 0,
      failed: 0,
      newestTakenAt: new Date("2025-01-01T00:00:00Z"),
    }),
  );
});

const ROOT = "apple_health_export/clinical-records/";

function observation(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    resourceType: "Observation",
    id,
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: `Analyte ${id}` },
    effectiveDateTime: "2025-01-01T08:00:00Z",
    valueQuantity: { value: 1, unit: "mmol/L" },
    ...extra,
  });
}

function archive(files: Record<string, string>, zip64 = false): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-clinical-"));
  dirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(
    path,
    zip64
      ? zip64Archive(files)
      : zipSync(
          Object.fromEntries(
            Object.entries(files).map(([name, body]) => [name, strToU8(body)]),
          ),
        ),
  );
  return path;
}

function ref(
  path: string | null,
  identifier: string | null = null,
): ClinicalLabReference {
  return {
    path,
    identifier,
    sourceURL: "https://fhir.example.test",
    sourceName: "Example",
    fhirVersion: "4.0.1",
  };
}

function run(path: string, references: ClinicalLabReference[], limits = {}) {
  return importAppleHealthClinicalLabs({
    archivePath: path,
    userId: "user-1",
    tz: "Europe/Berlin",
    references,
    limits: {
      maxMembers: 50,
      maxClinicalMembers: 20,
      maxMemberBytes: 64 * 1024,
      maxTotalClinicalBytes: 1024 * 1024,
      maxCompressionRatio: 200,
      ...limits,
    },
  });
}

describe("importAppleHealthClinicalLabs", () => {
  it("reads only referenced members and writes their readings with panels", async () => {
    const path = archive({
      "apple_health_export/export.xml": "<HealthData/>",
      [`${ROOT}Observation-a.json`]: observation("a"),
      [`${ROOT}Observation-panel.json`]: observation("panel", {
        code: { text: "Electrolytes" },
        valueQuantity: undefined,
        hasMember: [{ reference: "Observation/a" }],
      }),
      [`${ROOT}Condition-c.json`]: '{"resourceType":"Condition"}',
    });
    const counts = await run(path, [
      ref("/clinical-records/Observation-a.json", "a"),
      ref("/clinical-records/Observation-panel.json", "panel"),
    ]);
    expect(counts).toEqual({
      discovered: 2,
      imported: 1,
      duplicate: 0,
      skipped: 1,
      failed: 0,
    });
    const [{ readings, tz, userId }] = mocks.write.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(tz).toBe("Europe/Berlin");
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      analyte: "Analyte a",
      panel: "Electrolytes",
    });
    expect(mocks.after).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", inserted: 1 }),
    );
  });

  it("works on a ZIP64 archive", async () => {
    const path = archive(
      { [`${ROOT}Observation-a.json`]: observation("a") },
      true,
    );
    const counts = await run(path, [
      ref("/clinical-records/Observation-a.json"),
    ]);
    expect(counts.imported).toBe(1);
  });

  it("counts a missing member, malformed JSON and an unsafe path as failed", async () => {
    const path = archive({ [`${ROOT}Observation-bad.json`]: "{not json" });
    const counts = await run(path, [
      ref("/clinical-records/Observation-bad.json"),
      ref("/clinical-records/Observation-gone.json"),
      ref("/clinical-records/../export.xml"),
    ]);
    expect(counts).toMatchObject({ discovered: 3, imported: 0, failed: 3 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("finds a reference without a path by the resource id", async () => {
    const path = archive({
      [`${ROOT}one.json`]: observation("a"),
      [`${ROOT}two.json`]: observation("unreferenced"),
    });
    const counts = await run(path, [ref(null, "a")]);
    expect(counts).toMatchObject({ discovered: 1, imported: 1, failed: 0 });
    expect(mocks.write.mock.calls[0][0].readings).toHaveLength(1);
  });

  it("refuses references past the clinical member ceiling", async () => {
    const path = archive({ [`${ROOT}Observation-a.json`]: observation("a") });
    const counts = await run(
      path,
      [
        ref("/clinical-records/Observation-a.json"),
        ref("/clinical-records/Observation-b.json"),
      ],
      { maxClinicalMembers: 1 },
    );
    expect(counts).toMatchObject({ discovered: 2, imported: 1, failed: 1 });
  });

  it("fails soft when the archive breaks a limit", async () => {
    const path = archive({ [`${ROOT}Observation-a.json`]: observation("a") });
    const counts = await run(
      path,
      [ref("/clinical-records/Observation-a.json")],
      {
        maxMemberBytes: 10,
      },
    );
    expect(counts).toMatchObject({ discovered: 1, imported: 0, failed: 1 });
  });

  it("fails only the file over a per-member limit and reads the rest", async () => {
    const path = archive({
      [`${ROOT}Observation-a.json`]: observation("a"),
      [`${ROOT}Observation-big.json`]: observation("big", {
        note: [{ text: "x".repeat(4_000) }],
      }),
      [`${ROOT}Observation-c.json`]: observation("c"),
    });
    const counts = await run(
      path,
      [
        ref("/clinical-records/Observation-a.json"),
        ref("/clinical-records/Observation-big.json"),
        ref("/clinical-records/Observation-c.json"),
      ],
      { maxMemberBytes: 1_024 },
    );
    expect(counts).toMatchObject({ discovered: 3, imported: 2, failed: 1 });
    expect(JSON.stringify(mocks.annotate.mock.calls)).toContain(
      "member_too_large",
    );
  });

  it("annotates counts and closed reasons only", async () => {
    const path = archive({
      [`${ROOT}Observation-a.json`]: observation("a", {
        code: { text: "Secret analyte name" },
        status: "preliminary",
      }),
    });
    await run(path, [ref("/clinical-records/Observation-a.json")]);
    const serialised = JSON.stringify(mocks.annotate.mock.calls);
    expect(serialised).not.toContain("Secret analyte name");
    expect(serialised).not.toContain("fhir.example.test");
    expect(mocks.annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "apple_health.import.clinical_labs" },
        meta: expect.objectContaining({
          skipped: 1,
          reasons: { not_final: 1 },
        }),
      }),
    );
  });

  it("does nothing for no references", async () => {
    const counts = await run("/nonexistent.zip", []);
    expect(counts.discovered).toBe(0);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
