import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clinicalMemberNameFromReference,
  isClinicalRecordJson,
  streamAppleHealthClinicalMembers,
  streamAppleHealthEcgMembers,
  streamAppleHealthRouteMembers,
} from "../archive-stream";
import { zip64Archive } from "./helpers/zip64";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function write(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-zip64-"));
  dirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(path, bytes);
  return path;
}

async function text(stream: AsyncIterable<unknown>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return out;
}

const LIMITS = {
  maxMembers: 10,
  maxMemberBytes: 4096,
  maxCompressionRatio: 100,
};

const FILES = {
  "apple_health_export/export.xml": "<HealthData/>",
  "apple_health_export/electrocardiograms/ecg_2025-01-01.csv": "Name,x\n",
  "apple_health_export/workout-routes/route_1.gpx": "<gpx/>",
  "apple_health_export/clinical-records/Observation-1.json": '{"id":"1"}',
};

describe("archive-stream on a ZIP64 archive", () => {
  it("streams ECG, route and clinical members", async () => {
    const path = write(zip64Archive(FILES));
    const ecg: string[] = [];
    for await (const m of streamAppleHealthEcgMembers({
      archivePath: path,
      limits: { ...LIMITS, maxEcgMembers: 5, maxTotalEcgBytes: 8192 },
    })) {
      ecg.push(`${m.name}=${await text(m.stream)}`);
    }
    expect(ecg).toEqual([
      "apple_health_export/electrocardiograms/ecg_2025-01-01.csv=Name,x\n",
    ]);

    const routes: string[] = [];
    for await (const m of streamAppleHealthRouteMembers({
      archivePath: path,
      limits: { ...LIMITS, maxRouteMembers: 5, maxTotalRouteBytes: 8192 },
      wanted: () => true,
    })) {
      routes.push(await text(m.stream));
    }
    expect(routes).toEqual(["<gpx/>"]);

    const clinical: string[] = [];
    for await (const m of streamAppleHealthClinicalMembers({
      archivePath: path,
      limits: { ...LIMITS, maxClinicalMembers: 5, maxTotalClinicalBytes: 8192 },
      wanted: () => true,
    })) {
      clinical.push(await text(m.stream));
    }
    expect(clinical).toEqual(['{"id":"1"}']);
  });

  it("refuses ZIP64 sentinels without the locator", async () => {
    const path = write(zip64Archive(FILES, { omitLocator: true }));
    const run = async () => {
      for await (const m of streamAppleHealthEcgMembers({
        archivePath: path,
        limits: { ...LIMITS, maxEcgMembers: 5, maxTotalEcgBytes: 8192 },
      })) {
        void m;
      }
    };
    await expect(run()).rejects.toThrow(/ZIP64 locator/);
  });

  it("refuses a ZIP64 member without its extra field", async () => {
    const path = write(zip64Archive(FILES, { omitExtra: true }));
    const run = async () => {
      for await (const m of streamAppleHealthEcgMembers({
        archivePath: path,
        limits: { ...LIMITS, maxEcgMembers: 5, maxTotalEcgBytes: 8192 },
      })) {
        void m;
      }
    };
    await expect(run()).rejects.toThrow(/malformed ZIP64 member/);
  });

  it("still enforces the member count from the ZIP64 record", async () => {
    const path = write(zip64Archive(FILES));
    const run = async () => {
      for await (const m of streamAppleHealthEcgMembers({
        archivePath: path,
        limits: {
          ...LIMITS,
          maxMembers: 3,
          maxEcgMembers: 5,
          maxTotalEcgBytes: 8192,
        },
      })) {
        void m;
      }
    };
    await expect(run()).rejects.toThrow(/member count limit/);
  });
});

describe("clinical member names", () => {
  it("maps Apple's reference path onto the archive member", () => {
    expect(
      clinicalMemberNameFromReference("/clinical-records/Observation-A.json"),
    ).toBe("apple_health_export/clinical-records/Observation-A.json");
    expect(
      clinicalMemberNameFromReference("clinical-records/Observation-A.json"),
    ).toBe("apple_health_export/clinical-records/Observation-A.json");
  });

  it.each([
    "/clinical-records/../export.xml",
    "/clinical-records/sub/Observation.json",
    "/workout-routes/route.gpx",
    "/clinical-records/Observation.txt",
  ])("refuses %s", (path) => {
    expect(clinicalMemberNameFromReference(path)).toBeNull();
  });

  it("recognises only direct JSON children", () => {
    expect(
      isClinicalRecordJson("apple_health_export/clinical-records/a.JSON"),
    ).toBe(true);
    expect(isClinicalRecordJson("apple_health_export/clinical-records/")).toBe(
      false,
    );
  });
});
