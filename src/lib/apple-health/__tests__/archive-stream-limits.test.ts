/**
 * Which members the per-member and per-kind limits apply to, and what a
 * breach costs.
 *
 * A pass reads one kind of member, and of that kind only the ones it wants
 * (the routes and Health Records files the export's XML references). A
 * member it is not going to read cannot make the archive unsafe for it, so
 * its size, its compression ratio and how many of its kind there are do not
 * count; only the archive-wide ceiling on directory entries does. A member
 * the pass does want and that breaks a per-member limit fails on its own, the
 * other members are still read. A breach of a running total still ends the
 * pass. The ceiling on directory entries is the same for every pass, so an
 * export with many files reads the same in all three.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { strToU8, zipSync, type Zippable } from "fflate";

import {
  APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
  streamAppleHealthClinicalMembers,
  streamAppleHealthEcgMembers,
  streamAppleHealthRouteMembers,
  type AppleHealthArchiveMember,
} from "../archive-stream";
import { APPLE_HEALTH_CLINICAL_ARCHIVE_LIMITS } from "../clinical-labs-import";
import { APPLE_HEALTH_ECG_ARCHIVE_LIMITS } from "../ecg-import";
import { APPLE_HEALTH_ROUTE_ARCHIVE_LIMITS } from "../route-import";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function archive(files: Zippable): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-archive-limits-"));
  dirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(path, zipSync(files));
  return path;
}

const CLINICAL = "apple_health_export/clinical-records/";
const ROUTES = "apple_health_export/workout-routes/";
const ECG = "apple_health_export/electrocardiograms/";

async function read(
  members: AsyncIterable<AppleHealthArchiveMember>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const member of members) {
    try {
      let text = "";
      for await (const chunk of member.stream) text += String(chunk);
      out[member.name] = text;
    } catch {
      out[member.name] = `refused:${member.refused ?? "?"}`;
    }
  }
  return out;
}

const SMALL = {
  maxMembers: 100,
  maxMemberBytes: 1024,
  maxCompressionRatio: 20,
};

describe("members the pass does not want", () => {
  it("skips an oversized or bomb-like clinical file nobody references", async () => {
    const path = archive({
      [`${CLINICAL}Observation-a.json`]: strToU8('{"id":"a"}'),
      // Over the per-member byte limit and far over the ratio.
      [`${CLINICAL}DocumentReference-big.json`]: strToU8("x".repeat(64_000)),
    });
    const got = await read(
      streamAppleHealthClinicalMembers({
        archivePath: path,
        limits: {
          ...SMALL,
          maxClinicalMembers: 5,
          maxTotalClinicalBytes: 1024,
        },
        wanted: (name) => name.endsWith("Observation-a.json"),
      }),
    );
    expect(got).toEqual({ [`${CLINICAL}Observation-a.json`]: '{"id":"a"}' });
  });

  it("does not count unwanted files of the kind against the kind's ceiling", async () => {
    const files: Zippable = {};
    for (let i = 0; i < 12; i += 1) {
      files[`${CLINICAL}Condition-${i}.json`] = strToU8(`{"id":"c${i}"}`);
    }
    files[`${CLINICAL}Observation-a.json`] = strToU8('{"id":"a"}');
    const got = await read(
      streamAppleHealthClinicalMembers({
        archivePath: archive(files),
        limits: {
          ...SMALL,
          maxClinicalMembers: 5,
          maxTotalClinicalBytes: 1024,
        },
        wanted: (name) => name.endsWith("Observation-a.json"),
      }),
    );
    expect(Object.keys(got)).toEqual([`${CLINICAL}Observation-a.json`]);
  });

  it("skips an unwanted route that breaks a per-member limit", async () => {
    const path = archive({
      [`${ROUTES}route_a.gpx`]: strToU8("<gpx/>"),
      [`${ROUTES}route_big.gpx`]: strToU8("<gpx>".repeat(20_000)),
    });
    const got = await read(
      streamAppleHealthRouteMembers({
        archivePath: path,
        limits: { ...SMALL, maxRouteMembers: 1, maxTotalRouteBytes: 1024 },
        wanted: (name) => name.endsWith("route_a.gpx"),
      }),
    );
    expect(got).toEqual({ [`${ROUTES}route_a.gpx`]: "<gpx/>" });
  });
});

describe("a wanted member that breaks a per-member limit", () => {
  it("fails on its own; the members around it are still read", async () => {
    const path = archive({
      [`${CLINICAL}Observation-a.json`]: strToU8('{"id":"a"}'),
      [`${CLINICAL}Observation-bomb.json`]: strToU8("x".repeat(64_000)),
      [`${CLINICAL}Observation-b.json`]: strToU8('{"id":"b"}'),
    });
    const got = await read(
      streamAppleHealthClinicalMembers({
        archivePath: path,
        limits: {
          ...SMALL,
          maxClinicalMembers: 5,
          maxTotalClinicalBytes: 1024,
        },
        wanted: () => true,
      }),
    );
    expect(got).toEqual({
      [`${CLINICAL}Observation-a.json`]: '{"id":"a"}',
      [`${CLINICAL}Observation-bomb.json`]: "refused:too_large",
      [`${CLINICAL}Observation-b.json`]: '{"id":"b"}',
    });
  });

  it("is refused before its compressed bytes are read when they alone exceed the member limit", async () => {
    // Random bytes do not compress: the stored size is over the limit, so
    // the reader must not allocate it.
    const path = archive({
      [`${ECG}ecg_a.csv`]: strToU8("Name,a\n"),
      [`${ECG}ecg_noise.csv`]: [randomBytes(4096), { level: 0 }],
    });
    const got = await read(
      streamAppleHealthEcgMembers({
        archivePath: path,
        limits: {
          ...SMALL,
          maxCompressionRatio: 200,
          maxEcgMembers: 5,
          maxTotalEcgBytes: 64 * 1024,
        },
      }),
    );
    expect(got).toEqual({
      [`${ECG}ecg_a.csv`]: "Name,a\n",
      [`${ECG}ecg_noise.csv`]: "refused:too_large",
    });
  });

  it("is refused by its compressed size even when its declared size lies", async () => {
    const path = archive({
      [`${ECG}ecg_a.csv`]: strToU8("Name,a\n"),
      [`${ECG}ecg_noise.csv`]: [randomBytes(4096), { level: 0 }],
    });
    // Declare the member one byte long in the central directory: neither
    // the declared size nor the ratio then says anything is wrong.
    const bytes = readFileSync(path);
    const name = Buffer.from(`${ECG}ecg_noise.csv`);
    for (let at = 0; at + 46 < bytes.length; at += 1) {
      if (
        bytes.readUInt32LE(at) === 0x02014b50 &&
        bytes.subarray(at + 46, at + 46 + name.length).equals(name)
      ) {
        bytes.writeUInt32LE(1, at + 24);
      }
    }
    writeFileSync(path, bytes);
    const got = await read(
      streamAppleHealthEcgMembers({
        archivePath: path,
        limits: {
          ...SMALL,
          maxCompressionRatio: 200,
          maxEcgMembers: 5,
          maxTotalEcgBytes: 64 * 1024,
        },
      }),
    );
    expect(got).toEqual({
      [`${ECG}ecg_a.csv`]: "Name,a\n",
      [`${ECG}ecg_noise.csv`]: "refused:too_large",
    });
  });

  it("still ends the pass when a running total is exceeded", async () => {
    const path = archive({
      [`${ECG}ecg_a.csv`]: strToU8("a".repeat(600)),
      [`${ECG}ecg_b.csv`]: strToU8("b".repeat(600)),
    });
    const run = () =>
      read(
        streamAppleHealthEcgMembers({
          archivePath: path,
          limits: {
            ...SMALL,
            maxCompressionRatio: 200,
            maxEcgMembers: 5,
            maxTotalEcgBytes: 1000,
          },
        }),
      );
    await expect(run()).rejects.toThrow(/total ECG byte limit/);
  });
});

describe("the ceiling on directory entries", () => {
  it("is one value for the ECG, route and Health Records passes", () => {
    expect(APPLE_HEALTH_ARCHIVE_MAX_ENTRIES).toBe(200_000);
    expect(APPLE_HEALTH_ECG_ARCHIVE_LIMITS.maxMembers).toBe(
      APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
    );
    expect(APPLE_HEALTH_ROUTE_ARCHIVE_LIMITS.maxMembers).toBe(
      APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
    );
    expect(APPLE_HEALTH_CLINICAL_ARCHIVE_LIMITS.maxMembers).toBe(
      APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
    );
  });

  it("lets every pass read an export with more files than the old ECG ceiling", async () => {
    // 25,000 entries: past the 20,000 the ECG pass used to stop at, and
    // the shape a Health Records account with years of routes produces.
    const files: Zippable = {
      [`${ECG}ecg_a.csv`]: strToU8("Name,a\n"),
      [`${ROUTES}route_a.gpx`]: strToU8("<gpx/>"),
      [`${CLINICAL}Observation-a.json`]: strToU8('{"id":"a"}'),
    };
    const empty = new Uint8Array(0);
    for (let i = 0; i < 25_000; i += 1) {
      files[`${CLINICAL}Condition-${i}.json`] = empty;
    }
    const path = archive(files);

    expect(
      Object.keys(
        await read(
          streamAppleHealthEcgMembers({
            archivePath: path,
            limits: APPLE_HEALTH_ECG_ARCHIVE_LIMITS,
          }),
        ),
      ),
    ).toEqual([`${ECG}ecg_a.csv`]);
    expect(
      Object.keys(
        await read(
          streamAppleHealthRouteMembers({
            archivePath: path,
            limits: APPLE_HEALTH_ROUTE_ARCHIVE_LIMITS,
            wanted: () => true,
          }),
        ),
      ),
    ).toEqual([`${ROUTES}route_a.gpx`]);
    expect(
      Object.keys(
        await read(
          streamAppleHealthClinicalMembers({
            archivePath: path,
            limits: APPLE_HEALTH_CLINICAL_ARCHIVE_LIMITS,
            wanted: (name) => name.endsWith("Observation-a.json"),
          }),
        ),
      ),
    ).toEqual([`${CLINICAL}Observation-a.json`]);
  }, 60_000);
});
