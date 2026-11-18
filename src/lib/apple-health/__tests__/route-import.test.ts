import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { strToU8, zipSync } from "fflate";

vi.mock("@/lib/workouts/route-geometry-cipher", () => ({
  encryptRouteGeometry: (geometry: unknown) =>
    Buffer.from(JSON.stringify(geometry)),
}));

import {
  importAppleHealthWorkoutRoutes,
  parseGpxTrack,
  thinIndices,
  trackToRoute,
} from "../route-import";
import { routeMemberNameFromReference } from "../archive-stream";
import { MAX_ROUTE_POINTS } from "@/lib/validations/workout";
import type { PrismaClient } from "@/generated/prisma/client";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function archive(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-route-import-"));
  dirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(
    path,
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, body]) => [name, strToU8(body)]),
      ),
    ),
  );
  return path;
}

function gpx(points: Array<[number, number, number?, string?]>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Route</name><trkseg>
${points
  .map(
    ([lat, lon, ele, time]) =>
      `<trkpt lon="${lon}" lat="${lat}">${ele === undefined ? "" : `<ele>${ele}</ele>`}${time ? `<time>${time}</time>` : ""}</trkpt>`,
  )
  .join("\n")}
</trkseg></trk></gpx>`;
}

function fakePrisma(
  workout: {
    id: string;
    elevationM: number | null;
    route: { id: string } | null;
  } | null,
) {
  const fake = {
    workout: {
      findUnique: vi.fn(async () => workout),
      update: vi.fn(async () => ({})),
    },
    workoutRoute: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  // The importer's view of it: the two delegates it calls, nothing else.
  const client = fake as unknown as Pick<
    PrismaClient,
    "workout" | "workoutRoute"
  >;
  return { ...fake, client };
}

describe("routeMemberNameFromReference", () => {
  it("maps Apple's reference path onto the archive member", () => {
    expect(routeMemberNameFromReference("/workout-routes/route_1.gpx")).toBe(
      "apple_health_export/workout-routes/route_1.gpx",
    );
  });

  it("refuses anything that is not a direct route file", () => {
    expect(
      routeMemberNameFromReference("/workout-routes/../export.xml"),
    ).toBeNull();
    expect(
      routeMemberNameFromReference("/electrocardiograms/a.csv"),
    ).toBeNull();
    expect(routeMemberNameFromReference("/workout-routes/a/b.gpx")).toBeNull();
  });
});

describe("parseGpxTrack + trackToRoute", () => {
  it("keeps altitude and time when every point carries them", async () => {
    const track = await parseGpxTrack(
      Readable.from([
        gpx([
          [50.1, 8.1, 100, "2026-05-14T06:00:00Z"],
          [50.2, 8.2, 130, "2026-05-14T06:00:05Z"],
        ]),
      ]),
    );
    const route = trackToRoute(track);
    expect(route?.geometry.coordinates).toEqual([
      [8.1, 50.1, 100],
      [8.2, 50.2, 130],
    ]);
    expect(route?.sampleTimestamps).toEqual([
      { t: "2026-05-14T06:00:00.000Z" },
      { t: "2026-05-14T06:00:05.000Z" },
    ]);
  });

  it("drops altitude and times rather than half-filling them", async () => {
    const route = trackToRoute(
      await parseGpxTrack(
        Readable.from([
          gpx([
            [50.1, 8.1, 100, "2026-05-14T06:00:00Z"],
            [50.2, 8.2],
          ]),
        ]),
      ),
    );
    expect(route?.geometry.coordinates).toEqual([
      [8.1, 50.1],
      [8.2, 50.2],
    ]);
    expect(route?.sampleTimestamps).toBeNull();
  });

  it("skips out-of-range points and refuses a track shorter than two", async () => {
    const track = await parseGpxTrack(
      Readable.from([
        gpx([
          [95, 8.1],
          [50.2, 8.2],
        ]),
      ]),
    );
    expect(track.lat).toEqual([50.2]);
    expect(trackToRoute(track)).toBeNull();
  });

  it("rejects malformed XML", async () => {
    await expect(
      parseGpxTrack(Readable.from(["<gpx><trk><trkpt lat="])),
    ).rejects.toThrow();
  });

  it("thins evenly to the point cap and keeps both ends", () => {
    const idx = thinIndices(MAX_ROUTE_POINTS * 3 + 7, MAX_ROUTE_POINTS);
    expect(idx).toHaveLength(MAX_ROUTE_POINTS);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(MAX_ROUTE_POINTS * 3 + 6);
    expect(thinIndices(5, MAX_ROUTE_POINTS)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("importAppleHealthWorkoutRoutes", () => {
  const files = {
    "apple_health_export/export.xml": "<HealthData/>",
    "apple_health_export/workout-routes/route_1.gpx": gpx([
      [50.1, 8.1, 100],
      [50.2, 8.2, 140],
      [50.3, 8.3, 120],
    ]),
    "apple_health_export/workout-routes/route_2.gpx": gpx([[50.1, 8.1]]),
  };

  it("attaches a referenced track sealed and fills the climb", async () => {
    const prisma = fakePrisma({ id: "w1", elevationM: null, route: null });
    const counts = await importAppleHealthWorkoutRoutes({
      archivePath: archive(files),
      userId: "u1",
      references: [
        { externalId: "ext-1", path: "/workout-routes/route_1.gpx" },
      ],
      prisma: prisma.client,
    });
    expect(counts).toEqual({
      discovered: 1,
      attached: 1,
      skipped: 0,
      failed: 0,
    });
    const data = (
      prisma.workoutRoute.createMany.mock.calls[0] as unknown as [
        { data: Array<{ workoutId: string; geometryEncrypted: Buffer }> },
      ]
    )[0].data[0];
    expect(data.workoutId).toBe("w1");
    expect(JSON.parse(data.geometryEncrypted.toString())).toMatchObject({
      type: "LineString",
    });
    expect(prisma.workout.update).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { elevationM: 40 },
    });
  });

  it("reads only referenced members, and leaves a stored track alone", async () => {
    const prisma = fakePrisma({ id: "w1", elevationM: 12, route: { id: "r" } });
    const counts = await importAppleHealthWorkoutRoutes({
      archivePath: archive(files),
      userId: "u1",
      references: [
        { externalId: "ext-1", path: "/workout-routes/route_1.gpx" },
      ],
      prisma: prisma.client,
    });
    expect(counts).toEqual({
      discovered: 1,
      attached: 0,
      skipped: 1,
      failed: 0,
    });
    expect(prisma.workoutRoute.createMany).not.toHaveBeenCalled();
  });

  it("counts a too-short track as failed", async () => {
    const prisma = fakePrisma({ id: "w2", elevationM: null, route: null });
    const counts = await importAppleHealthWorkoutRoutes({
      archivePath: archive(files),
      userId: "u1",
      references: [
        { externalId: "ext-2", path: "/workout-routes/route_2.gpx" },
      ],
      prisma: prisma.client,
    });
    expect(counts.failed).toBe(1);
    expect(prisma.workoutRoute.createMany).not.toHaveBeenCalled();
  });

  it("counts references the job did not keep as failed", async () => {
    const prisma = fakePrisma({ id: "w1", elevationM: null, route: null });
    const counts = await importAppleHealthWorkoutRoutes({
      archivePath: archive(files),
      userId: "u1",
      references: [
        { externalId: "ext-1", path: "/workout-routes/route_1.gpx" },
      ],
      overflow: 3,
      prisma: prisma.client,
    });
    expect(counts.attached).toBe(1);
    expect(counts.failed).toBe(3);
  });

  it("fails soft on a member over the byte cap", async () => {
    const prisma = fakePrisma({ id: "w1", elevationM: null, route: null });
    const counts = await importAppleHealthWorkoutRoutes({
      archivePath: archive(files),
      userId: "u1",
      references: [
        { externalId: "ext-1", path: "/workout-routes/route_1.gpx" },
      ],
      prisma: prisma.client,
      limits: {
        maxMembers: 100,
        maxRouteMembers: 10,
        maxMemberBytes: 64,
        maxTotalRouteBytes: 1024,
        maxCompressionRatio: 200,
      },
    });
    expect(counts.attached).toBe(0);
    expect(counts.failed).toBe(1);
  });
});
